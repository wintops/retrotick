import { Memory } from './memory';
import { CPU } from './x86/cpu';
import type { LoadedPE } from './pe-loader';
import type { LoadedNE, NEResourceEntry } from './ne-loader';
import { HandleTable } from './win32/handles';
import type { DCInfo, BitmapInfo, PenInfo, BrushInfo } from './win32/gdi32/index';
import type { WindowInfo, WndClassInfo } from './win32/user32/index';
import type { TreeViewItem, ListViewColumn, ListViewItem } from './win32/user32/types';
import type { PEInfo, MenuItem } from '../pe/types';
import type { GL1Context } from './win32/gl-context';
import type { RegistryStore } from '../registry-store';
import { DefaultFileManager } from './file-manager';
import { VGAState, isVGAPort } from './dos/vga';
import { DosAudio } from './dos/audio';
import type { FileManager } from './file-manager';
import { renderChildControls as _renderChildControls, notifyControlOverlays as _notifyControlOverlays } from './emu-render';
import { getDC as _getDC, getWindowDC as _getWindowDC, promoteToMainWindow as _promoteToMainWindow, setupCanvasSize as _setupCanvasSize, beginPaint as _beginPaint, endPaint as _endPaint, syncDCToCanvas as _syncDCToCanvas, releaseChildDC as _releaseChildDC, dispatchToSehHandler as _dispatchToSehHandler, getBrush as _getBrush, getPen as _getPen, loadBitmapResource as _loadBitmapResource, loadBitmapResourceFromModule as _loadBitmapResourceFromModule, loadBitmapResourceByName as _loadBitmapResourceByName, loadCursorResourceByName as _loadCursorResourceByName, loadStringResource as _loadStringResource, loadIconResource as _loadIconResource } from './emu-window';
import { emuLoad, emuFindResourceEntry } from './emu-load';
import { emuTick, emuCallWndProc, emuCallWndProc16, emuCallNative } from './emu-exec';
import { Thread } from './thread';

export { fillTextBitmap } from './emu-render';
export { Thread } from './thread';
export type { FileManager } from './file-manager';
export { DefaultFileManager } from './file-manager';

export interface WinMsg {
  hwnd: number;
  message: number;
  wParam: number;
  lParam: number;
}

export interface DialogControlInfo {
  id: number;
  className: string;
  text: string;
  style: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CommonDialogRequest =
  | { type: 'about'; caption: string; extraInfo: string; otherText: string; onDismiss: () => void };

export interface DialogInfo {
  title: string;
  style: number;
  width: number;
  height: number;
  hwnd: number;
  controls: DialogControlInfo[];
  overlays: ControlOverlay[];
  controlValues: Map<number, string>;
}

export interface ControlOverlay {
  controlId: number;
  childHwnd: number;
  className: string;
  /** For superclassed controls: the base built-in class (e.g. "EDIT" for Delphi's "TEDIT") */
  baseClassName?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: number;
  exStyle: number;
  title: string;
  checked: number;
  fontHeight: number;
  trackPos: number;
  trackMin: number;
  trackMax: number;
  treeItems?: TreeViewItem[];
  treeSelectedItem?: number;
  treeImageUrls?: (string | undefined)[];
  lbItems?: string[];
  lbSelectedIndex?: number;
  lbSelectedIndices?: number[];
  cbItems?: string[];
  cbSelectedIndex?: number;
  listColumns?: ListViewColumn[];
  listItems?: ListViewItem[];
  statusTexts?: string[];
  tabItems?: { text: string }[];
  tabSelectedIndex?: number;
  bgColor?: string;
}

// Detect fullwidth characters (CJK, fullwidth forms, etc.) that occupy 2 console columns
export function isFullwidth(cp: number): boolean {
  // CJK Radicals Supplement..Enclosed CJK Letters
  if (cp >= 0x2E80 && cp <= 0x33FF) return true;
  // CJK Compatibility..CJK Unified Ideographs Extension A
  if (cp >= 0x3400 && cp <= 0x4DBF) return true;
  // CJK Unified Ideographs
  if (cp >= 0x4E00 && cp <= 0x9FFF) return true;
  // Hangul Syllables
  if (cp >= 0xAC00 && cp <= 0xD7AF) return true;
  // CJK Compatibility Ideographs
  if (cp >= 0xF900 && cp <= 0xFAFF) return true;
  // Fullwidth Forms (Fullwidth ASCII, Halfwidth Katakana excluded)
  if (cp >= 0xFF01 && cp <= 0xFF60) return true;
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return true;
  // CJK extensions B-F, Compatibility Supplement
  if (cp >= 0x20000 && cp <= 0x2FA1F) return true;
  return false;
}

// Global cascading default position for CW_USEDEFAULT (shared across all instances)
// Offset matches Windows classic theme: caption height (19) + frame (4) ≈ 23px
const CASCADE_OFFSET = 23;
const CASCADE_START_X = 23;
const CASCADE_START_Y = 23;
const cascadePos = { x: CASCADE_START_X, y: CASCADE_START_Y };

/** Get next cascading position and advance. Resets when too close to bottom-right. */
export function getNextCascadePos(screenWidth: number, screenHeight: number): { x: number; y: number } {
  const { x, y } = cascadePos;
  // Reset if too close to bottom-right (leave room for at least 200x200 visible area)
  if (x + 200 > screenWidth || y + 200 > screenHeight) {
    cascadePos.x = CASCADE_START_X;
    cascadePos.y = CASCADE_START_Y;
  } else {
    cascadePos.x += CASCADE_OFFSET;
    cascadePos.y += CASCADE_OFFSET;
  }
  return { x, y };
}

export interface ProcessEntry {
  pid: number;
  name: string;
  threadCount: number;
  basePriority: number;
  handleCount: number;
  workingSetSize: number;   // bytes
  cpuTime: number;          // ms
}

export interface WindowEntry {
  hwnd: number;
  title: string;
  pid: number;
  visible: boolean;
}

export class ProcessRegistry {
  private nextPid = 100;
  private entries = new Map<number, ProcessEntry>();
  private emulators = new Map<number, Emulator>();

  register(emu: Emulator, exeName: string): number {
    const pid = this.nextPid;
    this.nextPid += 4; // Windows PIDs are multiples of 4
    emu.pid = pid;
    emu.exeName = exeName;
    if (!emu.exePath) {
      const name = exeName.replaceAll('/', '\\');
      if (name.includes('\\')) {
        emu.exePath = /^[A-Za-z]:/.test(name) ? name : 'D:\\' + name;
      } else {
        const cwd = emu.currentDirs.get('D') || 'D:\\';
        emu.exePath = cwd.endsWith('\\') ? cwd + name : cwd + '\\' + name;
      }
    }
    this.entries.set(pid, {
      pid,
      name: exeName,
      threadCount: 1,
      basePriority: 8,
      handleCount: 0,
      workingSetSize: 0,
      cpuTime: 0,
    });
    this.emulators.set(pid, emu);
    return pid;
  }

  unregister(pid: number): void {
    this.entries.delete(pid);
    this.emulators.delete(pid);
  }

  /** Get all processes (entries + live stats from emulators) */
  getProcessList(): ProcessEntry[] {
    const result: ProcessEntry[] = [];
    for (const [pid, entry] of this.entries) {
      const emu = this.emulators.get(pid);
      if (emu) {
        entry.handleCount = emu.handles.size();
        entry.workingSetSize = (emu.heapPtr - emu.heapBase + emu.virtualPtr - emu.virtualBase) || 0;
        entry.cpuTime = emu.cpuTimeMs;
      }
      result.push(entry);
    }
    return result;
  }

  /** Get all visible top-level windows across all emulators */
  getWindowList(): WindowEntry[] {
    const result: WindowEntry[] = [];
    for (const [pid, emu] of this.emulators) {
      if (emu.mainWindow) {
        const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
        if (wnd && wnd.title) {
          result.push({ hwnd: emu.mainWindow, title: wnd.title, pid, visible: wnd.visible !== false });
        }
      }
    }
    return result;
  }
}

export interface WindowsVersion {
  major: number;
  minor: number;
  build: number;
  platformId: number; // VER_PLATFORM_WIN32_NT = 2
}

export const WINDOWS_2000: WindowsVersion = { major: 5, minor: 0, build: 2195, platformId: 2 };
export const WINDOWS_XP: WindowsVersion = { major: 5, minor: 1, build: 2600, platformId: 2 };

export interface ApiDef {
  handler: (emu: Emulator) => number | undefined;
  stackBytes: number;    // callee pops this many bytes (0 for cdecl/x64)
}

export class Win32Dll {
  constructor(private emu: Emulator, private dll: string) {}

  register(name: string, nArgs: number, handler: (emu: Emulator) => number | undefined): void {
    const key = `${this.dll}:${name}`;
    if (this.emu.apiDefs.has(key)) {
      throw new Error(`Win32Dll.register: duplicate API definition for ${key}`);
    }
    const wrapped = (emu: Emulator) => {
      return handler(emu);
    };
    this.emu.apiDefs.set(key, { handler: wrapped, stackBytes: nArgs * 4 });
  }
}

export class Win16Module {
  constructor(private emu: Emulator, private module: string) {}

  register(name: string, stackBytes: number, handler: (emu: Emulator) => number | undefined): void {
    const key = `${this.module}:${name}`;
    if (this.emu.apiDefs.has(key)) {
      throw new Error(`Win16Module.register: duplicate API definition for ${key}`);
    }
    const wrapped = (emu: Emulator) => {
      return handler(emu);
    };
    this.emu.apiDefs.set(key, { handler: wrapped, stackBytes });
  }
}

export class Emulator {
  memory = new Memory();
  cpu: CPU;
  handles = new HandleTable();
  canvas: HTMLCanvasElement | null = null;
  canvasCtx: CanvasRenderingContext2D | null = null;
  currentCursor = 0; // handle of current cursor
  glContext: GL1Context | null = null;

  windowsVersion: WindowsVersion = WINDOWS_2000;
  registryStore?: RegistryStore;

  pe!: LoadedPE;
  peInfo!: PEInfo;
  arrayBuffer!: ArrayBuffer;

  // Console (CUI) mode
  isConsole = false;
  consoleBuffer: { char: number; attr: number }[] = [];
  consoleCursorX = 0;
  consoleCursorY = 0;
  consoleAttr = 0x07; // light gray on black
  consoleCursorSize = 25;
  consoleCursorVisible = true;
  consoleTitle = '';
  consoleMode = 0x0003; // ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT
  consoleInputMode = 0x0003;
  consoleInputBuffer: { char: number; vk: number; scan: number }[] = [];
  onConsoleOutput?: () => void;
  onConsoleTitleChange?: () => void;
  _pendingReadConsole: { bufPtr: number; nCharsToRead: number; charsReadPtr: number } | null = null;
  _pendingReadConsoleInput: { bufPtr: number; nLength: number; eventsReadPtr: number; isWide: boolean } | null = null;
  _dispatchPaintUsedBeginPaint = false;
  _pendingGetch = false;
  _consoleInputResume: { stackBytes: number; completer: (emu: Emulator, retVal: number, stackBytes: number) => void } | null = null;
  // Line editing state (emulates conhost line editing for ReadConsoleW with ENABLE_LINE_INPUT)
  _lineEditBuffer: number[] = [];
  _lineEditCursor = 0;
  _lineEditStartX = 0;
  _lineEditStartY = 0;
  _commandHistory: number[][] = [];
  _commandHistoryIndex = -1;

  // NE (16-bit) mode
  isNE = false;
  ne?: LoadedNE;
  _arrayBuffer?: ArrayBuffer;

  // DOS (MZ) mode
  isDOS = false;
  dosKeyBuffer: { ascii: number; scan: number }[] = [];
  _dosWaitingForKey: false | 'read' | 'peek' = false;
  _dosPendingSoftwareIret = 0;
  _dosKeyConsumedThisTick = false;
  _dosHwKeyReadThisTick = false;
  _dosDTA = 0;
  _dosPSP = 0;
  _dosLoadSegment = 0;
  _dosFiles = new Map<number, { data: Uint8Array; pos: number; name: string }>();
  _dosNextHandle = 5; // 0-4 are stdin/stdout/stderr/stdaux/stdprn
  _dosExeData: Uint8Array | null = null; // raw executable bytes for self-open
  _dosIntVectors = new Map<number, number>();
  _dosBiosDefaultVectors = new Map<number, number>();
  _dosLoLAddr = 0;
  _dosImageSize = 0;
  _dosMcbFirstSeg = 0;
  _dosFindState: { entries: { name: string; size: number; isDir: boolean }[]; index: number; pattern: string } | null = null;
  _dosFileOpenPending = false;
  _dosLastTimerTick = 0;
  _dosHalted = false;
  _dosVerifyFlag = false;
  _dosInDOSAddr = 0;
  /** I/O port data (for IN/OUT instructions) */
  _ioPorts = new Map<number, number>();
  /** Pending hardware interrupts to fire at next tick */
  _pendingHwInts: number[] = [];

  // PIC (Programmable Interrupt Controller) state
  _picMasterMask = 0x00;  // IMR: 0 = enabled, 1 = masked
  _picSlaveMask = 0x00;
  _picMasterICW = 0;      // ICW sequence counter (0 = ready for OCW)
  _picSlaveICW = 0;

  // PIT (Programmable Interval Timer) state
  _pitCounters = [0xFFFF, 0x0012, 0xFFFF]; // Counter 0/1/2 reload values
  _pitLatched = [false, false, false];
  _pitLatchValues = [0, 0, 0];
  _pitReadHigh = [false, false, false];     // Byte toggle for 16-bit reads
  _pitModes = [3, 2, 3];                   // Counter modes (default: mode 3 for 0/2, mode 2 for 1)
  _pitAccessModes = [3, 3, 3];             // 1=LSB, 2=MSB, 3=LSB then MSB
  _pitWriteHigh = [false, false, false];    // Byte toggle for 16-bit writes

  // VGA state
  vga = new VGAState();
  videoMode = 0x03;
  screenCols = 80;
  screenRows = 25;
  charHeight = 16;
  isGraphicsMode = false;
  onVideoFrame?: () => void;

  // API dispatch
  apiDefs = new Map<string, ApiDef>();
  thunkToApi = new Map<number, { dll: string; name: string; stackBytes: number }>();
  // Fast page-level filter: set of (addr >>> 12) for all thunk addresses.
  // If the page isn't in this set, we skip the Map lookup entirely.
  thunkPages = new Set<number>();

  registerDll(dll: string): Win32Dll { return new Win32Dll(this, dll); }
  registerModule16(module: string): Win16Module { return new Win16Module(this, module); }

  // Screen dimensions (set by UI to browser viewport size)
  screenWidth = 800;
  screenHeight = 600;


  // Command line arguments (e.g. "/s" for screensavers)
  commandLine = '';

  // Additional DLL files available for LoadLibrary (name → ArrayBuffer)
  additionalFiles = new Map<string, ArrayBuffer>();
  /** Pluggable virtual file system (D:\, Z:\) */
  fs: FileManager = new DefaultFileManager();
  /** Per-process current drive (uppercase letter). Win32 + DOS both use this. */
  currentDrive = 'D';
  /** Per-process current directory per drive. Win32 + DOS both use this. */
  currentDirs = new Map<string, string>([['C', 'C:\\WINDOWS\\SYSTEM32'], ['D', 'D:\\']]);
  /** Resolve a path using per-process current drive/directory, then delegate to fs. */
  resolvePath(input: string): string {
    // Temporarily sync emu→fs so fs.resolvePath uses our per-process state
    const savedDrive = this.fs.currentDrive;
    const savedDirs = new Map(this.fs.currentDirs);
    this.fs.currentDrive = this.currentDrive;
    this.fs.currentDirs = this.currentDirs;
    try {
      return this.fs.resolvePath(input);
    } finally {
      this.fs.currentDrive = savedDrive;
      this.fs.currentDirs = savedDirs;
    }
  }
  /** Size of the loaded exe file (for dir listing) */
  exeFileSize = 0;
  /** Environment variable store (uppercase key → value), shared by kernel32 and msvcrt */
  envVars = new Map<string, string>([
    ['COMSPEC',                  'C:\\WINDOWS\\SYSTEM32\\CMD.EXE'],
    ['PATH',                     'C:\\WINDOWS\\SYSTEM32;C:\\WINDOWS;C:\\WINDOWS\\SYSTEM32\\WBEM'],
    ['PATHEXT',                  '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'],
    ['SYSTEMROOT',               'C:\\WINDOWS'],
    ['SYSTEMDRIVE',              'C:'],
    ['WINDIR',                   'C:\\WINDOWS'],
    ['TEMP',                     'C:\\WINDOWS\\TEMP'],
    ['TMP',                      'C:\\WINDOWS\\TEMP'],
    ['HOMEDRIVE',                'C:'],
    ['HOMEPATH',                 '\\'],
    ['USERPROFILE',              'C:\\'],
    ['USERNAME',                 'User'],
    ['USERDOMAIN',               'WORKGROUP'],
    ['COMPUTERNAME',             'MYCOMPUTER'],
    ['OS',                       'Windows_NT'],
    ['NUMBER_OF_PROCESSORS',     '1'],
    ['PROCESSOR_ARCHITECTURE',   'x86'],
    ['PROCESSOR_IDENTIFIER',     'x86 Family 6 Model 8 Stepping 3, GenuineIntel'],
    ['PROCESSOR_LEVEL',          '6'],
    ['PROCESSOR_REVISION',       '0803'],
    ['PROGRAMFILES',             'C:\\Program Files'],
    ['COMMONPROGRAMFILES',       'C:\\Program Files\\Common Files'],
    ['PROMPT',                   '$P$G'],
  ]);
  // Loaded DLL modules: dllName → module info
  loadedModules = new Map<string, { base: number; resourceRva: number; imageBase: number; sizeOfImage?: number }>();
  // Dynamic thunk allocator (for GetProcAddress on loaded DLLs)
  dynamicThunkPtr = 0;

  // State
  running = false;
  halted = false;
  _crashFired = false;
  _wpEscapeLogged = false;
  haltReason = '';
  exitedNormally = false;
  exitCode = 0;
  stopped = false;
  _sysmsgTablesAddr = 0;
  _perfCounter = 0;

  // Threading
  threads: Thread[] = [];
  currentThread: Thread | null = null;
  nextThreadId = 1;
  // Compatibility getters/setters that delegate to currentThread
  private _fallbackWaitingForMessage = false;
  get waitingForMessage(): boolean {
    return this.currentThread ? this.currentThread.waitingForMessage : this._fallbackWaitingForMessage;
  }
  set waitingForMessage(v: boolean) {
    if (this.currentThread) this.currentThread.waitingForMessage = v;
    else this._fallbackWaitingForMessage = v;
  }

  get messageQueue(): WinMsg[] {
    return this.currentThread ? this.currentThread.messageQueue : this._fallbackMessageQueue;
  }
  set messageQueue(v: WinMsg[]) {
    if (this.currentThread) this.currentThread.messageQueue = v;
    else this._fallbackMessageQueue = v;
  }
  private _fallbackMessageQueue: WinMsg[] = [];

  get _onMessageAvailable(): (() => void) | null {
    return this.currentThread ? this.currentThread._onMessageAvailable : null;
  }
  set _onMessageAvailable(v: (() => void) | null) {
    if (this.currentThread) this.currentThread._onMessageAvailable = v;
  }

  get wndProcDepth(): number {
    return this.currentThread ? this.currentThread.wndProcDepth : 0;
  }
  set wndProcDepth(v: number) {
    if (this.currentThread) this.currentThread.wndProcDepth = v;
  }

  get wndProcResult(): number {
    return this.currentThread ? this.currentThread.wndProcResult : 0;
  }
  set wndProcResult(v: number) {
    if (this.currentThread) this.currentThread.wndProcResult = v;
  }

  get _currentThunkStackBytes(): number {
    return this.currentThread ? this.currentThread._currentThunkStackBytes : 0;
  }
  set _currentThunkStackBytes(v: number) {
    if (this.currentThread) this.currentThread._currentThunkStackBytes = v;
  }

  get _wndProcSetupPending(): boolean {
    return this.currentThread ? this.currentThread._wndProcSetupPending : false;
  }
  set _wndProcSetupPending(v: boolean) {
    if (this.currentThread) this.currentThread._wndProcSetupPending = v;
  }

  get _wndProcFrames(): Array<{
    savedEBX: number; savedEBP: number; savedESI: number; savedEDI: number;
    savedDS?: number; savedSP?: number;
    outerStackBytes: number;
    outerCompleter: (emu: Emulator, retVal: number, stackBytes: number) => void;
  }> {
    return this.currentThread ? this.currentThread._wndProcFrames : [];
  }
  set _wndProcFrames(v: Array<{
    savedEBX: number; savedEBP: number; savedESI: number; savedEDI: number;
    savedDS?: number; savedSP?: number;
    outerStackBytes: number;
    outerCompleter: (emu: Emulator, retVal: number, stackBytes: number) => void;
  }>) {
    if (this.currentThread) this.currentThread._wndProcFrames = v;
  }

  // Window system
  mainWindow = 0;
  capturedWindow = 0;
  focusedWindow = 0;
  // GL sync-yield guard: avoid double-yield when apps call both glFinish and SwapBuffers per frame.
  glSyncYieldedThisFrame = false;
  glSyncAwaitingSwap = false;
  keyStates = new Set<number>(); // Currently pressed virtual key codes
  configuredLcid = 0x0409; // Set from regional settings at load time
  windowDCs = new Map<number, number>();
  private timers = new Map<string, number>();

  // CBT hooks (WH_CBT = 5)
  cbtHooks: { lpfn: number; hMod: number }[] = [];

  // Window class registry
  windowClasses = new Map<string, WndClassInfo>();
  atomToClassName = new Map<number, string>();
  nextClassAtom = 0xC001;

  // GDI helpers set by registerGdi32
  getStockBrush!: (idx: number) => BrushInfo | null;
  getStockPen!: (idx: number) => PenInfo | null;

  // Dedup set for GetProcAddress "Not found" warnings
  _gpaNotFound?: Set<string>;

  // Heap allocator
  heapBase = 0;
  heapPtr = 0;
  heapAllocSizes = new Map<number, number>();

  // NE local heap (within data segment)
  localHeapBase = 0;  // linear address of local heap start
  localHeapPtr = 0;   // current allocation pointer
  localHeapEnd = 0;   // linear address of local heap end

  // Per-segment local heaps (selector → {ptr, end})
  segLocalHeaps = new Map<number, { ptr: number; end: number }>();

  // NE DLL resources (for LoadBitmap etc. to search across DLLs)
  neDllResources: Array<{ resources: NEResourceEntry[]; arrayBuffer: ArrayBuffer }> = [];

  // Virtual allocator
  virtualBase = 0;
  virtualPtr = 0;

  // WndProc call stack (wndProcResult, wndProcDepth, _currentThunkStackBytes,
  // _wndProcSetupPending, _wndProcFrames are now getter/setters delegating to currentThread)
  _tickCount = 0;
  _lastThunkTick = 0;
  /** Cumulative x86 instruction count (thunks weighted ~1000 each) */
  cpuSteps = 0;
  /** Cumulative CPU time in ms (derived from cpuSteps assuming ~500MHz effective clock) */
  get cpuTimeMs(): number { return this.cpuSteps * 0.000002 * 1000; }

  // SEH dispatch state
  _sehState: {
    excRecAddr: number;
    ctxAddr: number;
    currentReg: number;
    dispCtxAddr: number;
  } | null = null;

  drawItemStructAddr = 0;


  // Screen dirty flag — set by GDI draw ops that write to screen DC,
  // checked by tick() to yield to browser for rendering intermediate frames
  screenDirty = false;

  // Resource caches
  stringCache = new Map<number, string>();
  bitmapCache = new Map<number, number>();
  bitmapNameCache?: Map<string, number>;

  // Audio
  audioContext?: AudioContext;
  dosAudio = new DosAudio();

  // Generic common dialog request — UI renders the appropriate dialog
  onShowCommonDialog?: (req: CommonDialogRequest) => void;

  // Callbacks for UI
  onMenu?: (menuId: number) => void;
  onWindowChange?: (wnd: WindowInfo) => void;
  onShowDialog?: (info: DialogInfo) => void;
  onCloseDialog?: () => void;
  onControlsChanged?: (controls: ControlOverlay[]) => void;
  onMenuChanged?: () => void;
  onCrash?: (eip: string, description: string) => void;
  onExit?: () => void;
  onCreateProcess?: (exeName: string, commandLine: string) => void;
  onCreateChildConsole?: (exeName: string, commandLine: string, hProcess: number) => void;

  _childProcessWaiting = false;
  _childProcessResume: { stackBytes: number; retVal: number; completer: (emu: Emulator, stackBytes: number, retVal: number) => void } | null = null;
  /** Callback to show browser file picker (open/save). Returns file info or null if cancelled. */
  onFileDialog?: (type: 'open' | 'save', filter?: string, title?: string) => Promise<{ name: string; data: ArrayBuffer } | null>;
  menuItems?: MenuItem[];

  // Shared process registry (set by host to share across emulator instances)
  processRegistry?: ProcessRegistry;
  /** PID assigned to this emulator instance */
  pid = 0;
  /** EXE name for this instance (e.g. "taskmgr.exe") */
  exeName = '';
  /** Full path of the loaded EXE (e.g. "D:\\subdir\\some.exe"), set at load time */
  exePath = '';

  // Dialog state — stack supports nested dialogs
  dialogState: {
    hwnd: number;
    dlgProc: number;
    info: DialogInfo;
    result: number;
    ended: boolean;
  } | null = null;
  _dialogResolve: ((result: number) => void) | null = null;
  _dialogPumpTimer: ReturnType<typeof setInterval> | null = null;
  _dialogStack: Array<{
    dialogState: NonNullable<Emulator['dialogState']>;
    resolve: ((result: number) => void) | null;
    pumpTimer: ReturnType<typeof setInterval> | null;
  }> = [];

  // MessageBox state — supports multiple simultaneous message boxes
  messageBoxes: { id: number; caption: string; text: string; type: number; onDismiss: (result: number) => void }[] = [];
  _nextMessageBoxId = 1;
  onShowMessageBox?: (id: number, caption: string, text: string, type: number) => void;

  _endDialog(result: number): void {
    if (this._dialogPumpTimer !== null) { clearInterval(this._dialogPumpTimer); this._dialogPumpTimer = null; }
    const resolve = this._dialogResolve;
    this._dialogResolve = null;
    const wnd = this.dialogState ? this.handles.get(this.dialogState.hwnd) : null;
    if (wnd) this.handles.free(this.dialogState!.hwnd);
    // Pop outer dialog from stack (if any)
    const outer = this._dialogStack.pop();
    if (outer) {
      this.dialogState = outer.dialogState;
      this._dialogResolve = outer.resolve;
      this._dialogPumpTimer = outer.pumpTimer;
      // Re-show outer dialog in UI
      this.onShowDialog?.(outer.dialogState.info);
    } else {
      this.dialogState = null;
      this.onCloseDialog?.();
    }
    // Defer resolve so that if EndDialog is called from inside the dialog pump's
    // callWndProc (where ESP is in a nested frame), the pump can restore EIP/ESP
    // to the original DialogBoxParam stack frame before emuCompleteThunk runs.
    if (resolve) queueMicrotask(() => resolve(result));
  }

  dismissDialog(action: number, updatedValues: Map<number, string>): void {
    if (!this.dialogState) return;
    // Merge user-edited values into both controlValues and child window titles
    for (const [id, val] of updatedValues) {
      this.dialogState.info.controlValues.set(id, val);
      const dlgWnd = this.handles.get<WindowInfo>(this.dialogState.hwnd);
      if (dlgWnd?.children) {
        const childHwnd = dlgWnd.children.get(id);
        if (childHwnd) {
          const child = this.handles.get<WindowInfo>(childHwnd);
          if (child) child.title = val;
        }
      }
    }

    // Send WM_COMMAND to the dialog so the app can read values and call EndDialog.
    // This is what Windows does when the user clicks a button — the dialog proc
    // handles WM_COMMAND/IDOK, calls GetDlgItemInt/GetDlgItemText, then EndDialog.
    const ds = this.dialogState;
    if (!ds.ended) {
      const dlgWnd = this.handles.get<WindowInfo>(ds.hwnd);
      const wndProc = dlgWnd?.wndProc || ds.dlgProc;
      if (wndProc) {
        const WM_COMMAND = 0x0111;
        const savedEIP = this.cpu.eip;
        const savedESP = this.cpu.reg[4];
        const savedWaiting = this.waitingForMessage;
        this.waitingForMessage = false;
        const buttonHwnd = dlgWnd?.children?.get(action) ?? 0;
        if (this.ne) {
          // Win16: wParam = controlId, lParam = MAKELONG(hwndCtl, BN_CLICKED=0)
          this.callWndProc16(wndProc, ds.hwnd, WM_COMMAND, action, buttonHwnd & 0xFFFF);
        } else {
          // Win32: wParam = MAKEWPARAM(controlId, BN_CLICKED=0); lParam = button hwnd
          this.callWndProc(wndProc, ds.hwnd, WM_COMMAND, action, buttonHwnd);
        }
        this.cpu.eip = savedEIP;
        this.cpu.reg[4] = savedESP;
        this.waitingForMessage = savedWaiting;
      }
    }

    // If the app's dlgProc called EndDialog during WM_COMMAND, ds.ended is true
    // but _endDialog hasn't been called yet (EndDialog only sets the flag).
    // If the dlgProc didn't call EndDialog, force it ourselves.
    if (!ds.ended) {
      ds.result = action;
      ds.ended = true;
    }
    this._endDialog(ds.result);
  }

  /** Show a MessageBox — onDismiss is called synchronously when user dismisses it. */
  showMessageBox(caption: string, text: string, type: number, onDismiss: (result: number) => void): void {
    const id = this._nextMessageBoxId++;
    this.messageBoxes.push({ id, caption, text, type, onDismiss });
    this.onShowMessageBox?.(id, caption, text, type);
  }

  dismissMessageBox(id: number, result: number): void {
    const idx = this.messageBoxes.findIndex(mb => mb.id === id);
    if (idx < 0) return;
    const mb = this.messageBoxes[idx];
    this.messageBoxes.splice(idx, 1);
    mb.onDismiss(result);
  }

  constructor() {
    this.cpu = new CPU(this.memory);
    // Pre-allocate a default IDC_ARROW cursor so currentCursor is never 0
    this.currentCursor = this.handles.alloc('cursor', { css: 'default' });
  }

  initConsoleBuffer(): void {
    const size = this.screenCols * this.screenRows;
    this.consoleBuffer = new Array(size);
    for (let i = 0; i < size; i++) {
      this.consoleBuffer[i] = { char: 0x20, attr: 0x07 };
    }
    this.consoleCursorX = 0;
    this.consoleCursorY = 0;
  }

  consoleWriteChar(ch: number): void {
    if (ch === 0x0D) { // \r
      this.consoleCursorX = 0;
      return;
    }
    if (ch === 0x0A) { // \n
      this.consoleCursorX = 0;
      this.consoleCursorY++;
      if (this.consoleCursorY >= 25) this.consoleScrollUp();
      return;
    }
    if (ch === 0x08) { // backspace
      if (this.consoleCursorX > 0) this.consoleCursorX--;
      return;
    }
    if (ch === 0x07) return; // bell
    if (ch === 0x09) { // tab
      const next = (this.consoleCursorX + 8) & ~7;
      this.consoleCursorX = Math.min(next, 79);
      return;
    }
    const wide = isFullwidth(ch);
    // Fullwidth char needs 2 columns; if only 1 left, wrap to next line
    if (wide && this.consoleCursorX >= 79) {
      this.consoleCursorX = 0;
      this.consoleCursorY++;
      if (this.consoleCursorY >= 25) this.consoleScrollUp();
    }
    const idx = this.consoleCursorY * 80 + this.consoleCursorX;
    if (idx >= 0 && idx < this.consoleBuffer.length) {
      this.consoleBuffer[idx] = { char: ch, attr: this.consoleAttr };
    }
    this.consoleCursorX++;
    if (wide) {
      // Write trailing cell marker (char=0 signals "continuation of fullwidth char")
      const idx2 = this.consoleCursorY * 80 + this.consoleCursorX;
      if (idx2 >= 0 && idx2 < this.consoleBuffer.length) {
        this.consoleBuffer[idx2] = { char: 0, attr: this.consoleAttr };
      }
      this.consoleCursorX++;
    }
    if (this.consoleCursorX >= 80) {
      this.consoleCursorX = 0;
      this.consoleCursorY++;
      if (this.consoleCursorY >= 25) this.consoleScrollUp();
    }
  }

  consoleScrollUp(): void {
    for (let i = 0; i < 80 * 24; i++) {
      this.consoleBuffer[i] = this.consoleBuffer[i + 80];
    }
    for (let i = 80 * 24; i < 80 * 25; i++) {
      this.consoleBuffer[i] = { char: 0x20, attr: this.consoleAttr };
    }
    this.consoleCursorY = 24;
  }

  // Delegated to emu-load.ts
  load(arrayBuffer: ArrayBuffer, peInfo: PEInfo, canvas: HTMLCanvasElement): void {
    this._arrayBuffer = arrayBuffer;
    emuLoad(this, arrayBuffer, peInfo, canvas);
  }

  findResourceEntry(typeId: number | string, nameId: number | string): { dataRva: number; dataSize: number } | null {
    return emuFindResourceEntry(this, typeId, nameId);
  }

  // NE local heap allocation (returns offset within data segment)
  allocLocal(size: number): number {
    if (size === 0) size = 1;
    const aligned = (size + 3) & ~3;

    // Check if current DS has a per-segment local heap
    const ds = this.cpu.ds;
    const segHeap = this.segLocalHeaps.get(ds);
    if (segHeap) {
      let addr = segHeap.ptr;
      if (addr + aligned > segHeap.end) {
        // Expand heap end within the 64KB segment space
        const segBase = this.cpu.segBases.get(ds) ?? 0;
        if ((addr + aligned - segBase) > 0x10000) return 0;
        segHeap.end = addr + aligned;
      }
      segHeap.ptr += aligned;
      for (let i = 0; i < aligned; i++) this.memory.writeU8(addr + i, 0);
      // Return offset within segment (not low 16 bits of linear address)
      const segBase = this.cpu.segBases.get(ds) ?? 0;
      return (addr - segBase) & 0xFFFF;
    }

    // Fall back to default DGROUP local heap
    const addr = this.localHeapPtr;
    if (addr + aligned > this.localHeapEnd) {
      // Auto-grow heap within the 64KB segment, like Windows 3.x
      // If SS == DS, heap must not collide with stack (grows down from top)
      const dsBase = this.ne ? (this.cpu.segBases.get(this.cpu.ds) ?? 0) : 0;
      let maxEnd = dsBase + 0x10000;
      if (this.ne) {
        const ssBase = this.cpu.segBases.get(this.cpu.ss) ?? 0;
        if (ssBase === dsBase && this.ne.stackSize > 0) {
          // Stack bottom = stackTop - stackSize; leave 256-byte guard
          const stackBottom = this.ne.stackTop - this.ne.stackSize;
          maxEnd = Math.min(maxEnd, stackBottom - 256);
        }
      }
      if (addr + aligned > maxEnd) return 0; // truly out of memory
      this.localHeapEnd = addr + aligned;
    }
    this.localHeapPtr += aligned;
    for (let i = 0; i < aligned; i++) this.memory.writeU8(addr + i, 0);
    return addr & 0xFFFF; // return offset within segment
  }

  // Public API for kernel32 heap
  allocHeap(size: number): number {
    if (size === 0) size = 1;
    const aligned = (size + 7) & ~7;
    const addr = this.heapPtr;
    this.heapPtr += aligned;
    for (let i = 0; i < aligned; i++) this.memory.writeU8(addr + i, 0);
    this.heapAllocSizes.set(addr, size);
    return addr;
  }

  /** Allocate on a 64KB-aligned boundary so the full 64KB segment is usable for local heap */
  allocHeap64K(size: number): number {
    if (size === 0) size = 1;
    // Align heapPtr up to 64KB boundary
    const aligned64K = (this.heapPtr + 0xFFFF) & ~0xFFFF;
    this.heapPtr = aligned64K + Math.max(size, 0x10000);
    for (let i = 0; i < size; i++) this.memory.writeU8(aligned64K + i, 0);
    this.heapAllocSizes.set(aligned64K, size);
    return aligned64K;
  }

  reallocHeap(oldAddr: number, newSize: number): number {
    if (oldAddr === 0) return this.allocHeap(newSize);
    const oldSize = this.heapAllocSizes.get(oldAddr) || 0;
    const newAddr = this.allocHeap(newSize);
    if (oldSize > 0) {
      const copyLen = Math.min(oldSize, newSize);
      for (let i = 0; i < copyLen; i++) {
        this.memory.writeU8(newAddr + i, this.memory.readU8(oldAddr + i));
      }
    }
    return newAddr;
  }

  heapSize(addr: number): number {
    return this.heapAllocSizes.get(addr) || 0;
  }

  allocVirtual(requestedAddr: number, size: number): number {
    if (size === 0) size = 0x1000;
    const alignedSize = (size + 0xFFF) & ~0xFFF;
    let addr: number;
    if (requestedAddr !== 0) {
      addr = (requestedAddr + 0xFFF) & ~0xFFF;
    } else {
      addr = this.virtualPtr;
      this.virtualPtr = (this.virtualPtr + alignedSize + 0xFFF) & ~0xFFF;
    }
    for (let i = 0; i < alignedSize; i++) this.memory.writeU8(addr + i, 0);
    this.heapAllocSizes.set(addr, alignedSize);
    return addr >>> 0;
  }

  // Read stdcall argument from stack
  readArg(index: number): number {
    return this.memory.readU32((this.cpu.reg[4] + 4 + index * 4) >>> 0);
  }

  // NE (16-bit) support methods
  readArg16(byteOffset: number): number {
    const base = this.cpu.segBase(this.cpu.ss);
    const sp = this.cpu.reg[4] & 0xFFFF;
    return this.memory.readU16((base + sp + 4 + byteOffset) >>> 0);
  }

  readArg16DWord(byteOffset: number): number {
    const base = this.cpu.segBase(this.cpu.ss);
    const sp = this.cpu.reg[4] & 0xFFFF;
    return this.memory.readU32((base + sp + 4 + byteOffset) >>> 0);
  }

  /** Resolve a raw far pointer (offset:segment packed as U32) to a linear address */
  resolveFarPtr(raw: number): number {
    const off = raw & 0xFFFF;
    const seg = (raw >>> 16) & 0xFFFF;
    if (!seg) return off;
    return (this.cpu.segBases.get(seg) ?? (seg * 16)) + off;
  }

  /** Read a far pointer arg from the 16-bit stack and resolve to linear address */
  readArg16FarPtr(byteOffset: number): number {
    return this.resolveFarPtr(this.readArg16DWord(byteOffset));
  }

  readPascalArgs16(sizes: number[]): number[] {
    const result: number[] = new Array(sizes.length);
    let offset = 0;
    for (let i = sizes.length - 1; i >= 0; i--) {
      if (sizes[i] === 4) {
        result[i] = this.readArg16DWord(offset);
      } else {
        result[i] = this.readArg16(offset);
      }
      offset += sizes[i];
    }
    return result;
  }

  loadNEString(uID: number): string {
    if (!this.ne) return '';
    const blockID = Math.floor(uID / 16) + 1;
    const indexInBlock = uID % 16;
    const entry = this.ne.resources.find(r => r.typeID === 6 && r.id === blockID);
    if (!entry) return '';
    const data = new Uint8Array(this.arrayBuffer, entry.fileOffset, entry.length);
    let off = 0;
    for (let i = 0; i < indexInBlock; i++) {
      if (off >= data.length) return '';
      off += 1 + data[off];
    }
    if (off >= data.length) return '';
    const len = data[off];
    let str = '';
    for (let j = 0; j < len && off + 1 + j < data.length; j++) {
      str += String.fromCharCode(data[off + 1 + j]);
    }
    return str;
  }

  postMessage(hwnd: number, message: number, wParam: number, lParam: number): void {
    // Route to the thread that owns the target window
    let targetThread = this.currentThread;
    if (hwnd && this.threads.length > 1) {
      const wnd = this.handles.get<WindowInfo>(hwnd);
      if (wnd?.ownerThreadId) {
        const ownerThread = this.threads.find(t => t.id === wnd.ownerThreadId);
        if (ownerThread) targetThread = ownerThread;
      }
    }

    const queue = targetThread ? targetThread.messageQueue : this.messageQueue;
    const onAvail = targetThread ? targetThread._onMessageAvailable : this._onMessageAvailable;

    if (message === 0x0113) { // WM_TIMER
      console.log(`[POST] WM_TIMER hwnd=0x${hwnd.toString(16)} wParam=${wParam} lParam=0x${lParam.toString(16)} waiting=${this.waitingForMessage} qLen=${queue.length}`);
      if (queue.some(m => m.message === 0x0113 && m.hwnd === hwnd && m.wParam === wParam)) {
        return;
      }
    }
    queue.push({ hwnd, message, wParam, lParam });
    if (onAvail) {
      if (targetThread) targetThread._onMessageAvailable = null;
      else this._onMessageAvailable = null;
      onAvail();
    }
  }

  // Timer management
  setWin32Timer(hwnd: number, id: number, jsTimer: number): void {
    this.timers.set(`${hwnd}:${id}`, jsTimer);
  }

  clearWin32Timer(hwnd: number, id: number): void {
    const key = `${hwnd}:${id}`;
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(key);
    }
  }

  // Thread management
  switchToThread(target: Thread): void {
    if (this.currentThread && this.currentThread !== target) {
      this.currentThread.saveFromCPU(this.cpu);
    }
    target.loadToCPU(this.cpu);
    this.currentThread = target;
  }

  getNextRunnableThread(): Thread | null {
    if (this.threads.length === 0) return null;
    const currentIdx = this.currentThread ? this.threads.indexOf(this.currentThread) : -1;
    for (let i = 1; i <= this.threads.length; i++) {
      const idx = (currentIdx + i) % this.threads.length;
      const t = this.threads[idx];
      if (!t.exited && !t.suspended && !t.waitingForMessage) return t;
    }
    return null;
  }

  allThreadsWaiting(): boolean {
    return this.threads.every(t => t.exited || t.suspended || t.waitingForMessage);
  }

  createThread(startAddr: number, param: number, stackSize: number): Thread {
    const actualStackSize = stackSize || 0x100000; // default 1MB
    const stackBase = this.allocVirtual(0, actualStackSize);
    const stackTop = (stackBase + actualStackSize) >>> 0;

    // Create initial state from current CPU (inherits segments, mode, etc.)
    const state = Thread.createInitialState(this.cpu);
    state.eip = startAddr;
    state.reg = new Int32Array(8); // fresh registers
    state.reg[4] = stackTop; // ESP

    const thread = new Thread(this.nextThreadId++, state);
    thread.startAddress = startAddr;
    thread.parameter = param;
    thread.stackTop = stackTop;

    // Push parameter and a halt-sentinel return address onto the new thread's stack
    const THREAD_EXIT_THUNK = 0x00FD0004;
    // Ensure the thunk exists
    if (!this.thunkToApi.has(THREAD_EXIT_THUNK)) {
      this.thunkToApi.set(THREAD_EXIT_THUNK, { dll: 'SYSTEM', name: 'THREAD_EXIT', stackBytes: 0 });
      this.thunkPages.add(THREAD_EXIT_THUNK >>> 12);
      this.apiDefs.set('SYSTEM:THREAD_EXIT', {
        handler: () => {
          if (this.currentThread) {
            this.currentThread.exited = true;
            this.currentThread.exitCode = this.cpu.reg[0]; // EAX
          }
          // Switch to next runnable thread
          const next = this.getNextRunnableThread();
          if (next) {
            this.switchToThread(next);
          } else {
            // All threads done
            this.exitedNormally = true;
            this.halted = true;
          }
          return undefined;
        },
        stackBytes: 0,
      });
    }

    // Set up stack: push param, then return address (THREAD_EXIT_THUNK)
    state.reg[4] -= 4;
    this.memory.writeU32(state.reg[4] >>> 0, param);
    state.reg[4] -= 4;
    this.memory.writeU32(state.reg[4] >>> 0, THREAD_EXIT_THUNK);

    this.threads.push(thread);
    return thread;
  }

  // Delegated to extracted modules
  getDC(hdc: number): DCInfo | null { return _getDC(this, hdc); }
  promoteToMainWindow(hwnd: number, wnd: WindowInfo): void { _promoteToMainWindow(this, hwnd, wnd); }
  setupCanvasSize(cw: number, ch: number): void { _setupCanvasSize(this, cw, ch); }
  getWindowDC(hwnd: number): number { return _getWindowDC(this, hwnd); }
  beginPaint(hwnd: number): number { return _beginPaint(this, hwnd); }
  endPaint(hwnd: number, hdc: number): void { _endPaint(this, hwnd, hdc); }
  renderChildControls(hwnd: number): void { _renderChildControls(this, hwnd); }
  repaintChildWindows(hwnd: number): void {
    const wnd = this.handles.get<WindowInfo>(hwnd);
    if (!wnd?.childList) return;
    const WM_PAINT = 0x000F;
    for (const childHwnd of wnd.childList) {
      const child = this.handles.get<WindowInfo>(childHwnd);
      if (!child || !child.visible || !child.wndProc) continue;
      child.needsPaint = true;
      this.callWndProc(child.wndProc, childHwnd, WM_PAINT, 0, 0);
      child.needsPaint = false;
    }
  }
  notifyControlOverlays(): void { _notifyControlOverlays(this); }
  syncDCToCanvas(hdc: number): void { _syncDCToCanvas(this, hdc); }
  releaseChildDC(hdc: number): void { _releaseChildDC(this, hdc); }
  dispatchToSehHandler(frameAddr: number): void { _dispatchToSehHandler(this, frameAddr); }
  getBrush(handle: number): BrushInfo | null { return _getBrush(this, handle); }
  getPen(handle: number): PenInfo | null { return _getPen(this, handle); }
  loadBitmapResource(resourceId: number): number { return _loadBitmapResource(this, resourceId); }
  loadBitmapResourceFromModule(hInstance: number, resourceId: number): number { return _loadBitmapResourceFromModule(this, hInstance, resourceId); }
  loadBitmapResourceByName(name: string): number { return _loadBitmapResourceByName(this, name); }
  loadCursorResourceByName(name: string): number { return _loadCursorResourceByName(this, name); }
  loadStringResource(id: number): string | null { return _loadStringResource(this, id); }
  loadIconResource(resourceId: number): number { return _loadIconResource(this, resourceId); }

  // Delegated to emu-exec.ts
  callWndProc(wndProc: number, hwnd: number, message: number, wParam: number, lParam: number): number | undefined {
    return emuCallWndProc(this, wndProc, hwnd, message, wParam, lParam);
  }

  callWndProc16(wndProc: number, hwnd: number, message: number, wParam: number, lParam: number): number | undefined {
    return emuCallWndProc16(this, wndProc, hwnd, message, wParam, lParam);
  }

  callNative(addr: number): number | undefined {
    return emuCallNative(this, addr);
  }

  /** Resolve a pending console input wait (ReadConsoleW, ReadConsoleInput, _getch, WaitForSingleObject stdin) */
  deliverConsoleInput(retVal: number): void {
    if (this._consoleInputResume) {
      const { stackBytes, completer } = this._consoleInputResume;
      this._consoleInputResume = null;
      this.waitingForMessage = false;
      completer(this, retVal, stackBytes);
      if (this.running && !this.halted) {
        requestAnimationFrame(this.tick);
      }
    }
  }

  /** Read an I/O port value */
  portIn(port: number): number {
    if (isVGAPort(port)) return this.vga.portRead(port);
    // Audio ports (AdLib, Sound Blaster)
    const audioVal = this.dosAudio.portIn(port);
    if (audioVal >= 0) return audioVal;
    switch (port) {
      case 0x20: // PIC master — ISR/IRR (simplified: return 0)
        return 0;
      case 0x21: // PIC master IMR
        return this._picMasterMask;
      case 0xA0: // PIC slave — ISR/IRR
        return 0;
      case 0xA1: // PIC slave IMR
        return this._picSlaveMask;
      case 0x40: case 0x41: case 0x42: { // PIT counter read
        const ch = port - 0x40;
        if (this._pitLatched[ch]) {
          // Return latched value
          const val = this._pitLatchValues[ch];
          const accessMode = this._pitAccessModes[ch];
          if (accessMode === 3) { // LSB then MSB
            if (!this._pitReadHigh[ch]) {
              this._pitReadHigh[ch] = true;
              return val & 0xFF;
            } else {
              this._pitReadHigh[ch] = false;
              this._pitLatched[ch] = false;
              return (val >> 8) & 0xFF;
            }
          } else if (accessMode === 1) { // LSB only
            this._pitLatched[ch] = false;
            return val & 0xFF;
          } else { // MSB only
            this._pitLatched[ch] = false;
            return (val >> 8) & 0xFF;
          }
        }
        // Not latched: return running counter estimate
        // Use performance.now() to derive a rough counter value
        const freq = 1193182; // PIT base frequency
        const reload = this._pitCounters[ch] || 0x10000;
        const elapsed = (performance.now() * 1000) % (reload * 1000000 / freq);
        const count = (reload - Math.floor(elapsed * freq / 1000000)) & 0xFFFF;
        const accessMode = this._pitAccessModes[ch];
        if (accessMode === 1) return count & 0xFF;
        if (accessMode === 2) return (count >> 8) & 0xFF;
        if (!this._pitReadHigh[ch]) {
          this._pitReadHigh[ch] = true;
          return count & 0xFF;
        } else {
          this._pitReadHigh[ch] = false;
          return (count >> 8) & 0xFF;
        }
      }
      case 0x60: {
        const status = this._ioPorts.get(0x64) ?? 0;
        if ((status & 0x01) !== 0) {
          // Real 8042 behavior: first read consumes output buffer.
          const value = this._ioPorts.get(0x60) ?? 0xFF;
          this._ioPorts.set(0x64, status & ~0x01);
          // Compatibility replay for chained BIOS INT 09h handler.
          this._kbdReplayValue = value;
          this._kbdReplayPending = true;
          this._kbdDataReadsLeft = 1;
          if (this.isDOS) this._dosHwKeyReadThisTick = true;
          return value;
        }
        // Allow one extra read while IRQ1 handler is in-flight for chained
        // handlers that both read port 0x60 (hook + BIOS).
        if (this._kbdReplayPending && this._int09ReturnCS >= 0 && this._kbdDataReadsLeft > 0) {
          this._kbdDataReadsLeft--;
          if (this.isDOS) this._dosHwKeyReadThisTick = true;
          return this._kbdReplayValue;
        }
        return 0xFF;
      }
      case 0x61: { // System control port B
        const val = this._ioPorts.get(0x61) ?? 0;
        // Bit 4: toggles with refresh cycles (programs use for timing)
        // Bit 5: timer 2 output (speaker gate)
        return val ^ 0x10; // Toggle refresh bit on each read
      }
      case 0x64: // Keyboard controller status
        return this._ioPorts.get(0x64) ?? 0;
      default:
        return this._ioPorts.get(port) ?? 0xFF;
    }
  }

  /** Write to an I/O port */
  portOut(port: number, value: number): void {
    if (isVGAPort(port)) {
      this.vga.portWrite(port, value);
      return;
    }
    // Audio ports (AdLib, Sound Blaster)
    if (this.dosAudio.portOut(port, value)) return;
    switch (port) {
      case 0x20: // PIC master command
        if (value === 0x20) break; // EOI — acknowledged
        if (value & 0x10) this._picMasterICW = 1; // ICW1 starts init sequence
        break;
      case 0x21: // PIC master data (IMR or ICW2-4)
        if (this._picMasterICW > 0) {
          this._picMasterICW++; // Consume ICW2, ICW3, ICW4
          if (this._picMasterICW > 4) this._picMasterICW = 0;
        } else {
          this._picMasterMask = value;
        }
        break;
      case 0xA0: // PIC slave command
        if (value === 0x20) break; // EOI
        if (value & 0x10) this._picSlaveICW = 1;
        break;
      case 0xA1: // PIC slave data (IMR or ICW2-4)
        if (this._picSlaveICW > 0) {
          this._picSlaveICW++;
          if (this._picSlaveICW > 4) this._picSlaveICW = 0;
        } else {
          this._picSlaveMask = value;
        }
        break;
      case 0x40: case 0x41: case 0x42: { // PIT counter write
        const ch = port - 0x40;
        const accessMode = this._pitAccessModes[ch];
        if (accessMode === 1) { // LSB only
          this._pitCounters[ch] = (this._pitCounters[ch] & 0xFF00) | value;
        } else if (accessMode === 2) { // MSB only
          this._pitCounters[ch] = (this._pitCounters[ch] & 0x00FF) | (value << 8);
        } else { // LSB then MSB
          if (!this._pitWriteHigh[ch]) {
            this._pitCounters[ch] = (this._pitCounters[ch] & 0xFF00) | value;
            this._pitWriteHigh[ch] = true;
          } else {
            this._pitCounters[ch] = (this._pitCounters[ch] & 0x00FF) | (value << 8);
            this._pitWriteHigh[ch] = false;
          }
        }
        // Update PC speaker when PIT channel 2 changes
        if (ch === 2 && this.isDOS) {
          this.dosAudio.updateSpeaker(this._ioPorts.get(0x61) ?? 0, this._pitCounters[2] || 0x10000);
        }
        break;
      }
      case 0x43: { // PIT control word
        const ch = (value >> 6) & 3;
        if (ch === 3) {
          // Read-back command (just latch all requested counters)
          for (let i = 0; i < 3; i++) {
            if (!(value & (2 << i))) continue; // Counter not selected
            if (!(value & 0x20)) { // Latch count
              this._pitLatched[i] = true;
              const reload = this._pitCounters[i] || 0x10000;
              const freq = 1193182;
              const elapsed = (performance.now() * 1000) % (reload * 1000000 / freq);
              this._pitLatchValues[i] = (reload - Math.floor(elapsed * freq / 1000000)) & 0xFFFF;
            }
          }
          break;
        }
        const accessMode = (value >> 4) & 3;
        if (accessMode === 0) {
          // Latch command
          this._pitLatched[ch] = true;
          const reload = this._pitCounters[ch] || 0x10000;
          const freq = 1193182;
          const elapsed = (performance.now() * 1000) % (reload * 1000000 / freq);
          this._pitLatchValues[ch] = (reload - Math.floor(elapsed * freq / 1000000)) & 0xFFFF;
        } else {
          this._pitAccessModes[ch] = accessMode;
          this._pitModes[ch] = (value >> 1) & 7;
          this._pitWriteHigh[ch] = false;
          this._pitReadHigh[ch] = false;
          this._pitLatched[ch] = false;
        }
        break;
      }
      default:
        this._ioPorts.set(port, value);
        // Update PC speaker when port 0x61 changes
        if (port === 0x61 && this.isDOS) {
          this.dosAudio.updateSpeaker(value, this._pitCounters[2] || 0x10000);
        }
        break;
    }
  }

  // Extended scancodes that need 0xE0 prefix (arrows, Home/End/PgUp/PgDn, Ins/Del)
  static readonly E0_SCANCODES = new Set([
    0x47, 0x48, 0x49, // Home, Up, PgUp
    0x4B, 0x4D,       // Left, Right
    0x4F, 0x50, 0x51, // End, Down, PgDn
    0x52, 0x53,       // Ins, Del
  ]);

  /** Inject a hardware keyboard event: write scancode to port 0x60 and trigger INT 09h */
  injectHwKey(scancode: number, browserChar?: number): void {
    // Queue all scancodes for sequential delivery — writing directly to port 0x60
    // would lose earlier scancodes when multiple keys are injected in the same JS event.
    this._pendingHwKeys.push(scancode);
    if (browserChar !== undefined) this._pendingHwKeyChars.set(scancode, browserChar);
    // Wake promptly on keyboard input from INT 16h waits or DOS HLT idle.
    if ((this.waitingForMessage || this._dosHalted) && this.running && !this.halted) {
      this.waitingForMessage = false;
      this._dosHalted = false;
      requestAnimationFrame(this.tick);
    }
  }
  _pendingHwKeys: number[] = [];
  _pendingHwKeyChars = new Map<number, number>();
  _currentHwKeyChar: number | undefined;
  _kbdE0Prefix = false;
  _hwKeyDelay = 0;
  _kbdDataReadsLeft = 0;
  _kbdReplayPending = false;
  _kbdReplayValue = 0xFF;
  _int09ReturnCS = -1; // CS of return address for active INT 09h; -1 = not active
  _int09ReturnIP = 0;

  /** Deliver a DOS key for INT 16h blocking wait */
  /** Write a key into the BDA keyboard buffer (for programs that read it directly) */
  writeBdaKey(ascii: number, scan: number): void {
    const BDA = 0x400;
    const bufStart = this.memory.readU16(BDA + 0x80) || 0x1E;
    const bufEnd = this.memory.readU16(BDA + 0x82) || 0x3E;
    const tail = this.memory.readU16(BDA + 0x1C);
    let newTail = tail + 2;
    if (newTail >= bufEnd) newTail = bufStart;
    const head = this.memory.readU16(BDA + 0x1A);
    if (newTail === head) return; // buffer full
    this.memory.writeU16(BDA + tail, (scan << 8) | ascii);
    this.memory.writeU16(BDA + 0x1C, newTail);
  }

  deliverDosKey(): void {
    if (this._dosWaitingForKey && this.dosKeyBuffer.length > 0) {
      const mode = this._dosWaitingForKey;
      this._dosWaitingForKey = false;
      if (mode === 'peek') {
        // AH=01/11: peek — don't consume, set ZF=false, put key in AX
        const key = this.dosKeyBuffer[0];
        this.cpu.setReg16(0, (key.scan << 8) | key.ascii);
        this.cpu.setFlags(this.cpu.getFlags() & ~0x40); // clear ZF
      } else {
        // AH=00/10: read — consume key, put in AX
        const key = this.dosKeyBuffer.shift()!;
        this.cpu.setReg16(0, (key.scan << 8) | key.ascii);
      }
      this.waitingForMessage = false;
      while (this._dosPendingSoftwareIret > 0) {
        const ip = this.cpu.pop16();
        const cs = this.cpu.pop16();
        const savedFlags = this.cpu.pop16();
        const curFlags = this.cpu.getFlags() & 0xFFFF;
        const flags = (curFlags & ~0x0300) | (savedFlags & 0x0300);
        this.cpu.cs = cs;
        this.cpu.eip = this.cpu.segBase(cs) + ip;
        this.cpu.setFlags((this.cpu.getFlags() & 0xFFFF0000) | (flags & 0xFFFF));
        this._dosPendingSoftwareIret--;
      }
      if (this.running && !this.halted) {
        requestAnimationFrame(this.tick);
      }
    }
    // Also write remaining keys to BDA buffer for programs that read it directly
    for (const key of this.dosKeyBuffer) {
      this.writeBdaKey(key.ascii, key.scan);
    }
  }

  run(): void {
    console.log('[EMU] run() called');
    this.running = true;
    this.halted = false;
    this._crashFired = false;
    this.haltReason = '';
    this.tick();
  }

  stop(): void {
    this.running = false;
    this.halted = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  tick = (): void => {
    emuTick(this);
  };
}
