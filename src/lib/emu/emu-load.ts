import type { Emulator } from './emulator';
import type { PEInfo } from '../pe/types';
import { loadPE } from './pe-loader';
import { loadNE } from './ne-loader';
import type { LoadedNE } from './ne-loader';
import { setAnsiCodePage, setAnsiCodePageFromCP, setAnsiEncoding, guessEncodingFromBytes } from './memory';
import { registerGdi32 } from './win32/gdi32/index';
import { registerKernel32 } from './win32/kernel32/index';
import { registerUser32 } from './win32/user32/index';
import { registerMsvcrt } from './win32/msvcrt';
import { registerAdvapi32 } from './win32/advapi32';
import { registerComctl32 } from './win32/comctl32';
import { registerWinmm } from './win32/winmm';
import { registerShell32 } from './win32/shell32';
import { registerOleaut32 } from './win32/oleaut32';
import { registerComdlg32 } from './win32/comdlg32';
import { registerOle32 } from './win32/ole32';
import { registerMsacm32 } from './win32/msacm32';
import { registerVersion } from './win32/version';
import { registerWinspool } from './win32/winspool';
import { registerOpengl32 } from './win32/opengl32';
import { registerGlu32 } from './win32/glu32';
import { registerWs2_32 } from './win32/ws2_32';
import { registerDdraw } from './win32/ddraw';
import { registerDsound } from './win32/dsound';
import { registerShlwapi } from './win32/shlwapi';
import { registerPsapi } from './win32/psapi';
import { registerIphlpapi } from './win32/iphlpapi';
import { registerSecur32 } from './win32/secur32';
import { registerSetupapi } from './win32/setupapi';
import { registerMpr } from './win32/mpr';
import { registerImm32 } from './win32/imm32';
import { registerNtdll } from './win32/ntdll';
import { registerMsimg32 } from './win32/msimg32';
import { registerVdmdbg } from './win32/vdmdbg';
import { registerNetapi32 } from './win32/netapi32';
import { registerWin16Kernel, registerWin16User, registerWin16Gdi, registerWin16Shell, registerWin16Ddeml, registerWin16Mmsystem, registerWin16Commdlg, registerWin16Keyboard, registerWin16Win87em, registerWin16Sound, registerWin16Ver, registerWin16Commctrl, registerWin16Sconfig, registerWin16Lzexpand } from './win16/index';
import { setupXmsStub } from './dos/xms';
import { buildThunkTable, preloadStrings, verifyIAT, initTEB, initThreadTEB } from './emu-thunks-pe';
import { Thread } from './thread';
import { parsePE, extractExports, extractMenus } from '../pe';
import type { ExportFunction } from '../pe';
import { buildNEThunkTable } from './emu-thunks-ne';
import { handleSehDispatchReturn } from './emu-window';
import { loadMZ, loadCOM } from './mz-loader';

export function emuLoad(emu: Emulator, arrayBuffer: ArrayBuffer, peInfo: PEInfo, canvas: HTMLCanvasElement): void {
  console.log('[EMU] load() called, arrayBuffer size:', arrayBuffer.byteLength);
  emu.arrayBuffer = arrayBuffer;
  emu.peInfo = peInfo;
  emu.canvas = canvas;

  // Ensure exePath is set (may already be set by ProcessRegistry.register)
  if (!emu.exePath) {
    const name = emu.exeName.replaceAll('/', '\\');
    if (name.includes('\\')) {
      // Name already has path — ensure drive letter prefix
      emu.exePath = /^[A-Za-z]:/.test(name) ? name : 'D:\\' + name;
    } else {
      const cwd = emu.currentDirs.get('D') || 'D:\\';
      emu.exePath = cwd.endsWith('\\') ? cwd + name : cwd + '\\' + name;
    }
  }

  // Set current directory for the exe's drive to its parent folder
  const lastBackslash = emu.exePath.lastIndexOf('\\');
  if (lastBackslash >= 2 && emu.exePath[1] === ':') {
    const drive = emu.exePath[0].toUpperCase();
    let dir = emu.exePath.substring(0, lastBackslash);
    // Preserve trailing backslash for root directory (e.g. D:\CMD.EXE → D:\, not D:)
    if (dir.length === 2 && dir[1] === ':') dir += '\\';
    emu.currentDirs.set(drive, dir);
  }

  // Detect ANSI code page from resources.
  // Prefer the explicit codePage field from resource data entries;
  // fall back to guessing from the language ID.
  if (peInfo.resources) {
    let detected = false;
    for (const res of peInfo.resources) {
      for (const entry of res.entries) {
        for (const lang of entry.languages) {
          if (lang.codePage && lang.codePage !== 0 && lang.codePage !== 1252) {
            setAnsiCodePageFromCP(lang.codePage);
            detected = true;
            break;
          }
        }
        if (detected) break;
      }
      if (detected) break;
    }
    if (!detected) {
      for (const res of peInfo.resources) {
        for (const entry of res.entries) {
          for (const lang of entry.languages) {
            if (lang.languageId) {
              setAnsiCodePage(lang.languageId);
              detected = true;
              break;
            }
          }
          if (detected) break;
        }
        if (detected) break;
      }
    }
    // Last resort: scan PE data sections for CJK byte patterns
    if (!detected && peInfo.sections) {
      const data = new Uint8Array(arrayBuffer);
      for (const sec of peInfo.sections) {
        if (sec.pointerToRawData && sec.sizeOfRawData > 0) {
          const slice = data.subarray(sec.pointerToRawData, sec.pointerToRawData + Math.min(sec.sizeOfRawData, 0x10000));
          const enc = guessEncodingFromBytes(slice);
          if (enc) {
            setAnsiEncoding(enc);
            detected = true;
            break;
          }
        }
      }
    }
  }
  emu.cpu.emu = emu;
  emu.canvasCtx = canvas.getContext('2d')!;
  emu.canvasCtx.imageSmoothingEnabled = false;

  // COM (DOS) executable branch
  if (peInfo.isCOM) {
    emu.isDOS = true;
    emu.isConsole = true;
    emu.initConsoleBuffer();

    const mz = loadCOM(arrayBuffer, emu.memory, emu.exePath);
    setupDosEnvironment(emu, mz);
    console.log(`[EMU] COM loaded: entry CS:IP=${mz.entryCS.toString(16)}:${mz.entryIP.toString(16)} SS:SP=${mz.entrySS.toString(16)}:${mz.entrySP.toString(16)} imageSize=${mz.imageSize}`);
    return;
  }

  // MZ (DOS) executable branch
  if (peInfo.isMZ && peInfo.mzHeader) {
    emu.isDOS = true;
    emu.isConsole = true;
    emu.initConsoleBuffer();

    const mz = loadMZ(arrayBuffer, emu.memory, peInfo.mzHeader, emu.exePath);
    setupDosEnvironment(emu, mz);
    console.log(`[EMU] MZ loaded: entry CS:IP=${mz.entryCS.toString(16)}:${mz.entryIP.toString(16)} SS:SP=${mz.entrySS.toString(16)}:${mz.entrySP.toString(16)} imageSize=${mz.imageSize}`);
    return;
  }

  // NE (16-bit) executable branch
  if (peInfo.isNE) {
    emu.isNE = true;
    emu.ne = loadNE(arrayBuffer, emu.memory);

    // Set up CPU for 16-bit mode
    emu.cpu.use32 = false;
    emu.cpu.segBases = emu.ne.selectorToBase;
    emu.cpu.cs = emu.ne.codeSegSelector;
    emu.cpu.ds = emu.ne.dataSegSelector;
    emu.cpu.es = emu.ne.dataSegSelector;
    emu.cpu.ss = emu.ne.stackSegSelector;
    emu.cpu.eip = emu.ne.entryPoint;
    emu.cpu.reg[4] = emu.ne.stackTop; // ESP = SS:SP linear address

    // NE local heap: within auto-data segment, after static data
    // Ensure local heap never starts at offset 0 (offset 0 is treated as NULL)
    const dsBase = emu.ne.selectorToBase.get(emu.ne.dataSegSelector) || 0;
    const localStart = Math.max(emu.ne.autoDataStaticSize, 4); // min offset 4 (offset 0 = NULL)
    emu.localHeapBase = dsBase + localStart;
    emu.localHeapPtr = emu.localHeapBase;
    // Expand heap to fill gap between static data and stack, if SS == DS.
    // Layout in segment: [static data | heap → ... ← stack]
    const ssBase = emu.ne.selectorToBase.get(emu.ne.stackSegSelector) || 0;
    let heapMax = Math.max(emu.ne.heapSize, 8192);
    if (ssBase === dsBase && emu.ne.stackSize > 0) {
      // Stack bottom offset = stackTop - stackSize (relative to dsBase)
      const stackBottomOff = (emu.ne.stackTop - dsBase) - emu.ne.stackSize;
      const safeHeap = stackBottomOff - localStart - 256; // 256-byte guard
      if (safeHeap > heapMax) heapMax = safeHeap;
    }
    emu.localHeapEnd = emu.localHeapBase + heapMax;

    // Load NE DLLs referenced by the main exe (before setting heap base)
    const neDllEntries = loadNEDlls(emu);

    // Global heap/virtual allocator after all NE segments (exe + DLLs)
    // nextSelector * 0x10000 is the next linear address after all segments
    const heapStart = (emu.ne.nextSelector + 1) * 0x10000;
    emu.heapBase = heapStart;
    emu.heapPtr = emu.heapBase;
    emu.virtualBase = heapStart + 0x01000000;
    emu.virtualPtr = emu.virtualBase;

    // Map heap segment so x86 code can access heap data via FAR pointers
    // (e.g., LockResource returns linear addr that x86 code uses as seg:off)
    const heapSel = heapStart >>> 16;
    emu.cpu.segBases.set(heapSel, heapStart);

    // Register Win16 API handlers
    registerWin16Kernel(emu);
    registerWin16User(emu);
    registerWin16Gdi(emu);
    registerWin16Shell(emu);
    registerWin16Ddeml(emu);
    registerWin16Mmsystem(emu);
    registerWin16Sound(emu);
    registerWin16Commdlg(emu);
    registerWin16Keyboard(emu);
    registerWin16Win87em(emu);
    registerWin16Ver(emu);
    registerWin16Commctrl(emu);
    registerWin16Sconfig(emu);
    registerWin16Lzexpand(emu);

    // Build thunk table for NE (includes thunks from loaded DLLs)
    buildNEThunkTable(emu);

    // Set up HALT thunk — push as far return address
    const HALT_ADDR = 0x000F_FF00;
    const HALT_SELECTOR = 0xFE;
    emu.thunkToApi.set(HALT_ADDR, { dll: 'SYSTEM', name: 'HALT', stackBytes: 0 });
    emu.apiDefs.set('SYSTEM:HALT', { handler: () => { emu.exitedNormally = true; emu.halted = true; return 0; }, stackBytes: 0 });

    // Set up WNDPROC_RETURN thunk for 16-bit
    const WNDPROC_RETURN_16 = 0x000F_FF04;
    emu.thunkToApi.set(WNDPROC_RETURN_16, { dll: 'SYSTEM', name: 'WNDPROC_RETURN', stackBytes: 0 });
    emu.apiDefs.set('SYSTEM:WNDPROC_RETURN', { handler: () => {
      emu.wndProcResult = emu.cpu.reg[0]; // AX
      emu.wndProcDepth--;
      return emu.wndProcResult;
    }, stackBytes: 0 });

    // Push halt address as FAR return from WinMain
    emu.cpu.push16(HALT_SELECTOR);
    emu.cpu.push16(HALT_ADDR - (emu.ne.selectorToBase.get(HALT_SELECTOR) ?? 0));

    rebuildThunkPages(emu);

    // Pre-load menu items from NE resources so GetMenuState works during init
    if (!emu.menuItems) {
      const menus = extractMenus(peInfo, arrayBuffer);
      if (menus.length > 0) {
        emu.menuItems = menus[0].menu.items;
      }
    }

    // Create main thread BEFORE DLL init so thread-delegated getters/setters
    // (wndProcResult, wndProcDepth, etc.) work during callWndProc16
    const mainThread = new Thread(emu.nextThreadId++, Thread.createInitialState(emu.cpu));
    emu.threads.push(mainThread);
    emu.currentThread = mainThread;

    // Call NE DLL entry points (LibEntry → LibMain) to initialize DLLs
    // The standard LIBENTRY stub expects: CX=heapSize, DI=hInstance(=dataSegSelector),
    // DS=autoDataSeg, ES:SI=cmdLine. It calls LocalInit then LibMain.
    for (const dllEntry of neDllEntries) {
      console.log(`[NE DLL] Calling entry point for ${dllEntry.name} at 0x${dllEntry.entryPoint.toString(16)}`);
      const savedEIP = emu.cpu.eip;
      const savedCS = emu.cpu.cs;
      const savedDS = emu.cpu.ds;
      const savedES = emu.cpu.es;
      const savedECX = emu.cpu.reg[1];
      const savedEDI = emu.cpu.reg[7];
      const savedESI = emu.cpu.reg[6];

      // Set up registers expected by LIBENTRY
      emu.cpu.ds = dllEntry.dataSegSelector;
      emu.cpu.es = emu.ne.dataSegSelector; // ES:SI = command line (just point somewhere safe)
      emu.cpu.reg[1] = (emu.cpu.reg[1] & 0xFFFF0000) | (dllEntry.heapSize & 0xFFFF); // CX = heapSize
      emu.cpu.reg[7] = (emu.cpu.reg[7] & 0xFFFF0000) | (dllEntry.dataSegSelector & 0xFFFF); // DI = hInstance
      emu.cpu.reg[6] = (emu.cpu.reg[6] & 0xFFFF0000) | 0; // SI = 0 (cmdline offset)

      // Temporarily override DS restoration in callWndProc16
      const origDataSel = emu.ne.dataSegSelector;
      emu.ne.dataSegSelector = dllEntry.dataSegSelector;
      const result = emu.callWndProc16(dllEntry.entryPoint, 0, 0, 0, 0);
      emu.ne.dataSegSelector = origDataSel;
      console.log(`[NE DLL] ${dllEntry.name} entry returned ${result}`);

      // Restore all CPU state
      emu.cpu.eip = savedEIP;
      emu.cpu.cs = savedCS;
      emu.cpu.ds = savedDS;
      emu.cpu.es = savedES;
      emu.cpu.reg[1] = savedECX;
      emu.cpu.reg[7] = savedEDI;
      emu.cpu.reg[6] = savedESI;
    }

    // NE (Win16) programs expect C: as the current drive
    emu.currentDrive = 'C';
    emu.currentDirs.set('C', 'C:\\');

    // Allocate a default DTA for NE apps using DOS3Call (FindFirst/FindNext)
    // The DTA is 43 bytes; place it in the heap area
    const dtaAddr = emu.allocHeap(128);
    emu._dosDTA = dtaAddr;

    console.log(`[EMU] NE loaded: entry=0x${emu.ne.entryPoint.toString(16)} CS=${emu.ne.codeSegSelector} SS=${emu.ne.stackSegSelector} DS=${emu.ne.dataSegSelector} heapBase=0x${emu.heapBase.toString(16)}`);
    return;
  }

  // Detect console subsystem
  const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;
  if (peInfo.optionalHeader.subsystem === IMAGE_SUBSYSTEM_WINDOWS_CUI) {
    emu.isConsole = true;
    emu.initConsoleBuffer();
  }

  // Load PE into memory
  emu.pe = loadPE(arrayBuffer, emu.memory);
  console.log(`[EMU] PE loaded: imageBase=0x${emu.pe.imageBase.toString(16)} entry=0x${emu.pe.entryPoint.toString(16)} thunkBase=0x${emu.pe.thunkBase.toString(16)} sizeOfImage=0x${emu.pe.sizeOfImage.toString(16)} apis=${emu.pe.apiMap.size}`);
  console.log(`[EMU] PE image range: 0x${emu.pe.imageBase.toString(16)} - 0x${(emu.pe.imageBase + emu.pe.sizeOfImage).toString(16)}`);

  // Initialize heap after all PE sections
  emu.heapBase = ((emu.pe.stackTop + 0x10000 + 0xFFFF) & ~0xFFFF) >>> 0;
  emu.heapPtr = emu.heapBase;
  // Virtual memory allocator uses a separate high region, page-aligned
  emu.virtualBase = ((emu.heapBase + 0x1000000 + 0xFFF) & ~0xFFF) >>> 0; // 16MB above heap
  emu.virtualPtr = emu.virtualBase;
  console.log(`[EMU] stack top: 0x${emu.pe.stackTop.toString(16)}, heap base: 0x${emu.heapBase.toString(16)}, virtual base: 0x${emu.virtualBase.toString(16)}`);

  // Allocate and initialize TEB (Thread Environment Block) for FS segment
  initTEB(emu);

  // Initialize dynamic thunk allocator after main PE thunks
  emu.dynamicThunkPtr = ((emu.pe.thunkBase + emu.pe.apiMap.size * 4 + 0xFFF) & ~0xFFF) >>> 0;

  // Register API handlers
  registerKernel32(emu);
  registerUser32(emu);
  registerGdi32(emu);
  registerMsvcrt(emu);
  registerAdvapi32(emu);
  registerComctl32(emu);
  registerWinmm(emu);
  registerShell32(emu);
  registerOleaut32(emu);
  registerComdlg32(emu);
  registerOle32(emu);
  registerMsacm32(emu);
  registerVersion(emu);
  registerWinspool(emu);
  registerOpengl32(emu);
  registerGlu32(emu);
  registerWs2_32(emu);
  registerDdraw(emu);
  registerDsound(emu);
  registerShlwapi(emu);
  registerPsapi(emu);
  registerIphlpapi(emu);
  registerSecur32(emu);
  registerSetupapi(emu);
  registerMpr(emu);

  registerMsimg32(emu);
  registerImm32(emu);
  registerNtdll(emu);
  registerNetapi32(emu);
  registerVdmdbg(emu);

  // Build thunk dispatch table with argument count detection
  buildThunkTable(emu);

  // Pre-load DLLs from additionalFiles that are referenced in the import table.
  // This patches IAT thunks to point to real DLL code instead of JS stubs.
  // Handles transitive dependencies (DLL A imports DLL B which imports DLL C).
  const dllEntryPoints: { entryPoint: number; imageBase: number }[] = [];
  if (emu.additionalFiles.size > 0) {
    // Collect DLL names referenced in imports — use a queue for transitive deps
    const dllQueue: string[] = [];
    const processedDlls = new Set<string>();

    // Seed with main exe's imports
    for (const info of emu.pe.apiMap.values()) {
      const lower = info.dll.toLowerCase();
      if (!processedDlls.has(lower)) { processedDlls.add(lower); dllQueue.push(info.dll); }
    }

    // Track loaded DLL PE info for IAT patching across all loaded modules
    const loadedDllPes: { dllName: string; pe: typeof emu.pe; exportByName: Map<string, number>; exportByOrd: Map<number, number> }[] = [];

    while (dllQueue.length > 0) {
      const dllName = dllQueue.shift()!;

      // Find matching file in additionalFiles
      let ab: ArrayBuffer | undefined;
      const dllLower = dllName.toLowerCase();
      for (const [fname, data] of emu.additionalFiles) {
        if (fname.toLowerCase() === dllLower) { ab = data; break; }
      }
      if (!ab) continue;
      if (emu.loadedModules.has(dllLower)) continue;

      try {
        const dllPe = loadPE(ab, emu.memory);
        const dllPeInfo = parsePE(ab);
        const exportResult = extractExports(dllPeInfo, ab);
        const exportFuncs = exportResult?.functions ?? [];

        // Build thunks for the DLL's own imports
        const savedPe = emu.pe;
        emu.pe = dllPe;
        buildThunkTable(emu);
        emu.pe = savedPe;

        // Enqueue any new DLLs imported by this DLL
        for (const info of dllPe.apiMap.values()) {
          const subLower = info.dll.toLowerCase();
          if (!processedDlls.has(subLower)) { processedDlls.add(subLower); dllQueue.push(info.dll); }
        }

        // Build export lookup: name/ordinal → real code address
        const exportByName = new Map<string, number>();
        const exportByOrd = new Map<number, number>();
        for (const fn of exportFuncs) {
          if (fn.name) exportByName.set(fn.name, dllPe.imageBase + fn.rva);
          exportByOrd.set(fn.ordinal, dllPe.imageBase + fn.rva);
        }
        loadedDllPes.push({ dllName, pe: dllPe, exportByName, exportByOrd });

        // Store as loaded module
        emu.loadedModules.set(dllLower, { base: dllPe.imageBase, resourceRva: dllPe.resourceRva, imageBase: dllPe.imageBase, sizeOfImage: dllPe.sizeOfImage });
        // Remember entry point for DllMain call
        if (dllPe.entryPoint !== dllPe.imageBase) {
          dllEntryPoints.push({ entryPoint: dllPe.entryPoint, imageBase: dllPe.imageBase });
        }
        console.log(`[DLL] Pre-loaded ${dllName} at 0x${dllPe.imageBase.toString(16)}, ${exportFuncs.length} exports`);
      } catch (e: unknown) {
        console.warn(`[DLL] Failed to pre-load ${dllName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Patch thunks: resolve imports to real DLL code across all loaded modules.
    // Build reverse index: thunkAddr → list of memory locations containing that value.
    const imageRanges: { base: number; end: number }[] = [
      { base: emu.pe.imageBase, end: emu.pe.imageBase + Math.min(emu.pe.sizeOfImage, 0x100000) },
    ];
    for (const d of loadedDllPes) {
      imageRanges.push({ base: d.pe.imageBase, end: d.pe.imageBase + Math.min(d.pe.sizeOfImage, 0x100000) });
    }

    // Collect all thunk addresses we need to resolve
    const thunkAddrs = new Set<number>();
    for (const [thunkAddr] of emu.thunkToApi) thunkAddrs.add(thunkAddr);

    // Single scan: build map from thunkAddr → memory locations that reference it
    const thunkLocations = new Map<number, number[]>();
    for (const range of imageRanges) {
      for (let addr = range.base; addr < range.end; addr += 4) {
        const val = emu.memory.readU32(addr);
        if (thunkAddrs.has(val)) {
          let locs = thunkLocations.get(val);
          if (!locs) { locs = []; thunkLocations.set(val, locs); }
          locs.push(addr);
        }
      }
    }

    // Now resolve and patch using the pre-built index
    for (const dll of loadedDllPes) {
      for (const [thunkAddr, info] of emu.thunkToApi) {
        if (info.dll !== dll.dllName) continue;

        let realAddr = dll.exportByName.get(info.name);
        if (!realAddr) {
          const ordMatch = info.name.match(/^ord_(\d+)$/);
          if (ordMatch) realAddr = dll.exportByOrd.get(parseInt(ordMatch[1]));
        }
        if (realAddr) {
          const locs = thunkLocations.get(thunkAddr);
          if (locs) {
            for (const loc of locs) emu.memory.writeU32(loc, realAddr);
          }
          emu.thunkToApi.delete(thunkAddr);
          console.log(`[DLL] Resolved ${dll.dllName}:${info.name} → 0x${realAddr.toString(16)}`);
        }
      }
    }
  }

  // Set up CPU
  emu.cpu.eip = emu.pe.entryPoint;
  emu.cpu.reg[4] = emu.pe.stackTop; // ESP

  // Push a sentinel return address (will cause halt when main returns)
  const HALT_ADDR = 0x00FD0000;
  emu.cpu.push32(HALT_ADDR);
  emu.thunkToApi.set(HALT_ADDR, { dll: 'SYSTEM', name: 'HALT', stackBytes: 0 });
  emu.apiDefs.set('SYSTEM:HALT', { handler: () => {
    console.log(`[HALT] Program halting normally. ESP=0x${(emu.cpu.reg[4] >>> 0).toString(16)}`);
    const sp = emu.cpu.reg[4] >>> 0;
    for (let i = 0; i < 16; i++) {
      const addr = emu.memory.readU32(sp + i * 4);
      console.log(`  [ESP+${i*4}] = 0x${(addr >>> 0).toString(16)}`);
    }
    emu.exitedNormally = true; emu.halted = true; return 0;
  }, stackBytes: 0 });

  // Set up WndProc return thunk
  const WNDPROC_RETURN_THUNK = 0x00FE0000;
  emu.thunkToApi.set(WNDPROC_RETURN_THUNK, { dll: 'SYSTEM', name: 'WNDPROC_RETURN', stackBytes: 0 });
  emu.apiDefs.set('SYSTEM:WNDPROC_RETURN', { handler: () => {
    emu.wndProcResult = emu.cpu.reg[0]; // EAX
    emu.wndProcDepth--;
    return emu.wndProcResult;
  }, stackBytes: 0 });

  // Set up SEH dispatch return thunk (for exception handler returns)
  const SEH_DISPATCH_RETURN_THUNK = 0x00FE0004;
  emu.thunkToApi.set(SEH_DISPATCH_RETURN_THUNK, { dll: 'SYSTEM', name: 'SEH_DISPATCH_RETURN', stackBytes: 0 });
  emu.apiDefs.set('SYSTEM:SEH_DISPATCH_RETURN', { handler: () => {
    return handleSehDispatchReturn(emu);
  }, stackBytes: 0 });

  // Create main thread (Thread 0) from current CPU state
  const mainThread = new Thread(emu.nextThreadId++, Thread.createInitialState(emu.cpu));
  mainThread.stackTop = emu.pe.stackTop;
  emu.threads.push(mainThread);
  emu.currentThread = mainThread;

  // Build thunk page set for fast EIP lookup in hot loop
  rebuildThunkPages(emu);

  // Pre-extract string resources
  preloadStrings(emu);

  // Verify all IAT entries were resolved
  verifyIAT(emu);

  // Fix data imports: some MSVCRT symbols are data, not functions
  for (const [addr, info] of emu.pe.apiMap) {
    if (info.name === '_acmdln') {
      const emptyStr = emu.allocHeap(4);
      emu.memory.writeU8(emptyStr, 0);
      emu.memory.writeU32(addr, emptyStr);
    } else if (info.name === '_wcmdln') {
      // _wcmdln is a data import: pointer to wide command line string
      const cmdLine = emu.commandLine || emu.exeName;
      const wstr = emu.allocHeap((cmdLine.length + 1) * 2);
      emu.memory.writeUTF16String(wstr, cmdLine);
      emu.memory.writeU32(addr, wstr);
    } else if (info.name === '_adjust_fdiv') {
      emu.memory.writeU32(addr, 0);
    }
  }

  // Call DllMain for pre-loaded DLLs (DLL_PROCESS_ATTACH)
  // DllMain(hinstDLL, fdwReason=DLL_PROCESS_ATTACH, lpReserved=0) is stdcall(3)
  // We use callWndProc which pushes 4 args: hwnd=hinstDLL, message=1, wParam=0, lParam=0
  // DllMain only reads the first 3, and since it's stdcall(3) it pops 12 bytes on return.
  // callWndProc pushed 16 bytes of args, so we need to fix up ESP after.
  for (const { entryPoint, imageBase } of dllEntryPoints) {
    console.log(`[DLL] Calling DllMain at 0x${entryPoint.toString(16)} for module 0x${imageBase.toString(16)}`);
    const savedESP = emu.cpu.reg[4];
    const savedEIP = emu.cpu.eip;
    const result = emu.callWndProc(entryPoint, imageBase, 1, 0, 0);
    emu.cpu.reg[4] = savedESP;
    emu.cpu.eip = savedEIP;
    console.log(`[DLL] DllMain returned EAX=0x${result.toString(16)}`);
  }

  // CPL applet support: if this is a .cpl file (DLL), call DllMain then bootstrap CPlApplet
  if (emu.exeName.toLowerCase().endsWith('.cpl') && (peInfo.coffHeader.characteristics & 0x2000)) {
    const cplAppletAddr = findCPlAppletExport(emu, arrayBuffer);
    if (cplAppletAddr) {
      console.log(`[CPL] Found CPlApplet at 0x${cplAppletAddr.toString(16)}`);

      // Call DllMain(hModule, DLL_PROCESS_ATTACH, 0)
      if (emu.pe.entryPoint !== emu.pe.imageBase) {
        console.log(`[CPL] Calling DllMain at 0x${emu.pe.entryPoint.toString(16)}`);
        const savedESP = emu.cpu.reg[4];
        const savedEIP = emu.cpu.eip;
        emu.callWndProc(emu.pe.entryPoint, emu.pe.imageBase, 1, 0, 0);
        emu.cpu.reg[4] = savedESP;
        emu.cpu.eip = savedEIP;
      }

      // Call CPlApplet(0, CPL_INIT=1, 0, 0)
      {
        const savedESP = emu.cpu.reg[4];
        const savedEIP = emu.cpu.eip;
        const initResult = emu.callWndProc(cplAppletAddr, 0, 1, 0, 0);
        emu.cpu.reg[4] = savedESP;
        emu.cpu.eip = savedEIP;
        console.log(`[CPL] CPlApplet(CPL_INIT) returned ${initResult}`);
      }

      // Set up EIP to call CPlApplet(0, CPL_DBLCLK=5, 0, 0) which opens the applet dialog
      // Write a small code stub: push 4 args, call CPlApplet, then ret to HALT_ADDR
      const CPL_DBLCLK = 5;
      const stubAddr = emu.allocHeap(32);
      let off = 0;
      // push 0 (lParam2)
      emu.memory.writeU8(stubAddr + off, 0x6A); off++;
      emu.memory.writeU8(stubAddr + off, 0x00); off++;
      // push 0 (lParam1)
      emu.memory.writeU8(stubAddr + off, 0x6A); off++;
      emu.memory.writeU8(stubAddr + off, 0x00); off++;
      // push CPL_DBLCLK (uMsg)
      emu.memory.writeU8(stubAddr + off, 0x6A); off++;
      emu.memory.writeU8(stubAddr + off, CPL_DBLCLK); off++;
      // push 0 (hwndCPl)
      emu.memory.writeU8(stubAddr + off, 0x6A); off++;
      emu.memory.writeU8(stubAddr + off, 0x00); off++;
      // call CPlApplet (relative)
      emu.memory.writeU8(stubAddr + off, 0xE8); off++;
      const relAddr = cplAppletAddr - (stubAddr + off + 4);
      emu.memory.writeU32(stubAddr + off, relAddr >>> 0); off += 4;
      // ret (will return to HALT_ADDR on stack)
      emu.memory.writeU8(stubAddr + off, 0xC3); off++;

      emu.cpu.eip = stubAddr;
      console.log(`[CPL] Bootstrap stub at 0x${stubAddr.toString(16)}, will call CPlApplet(0, CPL_DBLCLK, 0, 0)`);
    } else {
      console.warn('[CPL] CPlApplet export not found');
    }
  }
}

function findCPlAppletExport(emu: Emulator, arrayBuffer: ArrayBuffer): number | null {
  try {
    const peInfo = parsePE(arrayBuffer);
    const exportResult = extractExports(peInfo, arrayBuffer);
    if (!exportResult) return null;
    for (const fn of exportResult.functions) {
      if (fn.name === 'CPlApplet') {
        return emu.pe.imageBase + fn.rva;
      }
    }
  } catch {}
  return null;
}

interface NEDllEntry {
  name: string;
  entryPoint: number;
  dataSegSelector: number;
  codeSegSelector: number;
  heapSize: number;
}

/** Load NE DLLs referenced by the main NE exe. Returns DLL entry points to call. */
function loadNEDlls(emu: Emulator): NEDllEntry[] {
  if (!emu.ne) return [];

  const ne = emu.ne;
  let nextSelector = ne.nextSelector;
  let thunkAddr = ne.thunkAddrEnd;
  const dllEntries: NEDllEntry[] = [];

  // Built-in modules handled by JS stubs — don't try to load these as DLLs
  const builtinModules = new Set([
    'KERNEL', 'USER', 'GDI', 'KEYBOARD', 'WIN87EM',
    'SHELL', 'COMMDLG', 'DDEML', 'MMSYSTEM', 'LZEXPAND',
    'SOUND',
  ]);

  // Store loaded DLL info for resolving imports
  const loadedDlls = new Map<string, LoadedNE>();

  for (const modName of ne.moduleNames) {
    if (builtinModules.has(modName)) continue;

    // Look for the DLL in additionalFiles (case-insensitive, try common extensions)
    // File keys may have path prefixes (e.g. "examples/CODEBRAK/VBRUN300.DLL")
    let dllBuf: ArrayBuffer | undefined;
    const modLower = modName.toLowerCase();
    for (const ext of ['.dll', '.vbx', '.drv']) {
      const target = modLower + ext;
      for (const [key, data] of emu.additionalFiles) {
        // Match by filename (ignoring path prefix), case-insensitive
        const basename = key.replace(/.*[/\\]/, '').toLowerCase();
        if (basename === target) {
          dllBuf = data;
          break;
        }
      }
      if (dllBuf) break;
    }
    if (!dllBuf) {
      console.warn(`[NE DLL] Module ${modName} not found in additionalFiles`);
      continue;
    }

    console.log(`[NE DLL] Loading ${modName} at selectorBase=${nextSelector}, thunkAddr=0x${thunkAddr.toString(16)}`);

    const dll = loadNE(dllBuf, emu.memory, {
      selectorBase: nextSelector,
      thunkStartAddr: thunkAddr,
      selectorToBase: ne.selectorToBase,  // share the selector map
    });

    loadedDlls.set(modName, dll);
    nextSelector = dll.nextSelector;
    thunkAddr = dll.thunkAddrEnd;

    // Store DLL resources for cross-module resource loading (LoadBitmap etc.)
    if (dll.resources.length > 0) {
      emu.neDllResources.push({ resources: dll.resources, arrayBuffer: dllBuf });
    }

    // Record static data end for the DLL's auto-data segment
    // so LocalInit can avoid clobbering initialized global variables
    if (dll.dataSegSelector && dll.autoDataStaticSize > 0) {
      emu.segStaticEnd.set(dll.dataSegSelector, dll.autoDataStaticSize);
    }

    // Track DLL data segment selectors for correct DS in wndProc dispatch
    if (dll.dataSegSelector) {
      emu.neDllDataSegs.add(dll.dataSegSelector);
    }

    // Merge DLL's API thunks (its imports from KERNEL/USER/etc) into the main apiMap
    for (const [addr, info] of dll.apiMap) {
      ne.apiMap.set(addr, info);
    }

    // Add DLL segments to the main segment list (for WILD EIP validation)
    for (const seg of dll.segments) {
      ne.segments.push(seg);
    }

    console.log(`[NE DLL] ${modName}: ${dll.segments.length} segments, ${dll.entryPoints.size} exports, ${dll.apiMap.size} imports`);

    // Collect DLL entry point for calling LibMain/LibEntry later
    if (dll.entryPoint) {
      dllEntries.push({
        name: modName,
        entryPoint: dll.entryPoint,
        dataSegSelector: dll.dataSegSelector,
        codeSegSelector: dll.codeSegSelector,
        heapSize: dll.heapSize,
      });
    }

    // Recursively load DLLs that this DLL imports (if any non-builtin)
    for (const subMod of dll.moduleNames) {
      if (!builtinModules.has(subMod) && !loadedDlls.has(subMod)) {
        // Add to moduleNames for processing in next iteration if needed
        // For now, just warn
        console.warn(`[NE DLL] ${modName} imports ${subMod} — nested DLL loading not yet supported`);
      }
    }
  }

  // Resolve exe→DLL imports: for thunks that reference loaded DLLs,
  // register thunk handlers that perform a FAR JMP to the DLL's actual code.
  let resolved = 0;
  for (const [addr, info] of ne.apiMap) {
    const dll = loadedDlls.get(info.dll);
    if (!dll) continue;

    let ordinal = info.ordinal;
    // Resolve named imports (ordinal=0) via the DLL's resident name table
    if (ordinal === 0 && info.name) {
      const resolved = dll.nameToOrdinal.get(info.name.toUpperCase());
      if (resolved !== undefined) ordinal = resolved;
    }
    const entry = dll.entryPoints.get(ordinal);
    if (!entry) {
      console.warn(`[NE DLL] ${info.dll}:ord_${info.ordinal} not found in DLL entry table`);
      continue;
    }

    const seg = dll.segments[entry.seg - 1];
    if (!seg) {
      console.warn(`[NE DLL] ${info.dll}:ord_${info.ordinal} references invalid segment ${entry.seg}`);
      continue;
    }

    const linearAddr = seg.linearBase + entry.offset;
    const targetSelector = seg.selector;
    const targetOffset = entry.offset;

    // Register a thunk handler that jumps to the DLL code (FAR JMP)
    const key = `${info.dll}:${info.name}`;
    emu.apiDefs.set(key, {
      handler: () => {
        // The FAR CALL pushed IP/CS on the stack — leave them for the DLL's RETF
        emu.cpu.cs = targetSelector;
        emu.cpu.eip = linearAddr;
        return undefined; // don't complete thunk — DLL code will RETF itself
      },
      stackBytes: 0,
    });

    resolved++;
  }

  if (resolved > 0) {
    console.log(`[NE DLL] Resolved ${resolved} exe→DLL imports as FAR JMP thunks`);
  }

  // Update the ne object with new state
  ne.thunkAddrEnd = thunkAddr;
  ne.nextSelector = nextSelector;

  return dllEntries;
}

/** Set up DOS environment (CPU, BDA, IVT, heap, audio) shared by MZ and COM loaders. */
function setupDosEnvironment(emu: Emulator, mz: import('./mz-loader').LoadedMZ): void {
  emu._dosLoadSegment = mz.loadSegment;
  emu._dosPSP = mz.loadSegment;
  emu._dosImageSize = mz.imageSize;
  emu._dosMcbFirstSeg = mz.mcbFirstSeg;

  // Set up CPU for 16-bit real mode
  emu.cpu.use32 = false;
  emu.cpu.realMode = true;

  emu.cpu.cs = mz.entryCS;
  emu.cpu.ds = mz.loadSegment; // PSP segment (DOS convention: DS=ES=PSP)
  emu.cpu.es = mz.loadSegment; // PSP segment
  emu.cpu.ss = mz.entrySS;
  emu.cpu.eip = (emu.cpu.segBase(mz.entryCS)) + mz.entryIP;
  emu.cpu.reg[4] = mz.entrySP; // SP
  emu.cpu.setFlags(emu.cpu.getFlags() | 0x0200); // IF=1: enable hardware interrupts

  // Set up video memory area (B800:0000)
  for (let i = 0; i < emu.screenCols * emu.screenRows; i++) {
    emu.memory.writeU8(0xB8000 + i * 2, 0x20);
    emu.memory.writeU8(0xB8000 + i * 2 + 1, 0x07);
  }

  // Set up per-interrupt BIOS stubs at F000:i*5, each containing: INT i; RETF 2
  const IRET_SEG = 0xF000;
  const BIOS_BASE = IRET_SEG * 16;
  for (let i = 0; i < 256; i++) {
    const off = i * 5;
    emu.memory.writeU8(BIOS_BASE + off, 0xCD);
    emu.memory.writeU8(BIOS_BASE + off + 1, i);
    emu.memory.writeU8(BIOS_BASE + off + 2, 0xCA);
    emu.memory.writeU8(BIOS_BASE + off + 3, 0x02);
    emu.memory.writeU8(BIOS_BASE + off + 4, 0x00);
  }
  const defaultVec = new Map<number, number>();
  for (let i = 0; i < 256; i++) defaultVec.set(i, (IRET_SEG << 16) | (i * 5));

  for (let i = 0; i < 256; i++) {
    const vec = defaultVec.get(i)!;
    emu.memory.writeU16(i * 4, vec & 0xFFFF);
    emu.memory.writeU16(i * 4 + 2, (vec >>> 16) & 0xFFFF);
    emu._dosBiosDefaultVectors.set(i, vec);
    emu._dosIntVectors.set(i, vec);
  }

  // BDA (BIOS Data Area) at 0040:0000
  emu.memory.writeU8(0x0449, 0x03);
  emu.memory.writeU16(0x044A, 80);
  emu.memory.writeU16(0x044C, 80 * 25 * 2);
  emu.memory.writeU16(0x044E, 0);
  emu.memory.writeU16(0x0450, 0);
  emu.memory.writeU8(0x0460, 15);
  emu.memory.writeU8(0x0461, 14);
  emu.memory.writeU8(0x0462, 0);
  emu.memory.writeU16(0x0463, 0x3D4);
  emu.memory.writeU8(0x0465, 0x29);
  emu.memory.writeU8(0x0466, 0x30);
  emu.memory.writeU8(0x0484, 24);
  emu.memory.writeU16(0x0485, 16);
  emu.memory.writeU8(0x0487, 0x60);
  emu.memory.writeU8(0x0489, 0x21);
  // Keyboard buffer
  emu.memory.writeU16(0x041A, 0x1E);
  emu.memory.writeU16(0x041C, 0x1E);
  emu.memory.writeU16(0x0480, 0x1E);
  emu.memory.writeU16(0x0482, 0x3E);
  emu.memory.writeU8(0x0417, 0x00);
  emu.memory.writeU8(0x0418, 0x00);
  emu.memory.writeU8(0x0496, 0x10);
  // BIOS configuration table at F000:0600
  const biosCfg = 0xF0000 + 0x0600;
  emu.memory.writeU8(biosCfg + 0, 0x08);
  emu.memory.writeU8(biosCfg + 1, 0xFC);
  emu.memory.writeU8(biosCfg + 2, 0x00);
  emu.memory.writeU8(biosCfg + 3, 0x00);
  emu.memory.writeU8(biosCfg + 4, 0x00);
  emu.memory.writeU8(biosCfg + 5, 0x10);
  emu.memory.writeU8(biosCfg + 6, 0x00);
  emu.memory.writeU8(biosCfg + 7, 0x00);
  emu.memory.writeU8(biosCfg + 8, 0x00);
  // VGA Static Functionality Table at F000:0700
  const sftBase = 0xF0000 + 0x0700;
  emu.memory.writeU8(sftBase + 0x00, 0xFF);
  emu.memory.writeU8(sftBase + 0x01, 0xE0);
  emu.memory.writeU8(sftBase + 0x02, 0x0F);
  emu.memory.writeU8(sftBase + 0x03, 0x00);
  emu.memory.writeU8(sftBase + 0x04, 0x00);
  emu.memory.writeU8(sftBase + 0x05, 0x00);
  emu.memory.writeU8(sftBase + 0x06, 0x00);
  emu.memory.writeU8(sftBase + 0x07, 0x07);
  emu.memory.writeU8(sftBase + 0x08, 0x02);
  emu.memory.writeU8(sftBase + 0x09, 0x08);
  emu.memory.writeU8(sftBase + 0x0A, 0xE7);
  emu.memory.writeU8(sftBase + 0x0B, 0x0F);
  emu.memory.writeU8(sftBase + 0x0C, 0x00);
  emu.memory.writeU8(sftBase + 0x0D, 0x00);
  emu.memory.writeU8(sftBase + 0x0E, 0x00);
  emu.memory.writeU8(sftBase + 0x0F, 0x00);

  setupXmsStub(emu.memory);

  // UCDOS stub — fake TSR for UCDOS-dependent programs.
  // Programs do INT 21h AH=35h AL=79h to get INT 79h handler → ES:BX,
  // then check ES:[0104h] == "TP" (absolute offset 0x0104 within the segment).
  // Place stub in BIOS ROM area at F000:0900. The "TP" signature goes at
  // offset 0x0104 relative to the handler's SEGMENT base, i.e., F000:0104.
  // F000:0104 = linear 0xF0104 — this is in the BIOS stubs area (INT 0x20's
  // stub is at F000:0x64 = 100*5, so 0x0104 is within the stub region but
  // those stubs only use 5 bytes each, so byte 0x0104 is the 5th byte of
  // INT 0x33's stub (unused padding). Safe to write here.
  const UCDOS_STUB_SEG = 0xF000;
  const UCDOS_STUB_OFF = 0x0900;
  const ucdosLin = UCDOS_STUB_SEG * 16 + UCDOS_STUB_OFF;
  emu.memory.writeU8(ucdosLin, 0xCF); // IRET at entry point
  // "TP" signature at SEG:0104 = F000:0104 = linear 0xF0104
  const sigAddr = UCDOS_STUB_SEG * 16 + 0x0104;
  emu.memory.writeU8(sigAddr, 0x54);     // 'T'
  emu.memory.writeU8(sigAddr + 1, 0x50); // 'P'
  // Point INT 79h to our stub
  emu.memory.writeU16(0x79 * 4, UCDOS_STUB_OFF);
  emu.memory.writeU16(0x79 * 4 + 2, UCDOS_STUB_SEG);
  emu._dosIntVectors.set(0x79, (UCDOS_STUB_SEG << 16) | UCDOS_STUB_OFF);
  emu._dosUcdosStubSeg = UCDOS_STUB_SEG;
  // Register the UCDOS stub as the "BIOS default" so the dispatch code
  // falls through to our JS handleInt79 instead of jumping to the IRET stub.
  const ucdosVec = (UCDOS_STUB_SEG << 16) | UCDOS_STUB_OFF;
  emu._dosBiosDefaultVectors.set(0x79, ucdosVec);

  // Equipment list and memory size
  emu.memory.writeU16(0x0410, 0x0021);
  emu.memory.writeU16(0x0413, 640);

  // Heap/virtual allocator
  const imageEnd = mz.loadSegment * 16 + mz.imageSize + 0x100;
  emu.heapBase = ((imageEnd + 0xF) & ~0xF);
  emu.heapPtr = emu.heapBase;
  emu.virtualBase = 0x00080000;
  emu.virtualPtr = emu.virtualBase;

  // Wire Sound Blaster DMA
  emu.dosAudio.readMemory = (addr: number) => emu.memory.readU8(addr);
  emu.dosAudio.writeMemory = (addr: number, val: number) => emu.memory.writeU8(addr, val);
  emu.dosAudio.onSBIRQ = () => {
    if (!emu._pendingHwInts.includes(0x0F)) emu._pendingHwInts.push(0x0F);
  };
}

/** Rebuild the thunk page set from current thunkToApi entries. */
export function rebuildThunkPages(emu: Emulator): void {
  emu.thunkPages.clear();
  for (const addr of emu.thunkToApi.keys()) {
    emu.thunkPages.add(addr >>> 12);
  }
}

export function emuFindResourceEntry(emu: Emulator, typeId: number | string, nameId: number | string): { dataRva: number; dataSize: number } | null {
  return findResourceInDir(emu, emu.pe.imageBase, emu.pe.resourceRva, typeId, nameId);
}

export function emuFindResourceEntryForModule(emu: Emulator, imageBase: number, resourceRva: number, typeId: number | string, nameId: number | string): { dataRva: number; dataSize: number } | null {
  return findResourceInDir(emu, imageBase, resourceRva, typeId, nameId);
}

function findResourceInDir(emu: Emulator, imageBase: number, resRva: number, typeId: number | string, nameId: number | string): { dataRva: number; dataSize: number } | null {
  if (!resRva) return null;
  const base = imageBase + resRva;

  const nameIsString = typeof nameId === 'string';
  const nameUpper = nameIsString ? (nameId as string).toUpperCase() : '';
  const typeIsString = typeof typeId === 'string';
  const typeUpper = typeIsString ? (typeId as string).toUpperCase() : '';

  // Level 1: Resource types
  const numNamed1 = emu.memory.readU16(base + 12);
  const numId1 = emu.memory.readU16(base + 14);
  let offset1 = base + 16;

  for (let i = 0; i < numNamed1 + numId1; i++) {
    const id = emu.memory.readU32(offset1);
    const off = emu.memory.readU32(offset1 + 4);
    offset1 += 8;

    // Match type: numeric or string
    let typeMatch = false;
    if (typeIsString) {
      if (id & 0x80000000) {
        const strAddr = base + (id & 0x7FFFFFFF);
        const strLen = emu.memory.readU16(strAddr);
        let s = '';
        for (let k = 0; k < strLen; k++) {
          s += String.fromCharCode(emu.memory.readU16(strAddr + 2 + k * 2));
        }
        typeMatch = s.toUpperCase() === typeUpper;
      }
    } else {
      typeMatch = id === typeId;
    }
    if (!typeMatch) continue;
    if (!(off & 0x80000000)) continue;

    // Level 2: Resource names/IDs
    const dir2 = base + (off & 0x7FFFFFFF);
    const numNamed2 = emu.memory.readU16(dir2 + 12);
    const numId2 = emu.memory.readU16(dir2 + 14);
    let offset2 = dir2 + 16;

    for (let j = 0; j < numNamed2 + numId2; j++) {
      const id2 = emu.memory.readU32(offset2);
      const off2 = emu.memory.readU32(offset2 + 4);
      offset2 += 8;

      let match = false;
      if (nameIsString) {
        if (id2 & 0x80000000) {
          const addr = base + (id2 & 0x7FFFFFFF);
          const len = emu.memory.readU16(addr);
          let s = '';
          for (let k = 0; k < len; k++) {
            s += String.fromCharCode(emu.memory.readU16(addr + 2 + k * 2));
          }
          match = s.toUpperCase() === nameUpper;
        }
      } else {
        if (!(id2 & 0x80000000) && id2 === nameId) {
          match = true;
        }
      }

      if (!match) continue;

      if (!(off2 & 0x80000000)) {
        const dataEntry = base + off2;
        return {
          dataRva: emu.memory.readU32(dataEntry),
          dataSize: emu.memory.readU32(dataEntry + 4),
        };
      }

      // Level 3: Language — prefer configured locale, then same primary language, then English, then neutral
      const dir3 = base + (off2 & 0x7FFFFFFF);
      const numNamed3 = emu.memory.readU16(dir3 + 12);
      const numId3 = emu.memory.readU16(dir3 + 14);
      const totalLangs = numNamed3 + numId3;

      if (totalLangs > 0) {
        const cfgLcid = emu.configuredLcid;
        const cfgPrimary = cfgLcid & 0x3FF;
        let bestIdx = 0;
        let bestScore = 0; // default: first found
        for (let k = 0; k < totalLangs; k++) {
          const langId = emu.memory.readU32(dir3 + 16 + k * 8);
          let score = 1;
          if (langId === cfgLcid) score = 5;                              // exact match
          else if ((langId & 0x3FF) === cfgPrimary) score = 4;            // same primary language
          else if (langId === 0x0409 || (langId & 0x3FF) === 0x09) score = 3; // English fallback
          else if (langId === 0) score = 2;                               // neutral
          if (score > bestScore) { bestScore = score; bestIdx = k; }
        }
        const off3 = emu.memory.readU32(dir3 + 16 + bestIdx * 8 + 4);
        if (off3 & 0x80000000) continue;

        const dataEntry = base + off3;
        return {
          dataRva: emu.memory.readU32(dataEntry),
          dataSize: emu.memory.readU32(dataEntry + 4),
        };
      }
    }
  }
  return null;
}
