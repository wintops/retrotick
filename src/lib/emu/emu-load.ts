import type { Emulator } from './emulator';
import type { PEInfo } from '../pe/types';
import { loadPE } from './pe-loader';
import { loadNE } from './ne-loader';
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
import { registerShlwapi } from './win32/shlwapi';
import { registerPsapi } from './win32/psapi';
import { registerIphlpapi } from './win32/iphlpapi';
import { registerSecur32 } from './win32/secur32';
import { registerWin16Kernel, registerWin16User, registerWin16Gdi, registerWin16Shell, registerWin16Ddeml, registerWin16Mmsystem, registerWin16Commdlg, registerWin16Keyboard, registerWin16Win87em } from './win16/index';
import { buildThunkTable, preloadStrings, verifyIAT, initTEB, initThreadTEB } from './emu-thunks-pe';
import { Thread } from './thread';
import { parsePE, extractExports } from '../pe';
import type { ExportFunction } from '../pe';
import { buildNEThunkTable } from './emu-thunks-ne';
import { handleSehDispatchReturn } from './emu-window';
import { loadMZ } from './mz-loader';

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
    const dir = emu.exePath.substring(0, lastBackslash);
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

  // MZ (DOS) executable branch
  if (peInfo.isMZ && peInfo.mzHeader) {
    emu.isDOS = true;
    emu.isConsole = true;
    emu._dosExeData = new Uint8Array(arrayBuffer);
    emu.initConsoleBuffer();

    const mz = loadMZ(arrayBuffer, emu.memory, peInfo.mzHeader, emu.exePath);
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

    // Set up video memory area (B800:0000)
    // Initialize with spaces + default attribute
    for (let i = 0; i < 80 * 25; i++) {
      emu.memory.writeU8(0xB8000 + i * 2, 0x20);
      emu.memory.writeU8(0xB8000 + i * 2 + 1, 0x07);
    }

    // Set up per-interrupt BIOS stubs at F000:i*3, each containing: INT i; IRET
    // This allows programs that chain to the original vector (via CALL FAR) to
    // trigger our built-in handler through the INT instruction.
    const IRET_SEG = 0xF000;
    const BIOS_BASE = IRET_SEG * 16; // linear 0xF0000
    for (let i = 0; i < 256; i++) {
      const off = i * 3;
      emu.memory.writeU8(BIOS_BASE + off, 0xCD);     // INT
      emu.memory.writeU8(BIOS_BASE + off + 1, i);    // interrupt number
      emu.memory.writeU8(BIOS_BASE + off + 2, 0xCF); // IRET
    }

    // Fill IVT (256 entries × 4 bytes at address 0x0000)
    for (let i = 0; i < 256; i++) {
      emu.memory.writeU16(i * 4, i * 3);        // offset = i*3
      emu.memory.writeU16(i * 4 + 2, IRET_SEG); // segment
    }

    // Also populate _dosIntVectors so AH=35h returns these defaults
    for (let i = 0; i < 256; i++) {
      emu._dosIntVectors.set(i, (IRET_SEG << 16) | (i * 3));
    }

    // BDA (BIOS Data Area) at 0040:0000
    // Video info
    emu.memory.writeU16(0x0449, 0x03); // current video mode
    emu.memory.writeU16(0x044A, 80);   // screen columns
    emu.memory.writeU16(0x0450, 0);    // cursor position page 0
    emu.memory.writeU16(0x0462, 0);    // active display page
    emu.memory.writeU16(0x0463, 0x3D4); // CRTC base port
    // Keyboard buffer (circular buffer at 0040:001E-003D, 16 words)
    emu.memory.writeU16(0x041A, 0x1E); // buffer head (offset within seg 40h)
    emu.memory.writeU16(0x041C, 0x1E); // buffer tail (same = empty)
    emu.memory.writeU16(0x0480, 0x1E); // buffer start offset
    emu.memory.writeU16(0x0482, 0x3E); // buffer end offset
    // Equipment list (0040:0010) — bit 0=floppy, bits 4-5=video mode (10=80col color)
    emu.memory.writeU16(0x0410, 0x0021);
    // Memory size in KB (0040:0013) — 640KB
    emu.memory.writeU16(0x0413, 640);

    // Heap/virtual allocator — must be within real-mode 1MB address space
    // Place heap after program image, aligned to paragraph boundary
    const imageEnd = mz.loadSegment * 16 + mz.imageSize + 0x100; // +0x100 for PSP
    emu.heapBase = ((imageEnd + 0xF) & ~0xF); // paragraph-aligned
    emu.heapPtr = emu.heapBase;
    // Virtual base also within 1MB, above heap
    emu.virtualBase = 0x00080000; // 512KB
    emu.virtualPtr = emu.virtualBase;

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
    const dsBase = emu.ne.selectorToBase.get(emu.ne.dataSegSelector) || 0;
    emu.localHeapBase = dsBase + emu.ne.autoDataStaticSize;
    emu.localHeapPtr = emu.localHeapBase;
    emu.localHeapEnd = emu.localHeapBase + Math.max(emu.ne.heapSize, 8192);

    // Global heap/virtual allocator after NE segments
    emu.heapBase = 0x00100000; // 1MB — well above all NE segments
    emu.heapPtr = emu.heapBase;
    emu.virtualBase = 0x01100000;
    emu.virtualPtr = emu.virtualBase;

    // Register Win16 API handlers
    registerWin16Kernel(emu);
    registerWin16User(emu);
    registerWin16Gdi(emu);
    registerWin16Shell(emu);
    registerWin16Ddeml(emu);
    registerWin16Mmsystem(emu);
    registerWin16Commdlg(emu);
    registerWin16Keyboard(emu);
    registerWin16Win87em(emu);

    // Build thunk table for NE
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

    // Create a dummy thread for NE apps so thread-delegated getters/setters work
    const mainThread = new Thread(emu.nextThreadId++, Thread.createInitialState(emu.cpu));
    emu.threads.push(mainThread);
    emu.currentThread = mainThread;

    console.log(`[EMU] NE loaded: entry=0x${emu.ne.entryPoint.toString(16)} CS=${emu.ne.codeSegSelector} SS=${emu.ne.stackSegSelector} DS=${emu.ne.dataSegSelector}`);
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
  registerShlwapi(emu);
  registerPsapi(emu);
  registerIphlpapi(emu);
  registerSecur32(emu);

  // MSIMG32 stubs
  const msimg32 = emu.registerDll('MSIMG32.DLL');
  msimg32.register('TransparentBlt', 11, () => 1);
  msimg32.register('AlphaBlend', 11, () => 1);

  // IMM32 stubs
  const imm32 = emu.registerDll('IMM32.DLL');
  imm32.register('ImmGetContext', 1, () => 0); // return NULL (no IME context)
  imm32.register('ImmReleaseContext', 2, () => 1);
  imm32.register('ImmSetCompositionStringW', 6, () => 0);
  imm32.register('ImmSetCompositionWindow', 2, () => 0);
  imm32.register('ImmGetCompositionWindow', 2, () => 0);
  imm32.register('ImmNotifyIME', 3, () => 0);
  imm32.register('ImmSetOpenStatus', 2, () => 0);
  imm32.register('ImmGetOpenStatus', 1, () => 0);
  imm32.register('ImmSetCompositionFontW', 2, () => 0);
  imm32.register('ImmGetCompositionStringW', 4, () => 0);
  imm32.register('ImmAssociateContext', 2, () => 0);

  // NTDLL stubs
  const ntdll = emu.registerDll('NTDLL.DLL');
  // VerSetConditionMask: builds a condition mask for VerifyVersionInfo
  ntdll.register('VerSetConditionMask', 3, () => {
    // Returns a 64-bit condition mask in EDX:EAX
    // Just return a non-zero value so the caller can use it
    emu.cpu.reg[0] = 1; // EAX (low)
    emu.cpu.reg[2] = 0; // EDX (high)
    return 1;
  });

  // VerifyVersionInfoW: check OS version — pretend we match
  emu.apiDefs.set('KERNEL32.DLL:VerifyVersionInfoW', { handler: () => 1, stackBytes: 4 * 4 });

  ntdll.register('NtQuerySystemInformation', 4, () => {
    const infoClass = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const bufLen = emu.readArg(2);
    const retLenPtr = emu.readArg(3);
    console.log(`[NTDLL] NtQuerySystemInformation class=${infoClass} buf=0x${bufPtr.toString(16)} len=${bufLen} retLenPtr=0x${retLenPtr.toString(16)}`);

    if (infoClass === 5) { // SystemProcessInformation
      // SYSTEM_PROCESS_INFORMATION is 0xB8 bytes on Win2000+ (32-bit)
      // followed by NumberOfThreads * SYSTEM_THREAD_INFORMATION (0x40 each)
      const ENTRY_SIZE = 0xB8;
      const THREAD_SIZE = 0x40;
      // Get process list from shared registry, or fall back to just this emulator
      const procs = emu.processRegistry
        ? emu.processRegistry.getProcessList()
        : [{ pid: emu.pid || 1234, name: emu.exeName, threadCount: 1, basePriority: 8, handleCount: emu.handles.size(), workingSetSize: (emu.heapPtr - emu.heapBase + emu.virtualPtr - emu.virtualBase) || 0, cpuTime: emu.cpuTimeMs }];
      // Calculate total size: each process entry + 1 thread each + string data
      let strDataSize = 0;
      for (const p of procs) strDataSize += (p.name.length + 1) * 2;
      const totalSize = procs.length * (ENTRY_SIZE + THREAD_SIZE) + strDataSize;

      if (retLenPtr) emu.memory.writeU32(retLenPtr, totalSize);
      if (bufLen < totalSize) return 0xC0000004; // STATUS_INFO_LENGTH_MISMATCH

      const strArea = bufPtr + procs.length * (ENTRY_SIZE + THREAD_SIZE);
      let off = 0;
      let strOff = 0;

      for (let idx = 0; idx < procs.length; idx++) {
        const proc = procs[idx];
        const pAddr = bufPtr + off;
        // Zero out entry + 1 thread
        for (let i = 0; i < ENTRY_SIZE + THREAD_SIZE; i += 4) emu.memory.writeU32(pAddr + i, 0);
        // NextEntryOffset (0 for last)
        const isLast = idx === procs.length - 1;
        emu.memory.writeU32(pAddr + 0x00, isLast ? 0 : ENTRY_SIZE + THREAD_SIZE);
        emu.memory.writeU32(pAddr + 0x04, proc.threadCount); // NumberOfThreads
        // ImageName UNICODE_STRING at offset 0x38
        if (proc.name) {
          const nameBytes = proc.name.length * 2;
          const namePtr = strArea + strOff;
          for (let i = 0; i < proc.name.length; i++) emu.memory.writeU16(namePtr + i * 2, proc.name.charCodeAt(i));
          emu.memory.writeU16(namePtr + nameBytes, 0);
          emu.memory.writeU16(pAddr + 0x38, nameBytes); // Length
          emu.memory.writeU16(pAddr + 0x3A, nameBytes + 2); // MaximumLength
          emu.memory.writeU32(pAddr + 0x3C, namePtr); // Buffer pointer
          strOff += nameBytes + 2;
        }
        emu.memory.writeU32(pAddr + 0x40, proc.basePriority); // BasePriority (0x40)
        emu.memory.writeU32(pAddr + 0x44, proc.pid); // UniqueProcessId (0x44)
        emu.memory.writeU32(pAddr + 0x4C, proc.handleCount); // HandleCount (0x4C)
        emu.memory.writeU32(pAddr + 0x68, proc.workingSetSize); // WorkingSetSize (0x68)
        // UserTime at offset 0x28 (LARGE_INTEGER, units of 100ns)
        const userTime100ns = Math.floor(proc.cpuTime * 10000);
        emu.memory.writeU32(pAddr + 0x28, userTime100ns & 0xFFFFFFFF); // low DWORD
        emu.memory.writeU32(pAddr + 0x2C, (userTime100ns / 0x100000000) >>> 0); // high DWORD

        // Fill SYSTEM_THREAD_INFORMATION (0x40 bytes) after process entry
        const tAddr = pAddr + ENTRY_SIZE;
        // Thread UserTime at offset 0x08
        emu.memory.writeU32(tAddr + 0x08, userTime100ns & 0xFFFFFFFF);
        emu.memory.writeU32(tAddr + 0x0C, (userTime100ns / 0x100000000) >>> 0);
        // CLIENT_ID at offset 0x20: UniqueProcess (PID) + UniqueThread (TID)
        emu.memory.writeU32(tAddr + 0x20, proc.pid);       // UniqueProcess
        emu.memory.writeU32(tAddr + 0x24, proc.pid + 1);   // UniqueThread
        // BasePriority at offset 0x2C
        emu.memory.writeU32(tAddr + 0x2C, proc.basePriority);

        off += ENTRY_SIZE + THREAD_SIZE;
      }

      return 0; // STATUS_SUCCESS
    }

    if (infoClass === 8) { // SystemProcessorPerformanceInformation
      // SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION: 48 bytes per CPU
      // struct { LARGE_INTEGER IdleTime, KernelTime, UserTime, DpcTime, InterruptTime; ULONG InterruptCount; }
      if (retLenPtr) emu.memory.writeU32(retLenPtr, 48);
      if (bufLen >= 48) {
        for (let i = 0; i < 48; i += 4) emu.memory.writeU32(bufPtr + i, 0);
        // Provide incrementing times to prevent division by zero
        // Each call should return larger values so the delta is non-zero
        emu._perfCounter = (emu._perfCounter || 0) + 1000000;
        const t = emu._perfCounter;
        // IdleTime (8 bytes) — ~50% idle
        emu.memory.writeU32(bufPtr + 0, (t * 5) >>> 0);
        emu.memory.writeU32(bufPtr + 4, 0);
        // KernelTime (8 bytes)
        emu.memory.writeU32(bufPtr + 8, (t * 3) >>> 0);
        emu.memory.writeU32(bufPtr + 12, 0);
        // UserTime (8 bytes)
        emu.memory.writeU32(bufPtr + 16, (t * 2) >>> 0);
        emu.memory.writeU32(bufPtr + 20, 0);
      }
      return 0;
    }

    if (infoClass === 2) { // SystemPerformanceInformation (312 bytes)
      const size = 312;
      if (retLenPtr) emu.memory.writeU32(retLenPtr, size);
      if (bufLen >= size) {
        for (let i = 0; i < size; i += 4) emu.memory.writeU32(bufPtr + i, 0);
        // Use browser memory info if available (Chrome performance.memory), else emulator stats
        const PAGE_SIZE = 4096;
        const perf: Performance & { memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number; totalJSHeapSize: number } } = globalThis.performance;
        const mem = perf?.memory;
        let availablePages: number, committedPages: number, commitLimit: number;
        let totalPhysPages: number, pagedPoolPages: number, nonPagedPoolPages: number;
        if (mem && mem.jsHeapSizeLimit) {
          totalPhysPages = Math.floor(mem.jsHeapSizeLimit / PAGE_SIZE);
          committedPages = Math.floor(mem.usedJSHeapSize / PAGE_SIZE);
          commitLimit = Math.floor(mem.totalJSHeapSize / PAGE_SIZE);
          availablePages = totalPhysPages - committedPages;
          pagedPoolPages = Math.floor(mem.usedJSHeapSize / PAGE_SIZE / 8);
          nonPagedPoolPages = Math.floor(pagedPoolPages / 2);
        } else {
          const usedHeap = (emu.heapPtr - emu.heapBase) || 0;
          const usedVirtual = (emu.virtualPtr - emu.virtualBase) || 0;
          const totalUsed = usedHeap + usedVirtual;
          totalPhysPages = 65536; // 256 MB
          committedPages = Math.floor(totalUsed / PAGE_SIZE) || 256;
          commitLimit = totalPhysPages * 2;
          availablePages = totalPhysPages - Math.floor(totalUsed / PAGE_SIZE);
          pagedPoolPages = Math.floor(committedPages / 8) || 1024;
          nonPagedPoolPages = Math.floor(pagedPoolPages / 2) || 512;
        }
        // Offsets from SYSTEM_PERFORMANCE_INFORMATION:
        emu.memory.writeU32(bufPtr + 0x2C, availablePages);    // AvailablePages
        emu.memory.writeU32(bufPtr + 0x30, committedPages);    // CommittedPages
        emu.memory.writeU32(bufPtr + 0x34, commitLimit);       // CommitLimit
        emu.memory.writeU32(bufPtr + 0x48, totalPhysPages);    // TotalSystemCodePages
        emu.memory.writeU32(bufPtr + 0x60, pagedPoolPages);    // PagedPoolPages
        emu.memory.writeU32(bufPtr + 0x64, nonPagedPoolPages); // NonPagedPoolPages
      }
      return 0;
    }

    if (infoClass === 21) { // SystemFileCacheInformation (36 bytes)
      const size = 36;
      if (retLenPtr) emu.memory.writeU32(retLenPtr, size);
      if (bufLen >= size) {
        for (let i = 0; i < size; i += 4) emu.memory.writeU32(bufPtr + i, 0);
      }
      return 0;
    }

    if (infoClass === 0) { // SystemBasicInformation (44 bytes)
      if (retLenPtr) emu.memory.writeU32(retLenPtr, 44);
      if (bufLen >= 44) {
        for (let i = 0; i < 44; i += 4) emu.memory.writeU32(bufPtr + i, 0);
        const perf0: Performance & { memory?: { jsHeapSizeLimit: number } } = globalThis.performance;
        const mem0 = perf0.memory;
        const physPages = mem0?.jsHeapSizeLimit ? Math.floor(mem0.jsHeapSizeLimit / 4096) : 65536;
        emu.memory.writeU32(bufPtr + 0, 0);           // Reserved
        emu.memory.writeU32(bufPtr + 4, 4096);         // TimerResolution
        emu.memory.writeU32(bufPtr + 8, 4096);         // PageSize
        emu.memory.writeU32(bufPtr + 12, physPages);    // NumberOfPhysicalPages
        emu.memory.writeU32(bufPtr + 16, 1);            // LowestPhysicalPageNumber
        emu.memory.writeU32(bufPtr + 20, 0x3FFFF);      // HighestPhysicalPageNumber
        emu.memory.writeU32(bufPtr + 24, 4096);         // AllocationGranularity
        emu.memory.writeU32(bufPtr + 28, 0x10000);      // MinimumUserModeAddress
        emu.memory.writeU32(bufPtr + 32, 0x7FFEFFFF);   // MaximumUserModeAddress
        emu.memory.writeU32(bufPtr + 36, 1);            // ActiveProcessorsAffinityMask
        emu.memory.writeU8(bufPtr + 40, 1);             // NumberOfProcessors
      }
      return 0;
    }

    // Default: return STATUS_NOT_IMPLEMENTED
    if (retLenPtr) emu.memory.writeU32(retLenPtr, 0);
    return 0xC0000001;
  });
  // _chkstk: stack probe — EAX = bytes to allocate on stack
  // Probes pages and adjusts ESP; special calling convention
  ntdll.register('_chkstk', 0, () => {
    const allocSize = emu.cpu.reg[0] >>> 0; // EAX = number of bytes
    const retAddr = emu.memory.readU32(emu.cpu.reg[4] >>> 0);
    // Pop return address, subtract allocSize from ESP, then push return address back
    emu.cpu.reg[4] = (emu.cpu.reg[4] + 4) | 0; // pop retAddr
    emu.cpu.reg[4] = (emu.cpu.reg[4] - allocSize) | 0; // allocate stack space
    emu.cpu.eip = retAddr;
    return undefined;
  });

  // NTDLL CRT helpers
  ntdll.register('_wcsicmp', 0, () => {
    const s1 = emu.readArg(0);
    const s2 = emu.readArg(1);
    const str1 = emu.memory.readUTF16String(s1).toLowerCase();
    const str2 = emu.memory.readUTF16String(s2).toLowerCase();
    return str1 < str2 ? -1 : str1 > str2 ? 1 : 0;
  });
  ntdll.register('strrchr', 0, () => {
    const sPtr = emu.readArg(0);
    const ch = emu.readArg(1) & 0xFF;
    const str = emu.memory.readCString(sPtr);
    const idx = str.lastIndexOf(String.fromCharCode(ch));
    return idx >= 0 ? sPtr + idx : 0;
  });
  // _allmul: 64-bit multiply EDX:EAX = arg1(64) * arg2(64) — stdcall, 4 DWORDs (ret 16)
  ntdll.register('_allmul', 4, () => {
    const a_lo = emu.readArg(0);
    const a_hi = emu.readArg(1) | 0;
    const b_lo = emu.readArg(2);
    const b_hi = emu.readArg(3) | 0;
    const a = BigInt(a_hi) * 0x100000000n + BigInt(a_lo >>> 0);
    const b = BigInt(b_hi) * 0x100000000n + BigInt(b_lo >>> 0);
    const r = a * b;
    emu.cpu.reg[0] = Number(r & 0xFFFFFFFFn); // EAX = low
    emu.cpu.reg[2] = Number((r >> 32n) & 0xFFFFFFFFn); // EDX = high
    return emu.cpu.reg[0];
  });
  // _alldiv: 64-bit signed divide EDX:EAX = arg1(64) / arg2(64) — stdcall (ret 16)
  ntdll.register('_alldiv', 4, () => {
    const a_lo = emu.readArg(0);
    const a_hi = emu.readArg(1) | 0;
    const b_lo = emu.readArg(2);
    const b_hi = emu.readArg(3) | 0;
    const a = (BigInt(a_hi) << 32n) | BigInt(a_lo >>> 0);
    const b = (BigInt(b_hi) << 32n) | BigInt(b_lo >>> 0);
    const r = b !== 0n ? a / b : 0n;
    emu.cpu.reg[0] = Number(r & 0xFFFFFFFFn);
    emu.cpu.reg[2] = Number((r >> 32n) & 0xFFFFFFFFn);
    return emu.cpu.reg[0];
  });

  // RtlLargeIntegerToChar: convert 64-bit integer to ANSI string
  // NTSTATUS RtlLargeIntegerToChar(PLARGE_INTEGER Value, ULONG Base, ULONG StringLength, PCHAR String)
  ntdll.register('RtlLargeIntegerToChar', 4, () => {
    const valuePtr = emu.readArg(0);
    const base = emu.readArg(1) || 10;
    const strLen = emu.readArg(2);
    const strPtr = emu.readArg(3);
    const lo = emu.memory.readU32(valuePtr) >>> 0;
    const hi = emu.memory.readU32(valuePtr + 4) >>> 0;
    const val = BigInt(hi) * 0x100000000n + BigInt(lo);
    const str = val.toString(base);
    if (str.length + 1 > strLen) return 0xC0000023; // STATUS_BUFFER_OVERFLOW
    for (let i = 0; i < str.length; i++) emu.memory.writeU8(strPtr + i, str.charCodeAt(i));
    emu.memory.writeU8(strPtr + str.length, 0);
    return 0; // STATUS_SUCCESS
  });

  // RtlInitUnicodeString: init UNICODE_STRING from LPCWSTR
  // void RtlInitUnicodeString(PUNICODE_STRING DestinationString, PCWSTR SourceString)
  ntdll.register('RtlInitUnicodeString', 2, () => {
    const dest = emu.readArg(0);
    const src = emu.readArg(1);
    if (!src) {
      emu.memory.writeU16(dest, 0);     // Length
      emu.memory.writeU16(dest + 2, 0); // MaximumLength
      emu.memory.writeU32(dest + 4, 0); // Buffer
    } else {
      const str = emu.memory.readUTF16String(src);
      const byteLen = str.length * 2;
      emu.memory.writeU16(dest, byteLen);         // Length (bytes, no null)
      emu.memory.writeU16(dest + 2, byteLen + 2); // MaximumLength
      emu.memory.writeU32(dest + 4, src);          // Buffer
    }
    return 0;
  });

  // RtlAnsiStringToUnicodeString: convert ANSI_STRING to UNICODE_STRING
  // NTSTATUS RtlAnsiStringToUnicodeString(PUNICODE_STRING Dest, PCANSI_STRING Src, BOOLEAN AllocateDestinationString)
  ntdll.register('RtlAnsiStringToUnicodeString', 3, () => {
    const destPtr = emu.readArg(0);
    const srcPtr = emu.readArg(1);
    const allocDest = emu.readArg(2) & 0xFF;
    const srcLen = emu.memory.readU16(srcPtr);       // Length in bytes
    const srcBuf = emu.memory.readU32(srcPtr + 4);   // Buffer pointer
    // Read ANSI string
    let str = '';
    for (let i = 0; i < srcLen; i++) {
      const ch = emu.memory.readU8(srcBuf + i);
      if (ch === 0) break;
      str += String.fromCharCode(ch);
    }
    const uniByteLen = str.length * 2;
    let uniBuf: number;
    if (allocDest) {
      uniBuf = emu.allocHeap(uniByteLen + 2);
    } else {
      uniBuf = emu.memory.readU32(destPtr + 4);
    }
    for (let i = 0; i < str.length; i++) emu.memory.writeU16(uniBuf + i * 2, str.charCodeAt(i));
    emu.memory.writeU16(uniBuf + uniByteLen, 0);
    emu.memory.writeU16(destPtr, uniByteLen);          // Length
    emu.memory.writeU16(destPtr + 2, uniByteLen + 2);  // MaximumLength
    emu.memory.writeU32(destPtr + 4, uniBuf);           // Buffer
    return 0; // STATUS_SUCCESS
  });

  // RtlUnicodeStringToInteger: convert UNICODE_STRING to ULONG
  // NTSTATUS RtlUnicodeStringToInteger(PCUNICODE_STRING String, ULONG Base, PULONG Value)
  ntdll.register('RtlUnicodeStringToInteger', 3, () => {
    const strPtr = emu.readArg(0);
    const base = emu.readArg(1) || 10;
    const valuePtr = emu.readArg(2);
    const len = emu.memory.readU16(strPtr);       // Length in bytes
    const buf = emu.memory.readU32(strPtr + 4);   // Buffer pointer
    let str = '';
    for (let i = 0; i < len; i += 2) {
      const ch = emu.memory.readU16(buf + i);
      if (ch === 0) break;
      str += String.fromCharCode(ch);
    }
    str = str.trim();
    const val = parseInt(str, base) || 0;
    emu.memory.writeU32(valuePtr, val >>> 0);
    return 0; // STATUS_SUCCESS
  });

  // RtlFreeUnicodeString: free a UNICODE_STRING allocated by Rtl* functions
  ntdll.register('RtlFreeUnicodeString', 1, () => {
    // We don't track heap frees precisely, just zero the struct
    const strPtr = emu.readArg(0);
    emu.memory.writeU16(strPtr, 0);
    emu.memory.writeU16(strPtr + 2, 0);
    emu.memory.writeU32(strPtr + 4, 0);
    return 0;
  });

  // NTDLL CRT memory ops
  ntdll.register('memmove', 0, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    const len = emu.readArg(2);
    if (len > 0 && dst !== src) {
      const tmp = new Uint8Array(len);
      for (let i = 0; i < len; i++) tmp[i] = emu.memory.readU8(src + i);
      for (let i = 0; i < len; i++) emu.memory.writeU8(dst + i, tmp[i]);
    }
    return dst;
  });

  ntdll.register('isspace', 0, () => {
    const ch = emu.readArg(0);
    // space, tab, newline, vertical tab, form feed, carriage return
    return (ch === 0x20 || (ch >= 0x09 && ch <= 0x0D)) ? 1 : 0;
  });

  // RtlOemToUnicodeN(UnicodeString, MaxBytesInUnicodeString, BytesInUnicodeString, OemString, BytesInOemString)
  ntdll.register('RtlOemToUnicodeN', 5, () => {
    const uniPtr = emu.readArg(0);
    const maxBytes = emu.readArg(1);
    const bytesOutPtr = emu.readArg(2);
    const oemPtr = emu.readArg(3);
    const oemLen = emu.readArg(4);
    // Simple ASCII→UTF-16 conversion
    const outLen = Math.min(oemLen * 2, maxBytes);
    for (let i = 0; i < oemLen && i * 2 + 1 < maxBytes; i++) {
      emu.memory.writeU16(uniPtr + i * 2, emu.memory.readU8(oemPtr + i));
    }
    if (bytesOutPtr) emu.memory.writeU32(bytesOutPtr, outLen);
    return 0; // STATUS_SUCCESS
  });

  // RtlMultiByteToUnicodeN(UnicodeString, MaxBytesInUnicodeString, BytesInUnicodeString, MultiByteString, BytesInMultiByteString)
  ntdll.register('RtlMultiByteToUnicodeN', 5, () => {
    const uniPtr = emu.readArg(0);
    const maxBytes = emu.readArg(1);
    const bytesOutPtr = emu.readArg(2);
    const mbPtr = emu.readArg(3);
    const mbLen = emu.readArg(4);
    const maxChars = maxBytes >>> 1;
    const count = Math.min(mbLen, maxChars);
    for (let i = 0; i < count; i++) {
      emu.memory.writeU16(uniPtr + i * 2, emu.memory.readU8(mbPtr + i));
    }
    if (bytesOutPtr) emu.memory.writeU32(bytesOutPtr, count * 2);
    return 0; // STATUS_SUCCESS
  });

  // NTDLL heap APIs — same semantics as HeapAlloc/HeapFree/HeapReAlloc/HeapSize
  ntdll.register('RtlAllocateHeap', 3, () => {
    const _hHeap = emu.readArg(0);
    const flags = emu.readArg(1);
    const size = emu.readArg(2);
    const HEAP_ZERO_MEMORY = 0x00000008;
    const ptr = emu.allocHeap(size);
    if (ptr && (flags & HEAP_ZERO_MEMORY)) {
      for (let i = 0; i < size; i++) emu.memory.writeU8(ptr + i, 0);
    }
    return ptr;
  });
  ntdll.register('RtlFreeHeap', 3, () => 1);
  ntdll.register('RtlReAllocateHeap', 4, () => {
    const _hHeap = emu.readArg(0);
    const _flags = emu.readArg(1);
    const ptr = emu.readArg(2);
    const size = emu.readArg(3);
    return emu.reallocHeap(ptr, size);
  });
  ntdll.register('RtlSizeHeap', 3, () => {
    const _hHeap = emu.readArg(0);
    const _flags = emu.readArg(1);
    const ptr = emu.readArg(2);
    return emu.heapSize(ptr);
  });

  ntdll.register('NtClose', 1, () => 0); // STATUS_SUCCESS
  ntdll.register('NtOpenThread', 4, () => {
    // Write a pseudo-handle to the out-pointer
    const handlePtr = emu.readArg(0);
    if (handlePtr) emu.memory.writeU32(handlePtr, emu.handles.alloc('thread', {}));
    return 0;
  });
  ntdll.register('RtlTimeToElapsedTimeFields', 2, () => {
    const outPtr = emu.readArg(1);
    if (outPtr) {
      // TIME_FIELDS: 8 USHORTs = 16 bytes, write zeroes
      for (let i = 0; i < 16; i += 2) emu.memory.writeU16(outPtr + i, 0);
    }
    return 0;
  });

  // NtOpenProcessToken(ProcessHandle, DesiredAccess, TokenHandle) → NTSTATUS
  ntdll.register('NtOpenProcessToken', 3, () => {
    const tokenPtr = emu.readArg(2);
    if (tokenPtr) emu.memory.writeU32(tokenPtr, 0x3000); // pseudo token handle
    return 0; // STATUS_SUCCESS
  });

  // RtlAllocateAndInitializeSid(IdentifierAuthority, SubAuthorityCount, ..., Sid) → NTSTATUS
  ntdll.register('RtlAllocateAndInitializeSid', 11, () => {
    const sidPtr = emu.readArg(10);
    if (sidPtr) {
      const fakeSid = emu.allocHeap(28);
      emu.memory.writeU32(fakeSid, 0x01010000);
      emu.memory.writeU32(sidPtr, fakeSid);
    }
    return 0; // STATUS_SUCCESS
  });

  // NtQueryInformationToken(TokenHandle, TokenInformationClass, TokenInformation, TokenInformationLength, ReturnLength) → NTSTATUS
  ntdll.register('NtQueryInformationToken', 5, () => {
    const retLenPtr = emu.readArg(4);
    if (retLenPtr) emu.memory.writeU32(retLenPtr, 0);
    return 0xC0000001; // STATUS_UNSUCCESSFUL — caller handles gracefully
  });

  // RtlFreeSid(Sid) → PVOID (NULL on success)
  ntdll.register('RtlFreeSid', 1, () => 0);

  // RtlEqualSid(Sid1, Sid2) → BOOLEAN
  ntdll.register('RtlEqualSid', 2, () => 0); // not equal

  // RtlUnwind(TargetFrame, TargetIp, ExceptionRecord, ReturnValue) → void
  ntdll.register('RtlUnwind', 4, () => 0);

  // NtQueryInformationProcess(ProcessHandle, ProcessInformationClass, ProcessInformation, ProcessInformationLength, ReturnLength) → NTSTATUS
  const STATUS_SUCCESS = 0;
  const STATUS_INFO_LENGTH_MISMATCH = 0xC0000004;
  const ProcessBasicInformation = 0;
  const ProcessDebugPort = 7;
  const ProcessWow64Information = 26;
  const ProcessDebugObjectHandle = 30;
  const ProcessDebugFlags = 31;
  ntdll.register('NtQueryInformationProcess', 5, () => {
    const hProcess = emu.readArg(0);
    const infoClass = emu.readArg(1);
    const infoBuf = emu.readArg(2);
    const infoLen = emu.readArg(3);
    const retLenPtr = emu.readArg(4);
    console.log(`[NTDLL] NtQueryInformationProcess handle=0x${hProcess.toString(16)} class=${infoClass} buf=0x${infoBuf.toString(16)} len=${infoLen}`);
    switch (infoClass) {
      case ProcessBasicInformation: {
        // PROCESS_BASIC_INFORMATION: 24 bytes
        // { ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId }
        const size = 24;
        if (infoLen < size) return STATUS_INFO_LENGTH_MISMATCH;
        const teb = emu.cpu.fsBase;
        const peb = emu.memory.readU32(teb + 0x30);
        emu.memory.writeU32(infoBuf + 0, 0);       // ExitStatus = STATUS_PENDING
        emu.memory.writeU32(infoBuf + 4, peb);      // PebBaseAddress
        emu.memory.writeU32(infoBuf + 8, 1);        // AffinityMask
        emu.memory.writeU32(infoBuf + 12, 8);       // BasePriority (NORMAL)
        emu.memory.writeU32(infoBuf + 16, 1234);    // UniqueProcessId (matches GetCurrentProcessId)
        emu.memory.writeU32(infoBuf + 20, 0);       // InheritedFromUniqueProcessId
        if (retLenPtr) emu.memory.writeU32(retLenPtr, size);
        return STATUS_SUCCESS;
      }
      case 1: { // ProcessQuotaLimits → QUOTA_LIMITS (28 bytes on 32-bit)
        // { PagedPoolLimit, NonPagedPoolLimit, MinimumWorkingSetSize, MaximumWorkingSetSize, PagefileLimit, TimeLimit(i64) }
        const size = 28;
        if (infoLen < size) return STATUS_INFO_LENGTH_MISMATCH;
        emu.memory.writeU32(infoBuf + 0, 0x20000000);   // PagedPoolLimit (512 MB)
        emu.memory.writeU32(infoBuf + 4, 0x01000000);   // NonPagedPoolLimit (16 MB)
        emu.memory.writeU32(infoBuf + 8, 0x00032000);   // MinimumWorkingSetSize (200 KB)
        emu.memory.writeU32(infoBuf + 12, 0x08000000);  // MaximumWorkingSetSize (128 MB)
        emu.memory.writeU32(infoBuf + 16, 0x20000000);  // PagefileLimit (512 MB)
        emu.memory.writeU32(infoBuf + 20, 0);            // TimeLimit low (no limit)
        emu.memory.writeU32(infoBuf + 24, 0);            // TimeLimit high
        if (retLenPtr) emu.memory.writeU32(retLenPtr, size);
        return STATUS_SUCCESS;
      }
      case ProcessDebugPort: {
        // Returns DWORD_PTR: 0 = not being debugged
        if (infoLen < 4) return STATUS_INFO_LENGTH_MISMATCH;
        emu.memory.writeU32(infoBuf, 0);
        if (retLenPtr) emu.memory.writeU32(retLenPtr, 4);
        return STATUS_SUCCESS;
      }
      case ProcessWow64Information: {
        // Returns ULONG_PTR: 0 = not WoW64
        if (infoLen < 4) return STATUS_INFO_LENGTH_MISMATCH;
        emu.memory.writeU32(infoBuf, 0);
        if (retLenPtr) emu.memory.writeU32(retLenPtr, 4);
        return STATUS_SUCCESS;
      }
      case ProcessDebugObjectHandle: {
        // Not being debugged — return STATUS_PORT_NOT_SET
        return 0xC0000353;
      }
      case ProcessDebugFlags: {
        // Returns ULONG: 1 = no debugger
        if (infoLen < 4) return STATUS_INFO_LENGTH_MISMATCH;
        emu.memory.writeU32(infoBuf, 1);
        if (retLenPtr) emu.memory.writeU32(retLenPtr, 4);
        return STATUS_SUCCESS;
      }
      default:
        console.warn(`[NTDLL] NtQueryInformationProcess: unhandled class ${infoClass}`);
        return STATUS_SUCCESS;
    }
  });

  // NtSetInformationProcess(ProcessHandle, ProcessInformationClass, ProcessInformation, ProcessInformationLength) → NTSTATUS
  ntdll.register('NtSetInformationProcess', 4, () => {
    const hProcess = emu.readArg(0);
    const infoClass = emu.readArg(1);
    console.log(`[NTDLL] NtSetInformationProcess handle=0x${hProcess.toString(16)} class=${infoClass}`);
    return STATUS_SUCCESS;
  });

  // VDMDBG stubs
  const vdmdbg = emu.registerDll('VDMDBG.DLL');
  // VDMTerminateTaskWOW(dwProcessId, wTask) → BOOL
  vdmdbg.register('VDMTerminateTaskWOW', 2, () => 0); // fail
  // VDMEnumTaskWOWEx(dwProcessId, lpEnumFunc, lParam) → INT
  vdmdbg.register('VDMEnumTaskWOWEx', 3, () => 0); // no tasks

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

      // Level 3: Language — prefer English (0x0409) or neutral (0x0000), fallback to first
      const dir3 = base + (off2 & 0x7FFFFFFF);
      const numNamed3 = emu.memory.readU16(dir3 + 12);
      const numId3 = emu.memory.readU16(dir3 + 14);
      const totalLangs = numNamed3 + numId3;

      if (totalLangs > 0) {
        let bestIdx = 0; // default to first entry
        for (let k = 0; k < totalLangs; k++) {
          const langId = emu.memory.readU32(dir3 + 16 + k * 8);
          if (langId === 0x0409 || (langId & 0x3FF) === 0x09) { bestIdx = k; break; } // English
          if (langId === 0) { bestIdx = k; } // neutral
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
