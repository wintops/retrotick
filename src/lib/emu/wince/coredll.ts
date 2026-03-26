import type { Emulator } from '../emulator';
import { SP as ARM_SP, LR as ARM_LR } from '../arm/cpu';
import { emuCompleteThunkARM } from '../emu-exec-arm';

/**
 * COREDLL.DLL — WinCE combined runtime.
 * Merges kernel32 + user32 + gdi32 + CRT into a single DLL.
 *
 * For Win32 API functions, we reuse the existing handlers by registering
 * them under the COREDLL.DLL namespace. For CRT functions, we implement
 * them directly since the x86 MSVCRT uses cdecl (caller-clean) while
 * ARM uses a register-based convention.
 */
export function registerCoredll(emu: Emulator): void {
  const reg = (name: string, nArgs: number, handler: (emu: Emulator) => number | undefined) => {
    emu.apiDefs.set(`COREDLL.DLL:${name}`, { handler, stackBytes: nArgs * 4 });
  };

  // ── Copy handlers from standard Win32 DLLs ──
  // GDI32 functions that are identical between Win32 and WinCE
  const alias = (name: string, dll: string, srcName?: string) => {
    const def = emu.apiDefs.get(`${dll}:${srcName ?? name}`);
    if (def) emu.apiDefs.set(`COREDLL.DLL:${name}`, def);
  };
  // GDI32
  for (const fn of [
    'CreateCompatibleDC', 'CreateCompatibleBitmap', 'SelectObject', 'DeleteObject',
    'GetObjectW', 'GetStockObject', 'SetBkMode', 'SetTextColor', 'CreateSolidBrush',
    'GetPixel', 'Rectangle', 'BitBlt', 'CreateFontIndirectW',
    'CreateDIBSection', 'CreateRectRgn', 'CombineRgn', 'GetDeviceCaps',
  ]) alias(fn, 'GDI32.DLL');
  // USER32
  for (const fn of [
    'ShowWindow', 'UpdateWindow', 'DestroyWindow', 'DefWindowProcW',
    'TranslateMessage', 'PostQuitMessage', 'SetWindowPos', 'GetWindowRect',
    'InvalidateRect', 'SetCapture', 'ReleaseCapture', 'SetWindowRgn',
    'GetClientRect', 'AdjustWindowRectEx', 'ClientToScreen', 'BringWindowToTop',
    'SetForegroundWindow', 'GetForegroundWindow', 'GetWindowLongW', 'SetWindowLongW',
    'SetWindowTextW', 'GetKeyState', 'SetCursorPos', 'LoadCursorW', 'LoadImageW',
    'UnregisterClassW', 'SetTimer', 'KillTimer',
    'DrawTextW', 'MessageBoxW', 'GetSystemMetrics',
  ]) alias(fn, 'USER32.DLL');

  // DrawFocusRect — not in x86 GDI32 registration, provide stub
  reg('DrawFocusRect', 2, () => 1);

  // ── CRT functions ──
  reg('wcscpy', 2, (emu) => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    let i = 0;
    while (true) {
      const ch = emu.memory.readU16(src + i * 2);
      emu.memory.writeU16(dst + i * 2, ch);
      if (ch === 0) break;
      i++;
    }
    return dst;
  });

  reg('wcslen', 1, (emu) => {
    const str = emu.readArg(0);
    let len = 0;
    while (emu.memory.readU16(str + len * 2) !== 0) len++;
    return len;
  });

  reg('malloc', 1, (emu) => {
    const size = emu.readArg(0);
    if (size === 0) return 0;
    return emu.allocHeap(size);
  });

  reg('free', 1, () => {
    // Just leak — heap is linear
    return 0;
  });

  reg('memset', 3, (emu) => {
    const dst = emu.readArg(0);
    const val = emu.readArg(1) & 0xFF;
    const count = emu.readArg(2);
    for (let i = 0; i < count; i++) emu.memory.writeU8(dst + i, val);
    return dst;
  });

  reg('swprintf', 0, (emu) => {
    // swprintf(wchar_t* buf, const wchar_t* fmt, ...)
    // ARM: R0=buf, R1=fmt, R2..R3+stack=args
    const buf = emu.readArg(0);
    const fmtAddr = emu.readArg(1);

    // Read format string
    let fmt = '';
    let fmtOff = 0;
    while (true) {
      const ch = emu.memory.readU16(fmtAddr + fmtOff);
      if (ch === 0) break;
      fmt += String.fromCharCode(ch);
      fmtOff += 2;
    }

    // Simple printf-style formatting
    let argIdx = 2;
    let result = '';
    for (let i = 0; i < fmt.length; i++) {
      if (fmt[i] === '%') {
        i++;
        // Parse flags and width
        let padChar = ' ';
        if (fmt[i] === '0') { padChar = '0'; i++; }
        let width = 0;
        while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') {
          width = width * 10 + (fmt.charCodeAt(i) - 48);
          i++;
        }
        const spec = fmt[i];
        const arg = emu.readArg(argIdx++);
        switch (spec) {
          case 'd': case 'i': {
            let s = (arg | 0).toString();
            while (s.length < width) s = padChar + s;
            result += s;
            break;
          }
          case 'u': {
            let s = (arg >>> 0).toString();
            while (s.length < width) s = padChar + s;
            result += s;
            break;
          }
          case 'x': case 'X': {
            let s = (arg >>> 0).toString(16);
            if (spec === 'X') s = s.toUpperCase();
            while (s.length < width) s = padChar + s;
            result += s;
            break;
          }
          case 's': {
            let sArg = '';
            let off = 0;
            while (true) {
              const ch = emu.memory.readU16(arg + off);
              if (ch === 0) break;
              sArg += String.fromCharCode(ch);
              off += 2;
            }
            result += sArg;
            break;
          }
          case 'c':
            result += String.fromCharCode(arg & 0xFFFF);
            break;
          case '%':
            result += '%';
            argIdx--;
            break;
          default:
            result += '%' + spec;
            break;
        }
      } else {
        result += fmt[i];
      }
    }

    // Write result
    for (let i = 0; i < result.length; i++) {
      emu.memory.writeU16(buf + i * 2, result.charCodeAt(i));
    }
    emu.memory.writeU16(buf + result.length * 2, 0);
    return result.length;
  });

  // ── Kernel32 functions ──
  reg('GetTickCount', 0, () => (Date.now() & 0xFFFFFFFF) >>> 0);

  // ── User32 functions ──
  reg('RegisterClassW', 1, (emu) => {
    const lpWndClass = emu.readArg(0);
    // WNDCLASSW struct layout:
    // 0: style, 4: lpfnWndProc, 8: cbClsExtra, 12: cbWndExtra,
    // 16: hInstance, 20: hIcon, 24: hCursor, 28: hbrBackground,
    // 32: lpszMenuName, 36: lpszClassName
    const style = emu.memory.readU32(lpWndClass);
    const wndProc = emu.memory.readU32(lpWndClass + 4);
    const hInstance = emu.memory.readU32(lpWndClass + 16);
    const hbrBg = emu.memory.readU32(lpWndClass + 28);
    const classNameAddr = emu.memory.readU32(lpWndClass + 36);

    let className = '';
    let off = 0;
    while (true) {
      const ch = emu.memory.readU16(classNameAddr + off);
      if (ch === 0) break;
      className += String.fromCharCode(ch);
      off += 2;
    }

    console.log(`[COREDLL] RegisterClassW: "${className}" wndProc=0x${wndProc.toString(16)}`);
    emu.windowClasses.set(className.toUpperCase(), {
      className, wndProc, style, hInstance, hbrBackground: hbrBg, hIcon: 0, hCursor: 0,
      menuName: 0, cbClsExtra: 0, cbWndExtra: emu.memory.readU32(lpWndClass + 12),
    });
    return 1; // atom
  });

  reg('CreateWindowExW', 12, (emu) => {
    const exStyle = emu.readArg(0);
    const classNameAddr = emu.readArg(1);
    const titleAddr = emu.readArg(2);
    const style = emu.readArg(3);
    // On ARM, args 4+ come from the stack
    const x = emu.readArg(4);
    const y = emu.readArg(5);
    const w = emu.readArg(6);
    const h = emu.readArg(7);
    const hParent = emu.readArg(8);
    const hMenu = emu.readArg(9);
    const hInstance = emu.readArg(10);
    const lpParam = emu.readArg(11);

    let className = '';
    if (classNameAddr < 0x10000) {
      // Atom
      className = `#${classNameAddr}`;
    } else {
      let off = 0;
      while (true) {
        const ch = emu.memory.readU16(classNameAddr + off);
        if (ch === 0) break;
        className += String.fromCharCode(ch);
        off += 2;
      }
    }

    let title = '';
    if (titleAddr) {
      let off = 0;
      while (true) {
        const ch = emu.memory.readU16(titleAddr + off);
        if (ch === 0) break;
        title += String.fromCharCode(ch);
        off += 2;
      }
    }

    console.log(`[COREDLL] CreateWindowExW: class="${className}" title="${title}" ${w}x${h} at (${x},${y}) style=0x${style.toString(16)}`);

    const WS_VISIBLE = 0x10000000;
    const CW_USEDEFAULT = 0x80000000;
    const clsInfo = emu.windowClasses.get(className.toUpperCase());
    const wndProc = clsInfo?.wndProc ?? 0;

    const hwnd = emu.handles.alloc('window', {
      hwnd: 0, // will be patched
      classInfo: clsInfo ?? { className, wndProc, style: 0, hInstance, hIcon: 0, hCursor: 0, hbrBackground: 0, menuName: 0, cbClsExtra: 0, cbWndExtra: 0 },
      wndProc,
      parent: hParent,
      x: (x >>> 0) === CW_USEDEFAULT ? 0 : x,
      y: (y >>> 0) === CW_USEDEFAULT ? 0 : y,
      width: (w >>> 0) === CW_USEDEFAULT ? 240 : w,
      height: (h >>> 0) === CW_USEDEFAULT ? 320 : h,
      style, exStyle, title,
      visible: !!(style & WS_VISIBLE),
      hMenu,
      extraBytes: new Uint8Array(clsInfo?.cbWndExtra ?? 0),
      userData: 0,
      children: new Map(),
    });

    // Promote first top-level window to main window (sets up canvas + notifies React)
    const WS_CHILD = 0x40000000;
    if (!emu.mainWindow && !(style & WS_CHILD) && w > 0 && h > 0) {
      const wnd = emu.handles.get(hwnd);
      if (wnd) {
        wnd.hwnd = hwnd;
        emu.promoteToMainWindow(hwnd, wnd);
      }
    }

    // Send WM_CREATE
    if (wndProc) {
      const WM_CREATE = 0x0001;
      emu.callWndProc(wndProc, hwnd, WM_CREATE, 0, 0);
    }

    return hwnd;
  });

  // ── WinCE-specific message loop (GetMessageW/DispatchMessageW use ARM calling) ──
  // These are NOT aliased from USER32 because the x86 versions use stdcall stack
  // conventions internally. WinCE needs custom implementations.
  const writeMsg = (emu: Emulator, lpMsg: number, msg: { hwnd: number; message: number; wParam: number; lParam: number }) => {
    emu.memory.writeU32(lpMsg, msg.hwnd);
    emu.memory.writeU32(lpMsg + 4, msg.message);
    emu.memory.writeU32(lpMsg + 8, msg.wParam);
    emu.memory.writeU32(lpMsg + 12, msg.lParam);
    emu.memory.writeU32(lpMsg + 16, Date.now() & 0xFFFFFFFF);
    emu.memory.writeU32(lpMsg + 20, 0);
    emu.memory.writeU32(lpMsg + 24, 0);
  };
  const WM_QUIT = 0x0012;

  const WM_PAINT = 0x000F;
  /** Synthesize WM_PAINT for windows with needsPaint flag set */
  const synthesizePaint = (emu: Emulator): { hwnd: number; message: number; wParam: number; lParam: number } | null => {
    for (const [h, wnd] of emu.handles.findByType('window') as [number, any][]) {
      if (wnd?.needsPaint && wnd.wndProc) {
        wnd.needsPaint = false;
        return { hwnd: h, message: WM_PAINT, wParam: 0, lParam: 0 };
      }
    }
    return null;
  };

  reg('GetMessageW', 4, (emu) => {
    const lpMsg = emu.readArg(0);
    if (emu.messageQueue.length > 0) {
      const msg = emu.messageQueue.shift()!;
      writeMsg(emu, lpMsg, msg);
      return msg.message === WM_QUIT ? 0 : 1;
    }
    // Synthesize WM_PAINT if any window needs repainting
    const paintMsg = synthesizePaint(emu);
    if (paintMsg) {
      writeMsg(emu, lpMsg, paintMsg);
      return 1;
    }
    // Queue empty — set up async wake-up callback
    emu.waitingForMessage = true;
    emu._onMessageAvailable = () => {
      const msg = emu.messageQueue.shift()!;
      writeMsg(emu, lpMsg, msg);
      emu.waitingForMessage = false;
      emuCompleteThunkARM(emu, msg.message === WM_QUIT ? 0 : 1);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    };
    return undefined;
  });

  reg('DispatchMessageW', 1, (emu) => {
    const lpMsg = emu.readArg(0);
    const hwnd = emu.memory.readU32(lpMsg);
    const message = emu.memory.readU32(lpMsg + 4);
    const wParam = emu.memory.readU32(lpMsg + 8);
    const lParam = emu.memory.readU32(lpMsg + 12);
    const wnd = emu.handles.get(hwnd);
    if (wnd?.wndProc) {
      return emu.callWndProc(wnd.wndProc, hwnd, message, wParam, lParam) ?? 0;
    }
    return 0;
  });

  reg('PostMessageW', 4, (emu) => {
    emu.messageQueue.push({
      hwnd: emu.readArg(0), message: emu.readArg(1),
      wParam: emu.readArg(2), lParam: emu.readArg(3),
    });
    return 1;
  });

  // BeginPaint / EndPaint / GetDC use the emulator's proper DC infrastructure
  reg('BeginPaint', 2, (emu) => {
    const hwnd = emu.readArg(0);
    const lpPaint = emu.readArg(1);
    const hdc = emu.beginPaint(hwnd);
    const wnd = emu.handles.get(hwnd);
    if (lpPaint) {
      emu.memory.writeU32(lpPaint, hdc);
      emu.memory.writeU32(lpPaint + 4, 1);
      emu.memory.writeU32(lpPaint + 8, 0);
      emu.memory.writeU32(lpPaint + 12, 0);
      emu.memory.writeU32(lpPaint + 16, wnd?.width ?? emu.screenWidth);
      emu.memory.writeU32(lpPaint + 20, wnd?.height ?? emu.screenHeight);
    }
    return hdc;
  });

  reg('EndPaint', 2, (emu) => {
    emu.endPaint(emu.readArg(0), 0);
    return 1;
  });

  reg('GetDC', 1, (emu) => emu.getWindowDC(emu.readArg(0)));
  reg('ReleaseDC', 2, () => 1);

  reg('LoadBitmapW', 2, (emu) => {
    const hInstance = emu.readArg(0);
    const resourceId = emu.readArg(1);
    if (resourceId < 0x10000) return emu.loadBitmapResource(resourceId);
    // String resource name — read wide string and load by name
    const name = emu.memory.readUTF16String(resourceId);
    return emu.loadBitmapResourceByName(name);
  });

  reg('CreateDCW', 4, (emu) => emu.getWindowDC(0)); // display DC = main window DC

  // ── Additional CRT functions ──
  reg('realloc', 2, (emu) => {
    const ptr = emu.readArg(0);
    const size = emu.readArg(1);
    if (size === 0) return 0;
    const newPtr = emu.allocHeap(size);
    if (ptr) {
      // Copy old data (assume old size <= new size; we don't track old size)
      for (let i = 0; i < size; i++) emu.memory.writeU8(newPtr + i, emu.memory.readU8(ptr + i));
    }
    return newPtr;
  });

  reg('memcpy', 3, (emu) => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    const n = emu.readArg(2);
    for (let i = 0; i < n; i++) emu.memory.writeU8(dst + i, emu.memory.readU8(src + i));
    return dst;
  });

  reg('memmove', 3, (emu) => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    const n = emu.readArg(2);
    if (dst < src) {
      for (let i = 0; i < n; i++) emu.memory.writeU8(dst + i, emu.memory.readU8(src + i));
    } else {
      for (let i = n - 1; i >= 0; i--) emu.memory.writeU8(dst + i, emu.memory.readU8(src + i));
    }
    return dst;
  });

  reg('wcscat', 2, (emu) => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    let dstLen = 0;
    while (emu.memory.readU16(dst + dstLen * 2) !== 0) dstLen++;
    let i = 0;
    while (true) {
      const ch = emu.memory.readU16(src + i * 2);
      emu.memory.writeU16(dst + (dstLen + i) * 2, ch);
      if (ch === 0) break;
      i++;
    }
    return dst;
  });

  reg('wcsncpy', 3, (emu) => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    const count = emu.readArg(2);
    let hitNull = false;
    for (let i = 0; i < count; i++) {
      if (hitNull) { emu.memory.writeU16(dst + i * 2, 0); continue; }
      const ch = emu.memory.readU16(src + i * 2);
      emu.memory.writeU16(dst + i * 2, ch);
      if (ch === 0) hitNull = true;
    }
    return dst;
  });

  reg('wcsrchr', 2, (emu) => {
    const str = emu.readArg(0);
    const ch = emu.readArg(1) & 0xFFFF;
    let last = 0;
    let i = 0;
    while (true) {
      const c = emu.memory.readU16(str + i * 2);
      if (c === ch) last = str + i * 2;
      if (c === 0) break;
      i++;
    }
    return last;
  });

  reg('sqrtf', 1, (emu) => {
    // Float arg in R0 (as bit pattern)
    const bits = emu.readArg(0);
    const f32 = new Float32Array(1);
    const u32 = new Uint32Array(f32.buffer);
    u32[0] = bits;
    f32[0] = Math.sqrt(f32[0]);
    return u32[0];
  });

  reg('_fpreset', 0, () => 0);
  reg('_fcloseall', 0, () => 0);
  reg('_getstdfilex', 1, () => 0); // return NULL FILE*
  reg('fflush', 1, () => 0);
  reg('fwrite', 4, (emu) => emu.readArg(1) * emu.readArg(2)); // pretend success
  reg('vfprintf', 3, () => 0);

  // ── Additional Kernel32 functions ──
  reg('GetLastError', 0, () => 0);
  reg('GetProcessHeap', 0, () => 0x11111111); // fake heap handle

  reg('HeapAlloc', 3, (emu) => {
    const size = emu.readArg(2);
    if (size === 0) return 0;
    const ptr = emu.allocHeap(size);
    const flags = emu.readArg(1);
    if (flags & 0x08) { // HEAP_ZERO_MEMORY
      for (let i = 0; i < size; i++) emu.memory.writeU8(ptr + i, 0);
    }
    return ptr;
  });

  reg('HeapFree', 3, () => 1);

  reg('HeapReAlloc', 4, (emu) => {
    const ptr = emu.readArg(2);
    const size = emu.readArg(3);
    if (size === 0) return 0;
    const newPtr = emu.allocHeap(size);
    if (ptr) {
      for (let i = 0; i < size; i++) emu.memory.writeU8(newPtr + i, emu.memory.readU8(ptr + i));
    }
    return newPtr;
  });

  reg('LocalAlloc', 2, (emu) => {
    const flags = emu.readArg(0);
    const size = emu.readArg(1);
    if (size === 0) return 0;
    const ptr = emu.allocHeap(size);
    if (flags & 0x40) { // LMEM_ZEROINIT
      for (let i = 0; i < size; i++) emu.memory.writeU8(ptr + i, 0);
    }
    return ptr;
  });

  reg('LocalSize', 1, (emu) => {
    const ptr = emu.readArg(0);
    return emu.heapAllocSizes.get(ptr) ?? 0;
  });

  reg('GetCommandLineW', 0, (emu) => {
    // Return pointer to empty command line
    const addr = emu.allocHeap(4);
    emu.memory.writeU16(addr, 0);
    return addr;
  });

  reg('GetModuleHandleW', 1, (emu) => {
    const nameAddr = emu.readArg(0);
    if (!nameAddr) return emu.pe?.imageBase ?? 0x10000;
    return 0;
  });

  reg('GetModuleFileNameW', 3, (emu) => {
    const hModule = emu.readArg(0);
    const lpFilename = emu.readArg(1);
    const nSize = emu.readArg(2);
    const path = '\\Program Files\\app.exe';
    const len = Math.min(path.length, nSize - 1);
    for (let i = 0; i < len; i++) emu.memory.writeU16(lpFilename + i * 2, path.charCodeAt(i));
    emu.memory.writeU16(lpFilename + len * 2, 0);
    return len;
  });

  reg('GetProcAddressW', 2, () => 0); // not found

  reg('LoadLibraryW', 1, () => 0); // fail

  reg('CloseHandle', 1, () => 1);

  reg('CreateFileW', 7, () => 0xFFFFFFFF); // INVALID_HANDLE_VALUE — file not found

  reg('ReadFile', 5, () => 0); // fail

  reg('WriteFile', 5, (emu) => {
    const nBytesToWrite = emu.readArg(2);
    const lpBytesWritten = emu.readArg(3);
    if (lpBytesWritten) emu.memory.writeU32(lpBytesWritten, nBytesToWrite);
    return 1;
  });

  reg('SetFilePointer', 4, () => 0);
  reg('GetFileSize', 2, () => 0);
  reg('GetFileAttributesW', 1, () => 0xFFFFFFFF); // INVALID_FILE_ATTRIBUTES
  reg('CreateDirectoryW', 2, () => 1);
  reg('FindFirstFileW', 2, () => 0xFFFFFFFF); // INVALID_HANDLE_VALUE
  reg('FindNextFileW', 2, () => 0);
  reg('FindClose', 1, () => 1);

  reg('InitializeCriticalSection', 1, () => 0);
  reg('DeleteCriticalSection', 1, () => 0);
  reg('EnterCriticalSection', 1, () => 0);
  reg('LeaveCriticalSection', 1, () => 0);

  reg('CreateEventW', 4, (emu) => emu.handles.alloc('event', {}));
  reg('EventModify', 2, () => 1); // SetEvent/ResetEvent
  reg('WaitForSingleObject', 2, () => 0); // WAIT_OBJECT_0

  reg('CreateThread', 6, (emu) => {
    // We can't actually create threads, but return a fake handle
    return emu.handles.alloc('thread', {});
  });

  reg('Sleep', 1, () => 0);
  reg('TerminateProcess', 2, (emu) => { emu.halted = true; emu.haltReason = 'TerminateProcess'; return 1; });

  reg('VirtualProtect', 4, (emu) => {
    const lpOldProtect = emu.readArg(3);
    if (lpOldProtect) emu.memory.writeU32(lpOldProtect, 0x40); // PAGE_EXECUTE_READWRITE
    return 1;
  });

  reg('VirtualQuery', 3, (emu) => {
    const lpBuffer = emu.readArg(1);
    if (lpBuffer) {
      // MEMORY_BASIC_INFORMATION (28 bytes)
      emu.memory.writeU32(lpBuffer, emu.readArg(0)); // BaseAddress
      emu.memory.writeU32(lpBuffer + 4, emu.readArg(0)); // AllocationBase
      emu.memory.writeU32(lpBuffer + 8, 0x40); // AllocationProtect
      emu.memory.writeU32(lpBuffer + 12, 0x10000); // RegionSize
      emu.memory.writeU32(lpBuffer + 16, 0x1000); // State = MEM_COMMIT
      emu.memory.writeU32(lpBuffer + 20, 0x40); // Protect
      emu.memory.writeU32(lpBuffer + 24, 0x20000); // Type = MEM_PRIVATE
    }
    return 28;
  });

  reg('MultiByteToWideChar', 6, (emu) => {
    const codePage = emu.readArg(0);
    const lpMultiByteStr = emu.readArg(2);
    const cbMultiByte = emu.readArg(3);
    const lpWideCharStr = emu.readArg(4);
    const cchWideChar = emu.readArg(5);
    let len = cbMultiByte;
    if (len === -1 || len === 0xFFFFFFFF) {
      len = 0;
      while (emu.memory.readU8(lpMultiByteStr + len) !== 0) len++;
      len++; // include null
    }
    if (cchWideChar === 0) return len; // query size
    const outLen = Math.min(len, cchWideChar);
    for (let i = 0; i < outLen; i++) {
      emu.memory.writeU16(lpWideCharStr + i * 2, emu.memory.readU8(lpMultiByteStr + i));
    }
    return outLen;
  });

  reg('WideCharToMultiByte', 8, (emu) => {
    const lpWideCharStr = emu.readArg(2);
    const cchWideChar = emu.readArg(3);
    const lpMultiByteStr = emu.readArg(4);
    const cbMultiByte = emu.readArg(5);
    let len = cchWideChar;
    if (len === -1 || len === 0xFFFFFFFF) {
      len = 0;
      while (emu.memory.readU16(lpWideCharStr + len * 2) !== 0) len++;
      len++;
    }
    if (cbMultiByte === 0) return len;
    const outLen = Math.min(len, cbMultiByte);
    for (let i = 0; i < outLen; i++) {
      const ch = emu.memory.readU16(lpWideCharStr + i * 2);
      emu.memory.writeU8(lpMultiByteStr + i, ch < 0x80 ? ch : 0x3F); // '?' for non-ASCII
    }
    return outLen;
  });

  reg('FormatMessageW', 7, () => 0);
  reg('OutputDebugStringW', 1, () => 0);

  reg('GetLocalTime', 1, (emu) => {
    const lpSysTime = emu.readArg(0);
    const now = new Date();
    emu.memory.writeU16(lpSysTime, now.getFullYear());
    emu.memory.writeU16(lpSysTime + 2, now.getMonth() + 1);
    emu.memory.writeU16(lpSysTime + 4, now.getDay());
    emu.memory.writeU16(lpSysTime + 6, now.getDate()); // actually dayOfWeek at +4, day at +6
    emu.memory.writeU16(lpSysTime + 8, now.getHours());
    emu.memory.writeU16(lpSysTime + 10, now.getMinutes());
    emu.memory.writeU16(lpSysTime + 12, now.getSeconds());
    emu.memory.writeU16(lpSysTime + 14, now.getMilliseconds());
    return 0;
  });

  reg('GetSystemTime', 1, emu.apiDefs.get('COREDLL.DLL:GetLocalTime')!.handler);
  reg('SystemTimeToFileTime', 2, (emu) => {
    const lpFileTime = emu.readArg(1);
    if (lpFileTime) {
      const now = Date.now();
      // Convert JS ms to Windows FILETIME (100ns since 1601)
      const ft = BigInt(now) * 10000n + 116444736000000000n;
      emu.memory.writeU32(lpFileTime, Number(ft & 0xFFFFFFFFn));
      emu.memory.writeU32(lpFileTime + 4, Number((ft >> 32n) & 0xFFFFFFFFn));
    }
    return 1;
  });

  // ── Additional User32 functions ──
  reg('GetClientRect', 2, (emu) => {
    const hwnd = emu.readArg(0);
    const lpRect = emu.readArg(1);
    const wnd = emu.handles.get(hwnd);
    if (lpRect) {
      emu.memory.writeU32(lpRect, 0);
      emu.memory.writeU32(lpRect + 4, 0);
      emu.memory.writeU32(lpRect + 8, wnd?.width ?? emu.screenWidth);
      emu.memory.writeU32(lpRect + 12, wnd?.height ?? emu.screenHeight);
    }
    return 1;
  });

  reg('AdjustWindowRectEx', 4, () => 1); // just leave rect as-is

  reg('ClientToScreen', 2, () => 1); // just leave point as-is
  reg('BringWindowToTop', 1, () => 1);
  reg('SetForegroundWindow', 1, () => 1);
  reg('GetForegroundWindow', 0, (emu) => emu.mainWindow || 0);

  reg('GetWindowLongW', 2, (emu) => {
    const hwnd = emu.readArg(0);
    const nIndex = emu.readArg(1) | 0;
    const wnd = emu.handles.get(hwnd);
    if (!wnd) return 0;
    const GWL_WNDPROC = -4, GWL_STYLE = -16, GWL_EXSTYLE = -20, GWL_USERDATA = -21;
    switch (nIndex) {
      case GWL_WNDPROC: return wnd.wndProc ?? 0;
      case GWL_STYLE: return wnd.style ?? 0;
      case GWL_EXSTYLE: return wnd.exStyle ?? 0;
      case GWL_USERDATA: return wnd.userData ?? 0;
      default:
        if (nIndex >= 0 && wnd.extraBytes && nIndex + 4 <= wnd.extraBytes.length) {
          const dv = new DataView(wnd.extraBytes.buffer, wnd.extraBytes.byteOffset);
          return dv.getUint32(nIndex, true);
        }
        return 0;
    }
  });

  reg('SetWindowLongW', 3, (emu) => {
    const hwnd = emu.readArg(0);
    const nIndex = emu.readArg(1) | 0;
    const dwNewLong = emu.readArg(2);
    const wnd = emu.handles.get(hwnd);
    if (!wnd) return 0;
    const GWL_WNDPROC = -4, GWL_STYLE = -16, GWL_EXSTYLE = -20, GWL_USERDATA = -21;
    let old = 0;
    switch (nIndex) {
      case GWL_WNDPROC: old = wnd.wndProc ?? 0; wnd.wndProc = dwNewLong; break;
      case GWL_STYLE: old = wnd.style ?? 0; wnd.style = dwNewLong; break;
      case GWL_EXSTYLE: old = wnd.exStyle ?? 0; wnd.exStyle = dwNewLong; break;
      case GWL_USERDATA: old = wnd.userData ?? 0; wnd.userData = dwNewLong; break;
      default:
        if (nIndex >= 0 && wnd.extraBytes && nIndex + 4 <= wnd.extraBytes.length) {
          const dv = new DataView(wnd.extraBytes.buffer, wnd.extraBytes.byteOffset);
          old = dv.getUint32(nIndex, true);
          dv.setUint32(nIndex, dwNewLong, true);
        }
    }
    return old;
  });

  reg('SetWindowTextW', 2, (emu) => {
    const hwnd = emu.readArg(0);
    const textAddr = emu.readArg(1);
    const wnd = emu.handles.get(hwnd);
    if (wnd && textAddr) {
      let s = '', off = 0;
      while (true) {
        const ch = emu.memory.readU16(textAddr + off);
        if (ch === 0) break;
        s += String.fromCharCode(ch);
        off += 2;
      }
      wnd.title = s;
    }
    return 1;
  });

  reg('GetKeyState', 1, () => 0);
  reg('SetCursorPos', 2, () => 1);
  reg('LoadCursorW', 2, (emu) => emu.handles.alloc('cursor', { css: 'default' }));
  reg('LoadImageW', 6, () => 0);
  reg('UnregisterClassW', 2, () => 1);

  reg('PeekMessageW', 5, (emu) => {
    const lpMsg = emu.readArg(0);
    if (emu.messageQueue.length > 0) {
      const remove = emu.readArg(4) & 0x0001; // PM_REMOVE
      const msg = remove ? emu.messageQueue.shift()! : emu.messageQueue[0];
      writeMsg(emu, lpMsg, msg);
      return 1;
    }
    // Synthesize WM_PAINT if any window needs repainting
    if (emu.wndProcDepth === 0) {
      const paintMsg = synthesizePaint(emu);
      if (paintMsg) {
        writeMsg(emu, lpMsg, paintMsg);
        return 1;
      }
    }
    // No messages — yield to browser so it can deliver mouse/keyboard events,
    // then resume with return value 0 (no message).
    if (emu.wndProcDepth <= 1) {
      emu.waitingForMessage = true;
      const resumeWith0 = () => {
        emu._onMessageAvailable = null;
        emu.waitingForMessage = false;
        emuCompleteThunkARM(emu, 0);
        if (emu.running && !emu.halted) {
          requestAnimationFrame(emu.tick);
        }
      };
      emu._onMessageAvailable = resumeWith0;
      requestAnimationFrame(() => {
        if (emu._onMessageAvailable === resumeWith0) resumeWith0();
      });
      return undefined;
    }
    return 0;
  });

  // Clipboard
  reg('OpenClipboard', 1, () => 1);
  reg('CloseClipboard', 0, () => 1);
  reg('EmptyClipboard', 0, () => 1);
  reg('SetClipboardData', 2, () => 1);
  reg('GetClipboardData', 1, () => 0);

  // ── Additional GDI32 functions ──
  reg('GetDeviceCaps', 2, (emu) => {
    const index = emu.readArg(1);
    const HORZRES = 8, VERTRES = 10, BITSPIXEL = 12, PLANES = 14, LOGPIXELSX = 88, LOGPIXELSY = 90;
    switch (index) {
      case HORZRES: return emu.screenWidth || 240;
      case VERTRES: return emu.screenHeight || 320;
      case BITSPIXEL: return 32;
      case PLANES: return 1;
      case LOGPIXELSX: case LOGPIXELSY: return 96;
      default: return 0;
    }
  });
}

// ── WS2.DLL (WinCE Winsock) ──
export function registerWs2(emu: Emulator): void {
  const reg = (name: string, nArgs: number, handler: (emu: Emulator) => number | undefined) => {
    emu.apiDefs.set(`WS2.DLL:${name}`, { handler, stackBytes: nArgs * 4 });
  };

  reg('WSAStartup', 2, (emu) => {
    const lpWSAData = emu.readArg(1);
    if (lpWSAData) {
      emu.memory.writeU16(lpWSAData, 0x0202); // wVersion
      emu.memory.writeU16(lpWSAData + 2, 0x0202); // wHighVersion
    }
    return 0; // success
  });

  reg('WSACleanup', 0, () => 0);
  reg('WSAGetLastError', 0, () => 0);
  reg('socket', 3, () => 0xFFFFFFFF); // INVALID_SOCKET
  reg('closesocket', 1, () => 0);
  reg('connect', 3, () => 0xFFFFFFFF); // SOCKET_ERROR
  reg('send', 4, () => 0xFFFFFFFF);
  reg('recv', 4, () => 0xFFFFFFFF);
  reg('select', 5, () => 0);
  reg('shutdown', 2, () => 0);
  reg('gethostbyname', 1, () => 0); // fail
  reg('getsockopt', 5, () => 0xFFFFFFFF);
  reg('htons', 1, (emu) => {
    const val = emu.readArg(0) & 0xFFFF;
    return ((val & 0xFF) << 8) | ((val >> 8) & 0xFF);
  });
  reg('ioctlsocket', 3, () => 0);
  reg('__WSAFDIsSet', 2, () => 0);
}
