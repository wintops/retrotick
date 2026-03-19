import type { Emulator } from '../emulator';
import { formatString, scanString, stackArgReader, vaListArgReader } from '../format';
import { emuCompleteThunk } from '../emu-exec';

export function registerMsvcrt(emu: Emulator): void {
  const msvcrt = emu.registerDll('MSVCRT.DLL');

  msvcrt.register('_initterm', 0, () => {
    const start = emu.readArg(0);
    const end = emu.readArg(1);
    // Call function pointers between start and end (synchronous)
    for (let ptr = start; ptr < end; ptr += 4) {
      const func = emu.memory.readU32(ptr);
      if (func !== 0) {
        emu.callNative(func);
      }
    }
    return 0;
  });

  msvcrt.register('_initterm_e', 0, () => {
    const start = emu.readArg(0);
    const end = emu.readArg(1);
    for (let ptr = start; ptr < end; ptr += 4) {
      const func = emu.memory.readU32(ptr);
      if (func !== 0) {
        emu.callNative(func);
      }
    }
    return 0;
  });

  // CRT basic stubs
  // __p__commode / __p__fmode return pointers to global int variables
  const commodeVar = emu.allocHeap(4);
  emu.memory.writeU32(commodeVar, 0);
  msvcrt.register('__p__commode', 0, () => commodeVar);
  msvcrt.register('_commode', 0, () => commodeVar);
  const fmodeVar = emu.allocHeap(4);
  emu.memory.writeU32(fmodeVar, 0);
  msvcrt.register('__p__fmode', 0, () => fmodeVar);
  msvcrt.register('_fmode', 0, () => fmodeVar);
  // __p___argc / __p___argv return pointers to argc/argv globals
  const argcVar = emu.allocHeap(4);
  emu.memory.writeU32(argcVar, 1); // argc = 1
  msvcrt.register('__p___argc', 0, () => argcVar);
  const argvPtr = emu.allocHeap(8);
  const argvStr = emu.allocHeap(16);
  emu.memory.writeCString(argvStr, emu.exeName);
  emu.memory.writeU32(argvPtr, argvStr);
  emu.memory.writeU32(argvPtr + 4, 0);
  msvcrt.register('__p___argv', 0, () => argvPtr);

  // __p__acmdln — returns pointer to char* _acmdln (the command line string pointer)
  // Must include program name prefix, matching GetCommandLineA behavior
  const acmdlnVar = emu.allocHeap(4);
  const cmdLineAddr = emu.allocHeap(260);
  const cmdArgs = emu.commandLine || '';
  const exeName = emu.exeName;
  const cmdStr = cmdArgs ? `${exeName} ${cmdArgs}` : exeName;
  for (let i = 0; i < cmdStr.length; i++) emu.memory.writeU8(cmdLineAddr + i, cmdStr.charCodeAt(i));
  emu.memory.writeU8(cmdLineAddr + cmdStr.length, 0);
  emu.memory.writeU32(acmdlnVar, cmdLineAddr);
  msvcrt.register('__p__acmdln', 0, () => acmdlnVar);

  // _beginthreadex — stub that returns a pseudo-handle (thread not actually created)
  msvcrt.register('_beginthreadex', 0, () => 0xBEEF0001);

  msvcrt.register('__set_app_type', 0, () => 0);
  msvcrt.register('_set_app_type', 0, () => 0);
  msvcrt.register('_set_fmode', 0, () => 0);
  msvcrt.register('__setusermatherr', 0, () => 0);
  msvcrt.register('_adjust_fdiv', 0, () => 0);
  msvcrt.register('_controlfp', 0, () => 0);
  msvcrt.register('_controlfp_s', 0, () => {
    const pCurrent = emu.readArg(0);
    if (pCurrent) emu.memory.writeU32(pCurrent, 0);
    return 0; // success
  });
  msvcrt.register('_except_handler3', 0, () => 1); // ExceptionContinueSearch
  msvcrt.register('_c_exit', 0, () => { emu.exitedNormally = true; emu.halted = true; return 0; });
  msvcrt.register('_cexit', 0, () => { emu.exitedNormally = true; emu.halted = true; return 0; });
  msvcrt.register('_exit', 0, () => { emu.exitedNormally = true; emu.halted = true; return 0; });
  msvcrt.register('exit', 0, () => { emu.exitedNormally = true; emu.halted = true; return 0; });
  msvcrt.register('_amsg_exit', 0, () => { emu.exitedNormally = true; emu.halted = true; return 0; });
  // _acmdln is a data import (pointer to command line) — handled as thunk in emulator
  msvcrt.register('_acmdln', 0, () => {
    const cmdStr = emu.commandLine || '';
    const ptr = emu.allocHeap(cmdStr.length + 1);
    emu.memory.writeCString(ptr, cmdStr);
    return ptr;
  });

  // Parse command line into argv tokens
  function parseCmdArgs(): string[] {
    const cmd = emu.commandLine || '';
    const args = [emu.exeName];
    // Simple split on spaces (good enough for /s, /c, etc.)
    const parts = cmd.trim().split(/\s+/);
    for (const p of parts) { if (p) args.push(p); }
    return args;
  }

  msvcrt.register('__getmainargs', 0, () => {
    const argcPtr = emu.readArg(0);
    const argvPtr = emu.readArg(1);
    const envPtr = emu.readArg(2);
    const args = parseCmdArgs();
    emu.memory.writeU32(argcPtr, args.length);
    const argvArr = emu.allocHeap((args.length + 1) * 4);
    for (let i = 0; i < args.length; i++) {
      const s = emu.allocHeap(args[i].length + 1);
      emu.memory.writeCString(s, args[i]);
      emu.memory.writeU32(argvArr + i * 4, s);
    }
    emu.memory.writeU32(argvArr + args.length * 4, 0);
    emu.memory.writeU32(argvPtr, argvArr);
    const envArr = emu.allocHeap(4);
    emu.memory.writeU32(envArr, 0);
    emu.memory.writeU32(envPtr, envArr);
    return 0;
  });
  msvcrt.register('__wgetmainargs', 0, () => {
    const argcPtr = emu.readArg(0);
    const argvPtr = emu.readArg(1);
    const envPtr = emu.readArg(2);
    const args = parseCmdArgs();
    if (argcPtr) emu.memory.writeU32(argcPtr, args.length);
    const argvArr = emu.allocHeap((args.length + 1) * 4);
    for (let i = 0; i < args.length; i++) {
      const s = emu.allocHeap((args[i].length + 1) * 2);
      emu.memory.writeUTF16String(s, args[i]);
      emu.memory.writeU32(argvArr + i * 4, s);
    }
    emu.memory.writeU32(argvArr + args.length * 4, 0);
    if (argvPtr) emu.memory.writeU32(argvPtr, argvArr);
    if (envPtr) {
      const envArr = emu.allocHeap(4);
      emu.memory.writeU32(envArr, 0);
      emu.memory.writeU32(envPtr, envArr);
    }
    return 0;
  });
  msvcrt.register('_configthreadlocale', 0, () => 0);
  msvcrt.register('__lconv_init', 0, () => 0);
  msvcrt.register('_XcptFilter', 0, () => 0);
  msvcrt.register('__crtSetUnhandledExceptionFilter', 0, () => 0);
  msvcrt.register('__crtUnhandledException', 0, () => 0);
  msvcrt.register('__crtTerminateProcess', 0, () => { emu.exitedNormally = true; emu.halted = true; return 0; });
  msvcrt.register('_crt_debugger_hook', 0, () => 0);
  msvcrt.register('_except_handler4_common', 0, () => 1); // ExceptionContinueSearch
  msvcrt.register('_invoke_watson', 0, () => { emu.exitedNormally = true; emu.halted = true; return 0; });
  msvcrt.register('_lock', 0, () => 0);
  msvcrt.register('_unlock', 0, () => 0);
  msvcrt.register('?terminate@@YAXXZ', 0, () => { emu.exitedNormally = true; emu.halted = true; return 0; });
  msvcrt.register('_ioinit', 0, () => 0);
  let msvcrtRandSeed = 1;
  msvcrt.register('srand', 0, () => {
    msvcrtRandSeed = emu.readArg(0) >>> 0;
    return 0;
  });
  msvcrt.register('rand', 0, () => {
    msvcrtRandSeed = (Math.imul(msvcrtRandSeed, 214013) + 2531011) >>> 0;
    return (msvcrtRandSeed >>> 16) & 0x7fff;
  });
  msvcrt.register('time', 0, () => {
    const ptr = emu.readArg(0);
    const t = (Date.now() / 1000) | 0;
    if (ptr) emu.memory.writeU32(ptr, t);
    return t;
  });
  msvcrt.register('_time64', 0, () => {
    const ptr = emu.readArg(0);
    const t = (Date.now() / 1000) | 0;
    if (ptr) {
      emu.memory.writeU32(ptr, t);
      emu.memory.writeU32(ptr + 4, 0); // high 32 bits
    }
    return t;
  });
  msvcrt.register('malloc', 0, () => {
    const size = emu.readArg(0);
    // Use the same heap allocation
    return emu.allocHeap(size);
  });
  msvcrt.register('free', 0, () => 0);
  msvcrt.register('calloc', 0, () => {
    const num = emu.readArg(0);
    const size = emu.readArg(1);
    return emu.allocHeap(num * size);
  });
  msvcrt.register('_calloc_crt', 0, () => {
    const num = emu.readArg(0);
    const size = emu.readArg(1);
    return emu.allocHeap(num * size);
  });
  msvcrt.register('realloc', 0, () => {
    const ptr = emu.readArg(0);
    const size = emu.readArg(1);
    return emu.reallocHeap(ptr, size);
  });
  msvcrt.register('memset', 0, () => {
    const dst = emu.readArg(0);
    const val = emu.readArg(1) & 0xFF;
    const count = emu.readArg(2);
    for (let i = 0; i < count; i++) emu.memory.writeU8(dst + i, val);
    return dst;
  });
  msvcrt.register('memcpy', 0, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    const count = emu.readArg(2);
    for (let i = 0; i < count; i++) emu.memory.writeU8(dst + i, emu.memory.readU8(src + i));
    return dst;
  });
  msvcrt.register('memmove', 0, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    const count = emu.readArg(2);
    const tmp = emu.memory.slice(src, count);
    emu.memory.copyFrom(dst, tmp);
    return dst;
  });
  msvcrt.register('memcmp', 0, () => {
    const s1 = emu.readArg(0);
    const s2 = emu.readArg(1);
    const count = emu.readArg(2);
    for (let i = 0; i < count; i++) {
      const a = emu.memory.readU8(s1 + i);
      const b = emu.memory.readU8(s2 + i);
      if (a !== b) return a < b ? -1 : 1;
    }
    return 0;
  });
  msvcrt.register('strlen', 0, () => {
    const ptr = emu.readArg(0);
    let len = 0;
    while (emu.memory.readU8(ptr + len) !== 0) len++;
    return len;
  });
  msvcrt.register('strcpy', 0, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    let i = 0;
    while (true) {
      const ch = emu.memory.readU8(src + i);
      emu.memory.writeU8(dst + i, ch);
      if (ch === 0) break;
      i++;
    }
    return dst;
  });
  msvcrt.register('_stricmp', 0, () => {
    const s1 = emu.memory.readCString(emu.readArg(0)).toLowerCase();
    const s2 = emu.memory.readCString(emu.readArg(1)).toLowerCase();
    return s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
  });

  msvcrt.register('strstr', 0, () => {
    const haystack = emu.readArg(0);
    const needle = emu.readArg(1);
    const hs = emu.memory.readCString(haystack);
    const ns = emu.memory.readCString(needle);
    const idx = hs.indexOf(ns);
    return idx >= 0 ? haystack + idx : 0;
  });

  // MSVCRT wide string functions
  msvcrt.register('wcslen', 0, () => {
    let ptr = emu.readArg(0);
    let len = 0;
    while (emu.memory.readU16(ptr) !== 0) { ptr += 2; len++; }
    return len;
  });
  msvcrt.register('wcschr', 0, () => {
    let ptr = emu.readArg(0);
    const ch = emu.readArg(1) & 0xFFFF;
    while (true) {
      const c = emu.memory.readU16(ptr);
      if (c === ch) return ptr;
      if (c === 0) return 0;
      ptr += 2;
    }
  });
  msvcrt.register('_wcsrev', 0, () => {
    const ptr = emu.readArg(0);
    // Find length
    let len = 0;
    while (emu.memory.readU16(ptr + len * 2) !== 0) len++;
    // Reverse in place
    for (let i = 0; i < len >> 1; i++) {
      const a = emu.memory.readU16(ptr + i * 2);
      const b = emu.memory.readU16(ptr + (len - 1 - i) * 2);
      emu.memory.writeU16(ptr + i * 2, b);
      emu.memory.writeU16(ptr + (len - 1 - i) * 2, a);
    }
    return ptr;
  });
  msvcrt.register('toupper', 0, () => {
    const ch = emu.readArg(0) & 0xFF;
    return (ch >= 0x61 && ch <= 0x7A) ? ch - 0x20 : ch;
  });

  // MSVCRT C++ support
  msvcrt.register('_EH_prolog', 0, () => {
    // _EH_prolog: sets up MSVC C++ exception handling frame
    // At entry: EAX = handler function pointer, stack = [retAddr, ...]
    // After: stack = [prev_seh, handler, -1, saved_ebp, ...], EBP = &saved_ebp, fs:[0] = ESP
    const esp = emu.cpu.reg[4] >>> 0;
    const retAddr = emu.memory.readU32(esp);
    const handler = emu.cpu.reg[0]; // EAX = handler
    const savedEBP = emu.cpu.reg[5]; // current EBP
    const prevSEH = emu.memory.readU32(emu.cpu.fsBase); // fs:[0]

    // Overwrite return address slot with saved EBP
    emu.memory.writeU32(esp, savedEBP);
    // Set EBP to point to saved EBP location
    emu.cpu.reg[5] = esp;

    // Push trylevel, handler, prev SEH frame below saved EBP
    const newEsp = (esp - 12) >>> 0;
    emu.memory.writeU32(newEsp + 8, 0xFFFFFFFF); // trylevel = -1
    emu.memory.writeU32(newEsp + 4, handler);     // handler
    emu.memory.writeU32(newEsp, prevSEH);         // prev SEH frame

    // Update ESP
    emu.cpu.reg[4] = newEsp;

    // Register new SEH frame: fs:[0] = ESP
    emu.memory.writeU32(emu.cpu.fsBase, newEsp);

    // Return to caller
    emu.cpu.eip = retAddr;
    return undefined;
  });
  msvcrt.register('__CxxFrameHandler', 0, () => 1); // ExceptionContinueSearch
  msvcrt.register('_CxxThrowException', 0, () => {
    console.warn('[MSVCRT] _CxxThrowException called — ignoring');
    return 0;
  });
  // operator delete(void*)
  msvcrt.register('??3@YAXPAX@Z', 0, () => {
    // free(ptr) — no-op in our allocator
    return 0;
  });
  // type_info::~type_info()
  msvcrt.register('??1type_info@@UAE@XZ', 0, () => 0);

  // operator new(size_t)
  msvcrt.register('??2@YAPAXI@Z', 0, () => {
    const size = emu.readArg(0);
    return emu.allocHeap(size || 1);
  });

  // __p___initenv — returns pointer to _environ
  const initenvVar = emu.allocHeap(4);
  emu.memory.writeU32(initenvVar, 0);
  msvcrt.register('__p___initenv', 0, () => initenvVar);
  msvcrt.register('__initenv', 0, () => initenvVar);

  // __p__environ — returns pointer to environ (environment variables)
  const environVar = emu.allocHeap(4);
  const environAddr = emu.allocHeap(4); // Array of environment strings
  emu.memory.writeU32(environAddr, 0); // Empty environment
  emu.memory.writeU32(environVar, environAddr);
  msvcrt.register('__p__environ', 0, () => environVar);

  // getenv — look up environment variable from shared emu.envVars, return pointer to value or NULL
  const getenvCache = new Map<string, number>();
  msvcrt.register('getenv', 0, () => {
    const namePtr = emu.readArg(0);
    if (!namePtr) return 0;
    const name = emu.memory.readCString(namePtr).toUpperCase();
    if (getenvCache.has(name)) return getenvCache.get(name)!;
    const val = emu.envVars.get(name);
    if (val === undefined) return 0;
    const ptr = emu.allocHeap(val.length + 1);
    emu.memory.writeCString(ptr, val);
    getenvCache.set(name, ptr);
    return ptr;
  });

  // _ftime — fills struct _timeb
  msvcrt.register('_ftime', 0, () => {
    const ptr = emu.readArg(0);
    const now = Date.now();
    const secs = (now / 1000) | 0;
    const ms = now % 1000;
    if (ptr) {
      emu.memory.writeU32(ptr, secs);      // time
      emu.memory.writeU16(ptr + 4, ms);    // millitm
      emu.memory.writeU16(ptr + 6, 0);     // timezone
      emu.memory.writeU16(ptr + 8, 0);     // dstflag
    }
    return 0;
  });

  // sprintf — cdecl varargs: sprintf(buf, fmt, ...)
  msvcrt.register('sprintf', 0, () => {
    const bufPtr = emu.readArg(0);
    const fmtPtr = emu.readArg(1);
    const fmt = emu.memory.readCString(fmtPtr);
    const result = formatString(fmt, stackArgReader(i => emu.readArg(i), 2), emu.memory, false);
    for (let j = 0; j < result.length; j++) emu.memory.writeU8(bufPtr + j, result.charCodeAt(j));
    emu.memory.writeU8(bufPtr + result.length, 0);
    return result.length;
  });

  // swprintf — cdecl varargs: swprintf(buf, fmt, ...) — wide version of sprintf
  msvcrt.register('swprintf', 0, () => {
    const bufPtr = emu.readArg(0);
    const fmtPtr = emu.readArg(1);
    const fmt = emu.memory.readUTF16String(fmtPtr);
    const result = formatString(fmt, stackArgReader(i => emu.readArg(i), 2), emu.memory, true);
    for (let j = 0; j < result.length; j++) emu.memory.writeU16(bufPtr + j * 2, result.charCodeAt(j));
    emu.memory.writeU16(bufPtr + result.length * 2, 0);
    return result.length;
  });

  // _ftol — float to long conversion (reads from FPU ST(0))
  msvcrt.register('_ftol', 0, () => {
    const val = emu.cpu.fpuStack[emu.cpu.fpuTop & 7] || 0;
    return Math.trunc(val) | 0;
  });

  // _libm_sse2_* — internal math helpers; take double in XMM0, return double in XMM0
  msvcrt.register('_libm_sse2_cos_precise', 0, () => {
    emu.cpu.xmmF64[0] = Math.cos(emu.cpu.xmmF64[0]);
    return 0;
  });
  msvcrt.register('_libm_sse2_sin_precise', 0, () => {
    emu.cpu.xmmF64[0] = Math.sin(emu.cpu.xmmF64[0]);
    return 0;
  });
  msvcrt.register('_libm_sse2_sqrt_precise', 0, () => {
    emu.cpu.xmmF64[0] = Math.sqrt(emu.cpu.xmmF64[0]);
    return 0;
  });

  // strcmp
  msvcrt.register('strcmp', 0, () => {
    const s1 = emu.memory.readCString(emu.readArg(0));
    const s2 = emu.memory.readCString(emu.readArg(1));
    return s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
  });

  // wcsrchr — find last occurrence of wchar in wide string
  msvcrt.register('wcsrchr', 0, () => {
    const str = emu.readArg(0);
    const ch = emu.readArg(1) & 0xFFFF;
    let last = 0;
    let ptr = str;
    while (true) {
      const c = emu.memory.readU16(ptr);
      if (c === ch) last = ptr;
      if (c === 0) break;
      ptr += 2;
    }
    return last;
  });

  // wcsspn — length of initial segment matching chars in accept set
  msvcrt.register('wcsspn', 0, () => {
    const strPtr = emu.readArg(0);
    const acceptPtr = emu.readArg(1);
    // Build accept set
    const accept = new Set<number>();
    for (let p = acceptPtr; ; p += 2) {
      const c = emu.memory.readU16(p);
      if (c === 0) break;
      accept.add(c);
    }
    let count = 0;
    for (let p = strPtr; ; p += 2) {
      const c = emu.memory.readU16(p);
      if (c === 0 || !accept.has(c)) break;
      count++;
    }
    return count;
  });

  // wcscspn — length of initial segment NOT matching any char in reject set
  msvcrt.register('wcscspn', 0, () => {
    const strPtr = emu.readArg(0);
    const rejectPtr = emu.readArg(1);
    const reject = new Set<number>();
    for (let p = rejectPtr; ; p += 2) {
      const c = emu.memory.readU16(p);
      if (c === 0) break;
      reject.add(c);
    }
    let count = 0;
    for (let p = strPtr; ; p += 2) {
      const c = emu.memory.readU16(p);
      if (c === 0 || reject.has(c)) break;
      count++;
    }
    return count;
  });

  // _wcsupr — convert wide string to uppercase in-place
  msvcrt.register('_wcsupr', 0, () => {
    const strPtr = emu.readArg(0);
    for (let p = strPtr; ; p += 2) {
      const c = emu.memory.readU16(p);
      if (c === 0) break;
      if (c >= 0x61 && c <= 0x7A) emu.memory.writeU16(p, c - 0x20);
    }
    return strPtr;
  });

  // _wcsdup — duplicate wide string
  msvcrt.register('_wcsdup', 0, () => {
    const src = emu.readArg(0);
    if (!src) return 0;
    let len = 0;
    while (emu.memory.readU16(src + len * 2) !== 0) len++;
    const dst = emu.allocHeap((len + 1) * 2);
    for (let i = 0; i <= len; i++) {
      emu.memory.writeU16(dst + i * 2, emu.memory.readU16(src + i * 2));
    }
    return dst;
  });

  // _onexit / __dllonexit — register exit callback (no-op, return the function pointer)
  msvcrt.register('_onexit', 0, () => {
    return emu.readArg(0); // return the function pointer to indicate success
  });
  msvcrt.register('__dllonexit', 0, () => {
    return emu.readArg(0); // return the function pointer to indicate success
  });

  msvcrt.register('_msize', 0, () => {
    const ptr = emu.readArg(0);
    return emu.heapSize(ptr) || 0;
  });

  // Console/file handle mapping for MSVCRT
  const STD_INPUT_HANDLE = 0xFFFFFFF6;
  const STD_OUTPUT_HANDLE = 0xFFFFFFF5;
  const STD_ERROR_HANDLE = 0xFFFFFFF4;

  // CRT file descriptor ↔ OS handle mapping
  let nextCrtFd = 3; // 0=stdin, 1=stdout, 2=stderr
  const fdToHandle = new Map<number, number>([[0, STD_INPUT_HANDLE], [1, STD_OUTPUT_HANDLE], [2, STD_ERROR_HANDLE]]);
  const handleToFd = new Map<number, number>([[STD_INPUT_HANDLE >>> 0, 0], [STD_OUTPUT_HANDLE >>> 0, 1], [STD_ERROR_HANDLE >>> 0, 2]]);

  // _open_osfhandle(osfhandle, flags) → fd
  msvcrt.register('_open_osfhandle', 0, () => {
    const osfhandle = emu.readArg(0);
    const existing = handleToFd.get(osfhandle >>> 0);
    if (existing !== undefined) return existing;
    const fd = nextCrtFd++;
    fdToHandle.set(fd, osfhandle);
    handleToFd.set(osfhandle >>> 0, fd);
    return fd;
  });

  msvcrt.register('_get_osfhandle', 0, () => {
    const fd = emu.readArg(0);
    const h = fdToHandle.get(fd);
    return h !== undefined ? h : 0xFFFFFFFF;
  });

  // _close(fd) → 0 on success, -1 on error
  msvcrt.register('_close', 0, () => {
    const fd = emu.readArg(0);
    if (fd <= 2) return 0; // don't actually close std handles
    const h = fdToHandle.get(fd);
    if (h !== undefined) {
      handleToFd.delete(h >>> 0);
      fdToHandle.delete(fd);
    }
    return 0;
  });

  msvcrt.register('_setmode', 0, () => {
    // _setmode(fd, mode) — return previous mode
    return emu.readArg(1); // just return the new mode
  });

  // _open(filename, oflag, [pmode]) → fd or -1
  msvcrt.register('_open', 0, () => {
    const fnPtr = emu.readArg(0);
    const oflag = emu.readArg(1);
    if (!fnPtr) return -1;
    const filename = emu.memory.readCString(fnPtr);
    const O_RDONLY = 0x0000, O_WRONLY = 0x0001, O_RDWR = 0x0002;
    const O_CREAT = 0x0100, O_TRUNC = 0x0200;
    const GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;

    let access = 0;
    if ((oflag & 3) === O_RDONLY) access = GENERIC_READ;
    else if ((oflag & 3) === O_WRONLY) access = GENERIC_WRITE;
    else if ((oflag & 3) === O_RDWR) access = GENERIC_READ | GENERIC_WRITE;

    let creation = 3; // OPEN_EXISTING
    if (oflag & O_CREAT) creation = (oflag & O_TRUNC) ? 2 : 4; // CREATE_ALWAYS or OPEN_ALWAYS

    // Call CreateFileA internally
    const resolved = emu.resolvePath(filename);
    const upper = resolved.toUpperCase();
    const fs = emu.fs;
    const existing = fs.findFile(resolved, emu.additionalFiles);

    if (creation === 3 /* OPEN_EXISTING */ && !existing) {
      if (emu.traceApi) console.log(`[MSVCRT] _open("${filename}") → not found`);
      return -1;
    }

    let syncData: Uint8Array | null = null;
    let size = 0;
    if (existing) {
      if (existing.source === 'additional') {
        const ab = emu.additionalFiles.get(existing.name);
        if (ab) { syncData = new Uint8Array(ab); size = syncData.length; }
      } else if (existing.source === 'external') {
        const ext = fs.externalFiles.get(upper);
        if (ext) { syncData = ext.data ?? null; size = ext.data?.length ?? existing.size; }
      }
    }

    const hFile = emu.handles.alloc('file', {
      path: upper, access, pos: 0,
      data: syncData, size, modified: false,
    });

    const fd = nextCrtFd++;
    fdToHandle.set(fd, hFile);
    handleToFd.set(hFile >>> 0, fd);
    console.log(`[MSVCRT] _open("${filename}") → fd=${fd} handle=0x${hFile.toString(16)} size=${size}`);
    return fd;
  });

  // _read(fd, buf, count) → bytes read or -1
  msvcrt.register('_read', 0, () => {
    const fd = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const hFile = fdToHandle.get(fd);
    if (hFile === undefined) return -1;
    const f = emu.handles.get<import('../../file-manager').OpenFile>(hFile);
    if (!f || !f.data) return 0;
    const available = f.data.length - f.pos;
    const toRead = Math.min(count, available);
    if (toRead <= 0) return 0;
    for (let i = 0; i < toRead; i++) {
      emu.memory.writeU8(bufPtr + i, f.data[f.pos + i]);
    }
    f.pos += toRead;
    return toRead;
  });

  // _write(fd, buf, count) → bytes written or -1
  msvcrt.register('_write', 0, () => {
    const fd = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const count = emu.readArg(2);
    if (fd === 1 || fd === 2) {
      let s = '';
      for (let i = 0; i < count; i++) s += String.fromCharCode(emu.memory.readU8(bufPtr + i));
      if (s.trim()) console.log(`[MSVCRT] _write(fd=${fd}): ${s.trimEnd()}`);
      return count;
    }
    const hFile = fdToHandle.get(fd);
    if (hFile === undefined) return -1;
    const f = emu.handles.get<import('../../file-manager').OpenFile>(hFile);
    if (!f) return -1;
    return count;
  });

  // _lseek(fd, offset, origin) → new position or -1
  msvcrt.register('_lseek', 0, () => {
    const fd = emu.readArg(0);
    const offset = emu.readArg(1) | 0;
    const origin = emu.readArg(2);
    const hFile = fdToHandle.get(fd);
    if (hFile === undefined) return -1;
    const f = emu.handles.get<import('../../file-manager').OpenFile>(hFile);
    if (!f) return -1;
    if (origin === 0) f.pos = offset;
    else if (origin === 1) f.pos += offset;
    else if (origin === 2) f.pos = f.size + offset;
    if (f.pos < 0) f.pos = 0;
    return f.pos;
  });

  // _filelength(fd) → file size or -1
  msvcrt.register('_filelength', 0, () => {
    const fd = emu.readArg(0);
    const hFile = fdToHandle.get(fd);
    if (hFile === undefined) return -1;
    const f = emu.handles.get<import('../../file-manager').OpenFile>(hFile);
    if (!f) return -1;
    return f.size;
  });

  // _tell(fd) → current position or -1
  msvcrt.register('_tell', 0, () => {
    const fd = emu.readArg(0);
    const hFile = fdToHandle.get(fd);
    if (hFile === undefined) return -1;
    const f = emu.handles.get<import('../../file-manager').OpenFile>(hFile);
    if (!f) return -1;
    return f.pos;
  });

  // _iob — array of FILE structs (stdin, stdout, stderr)
  const iobBase = emu.allocHeap(3 * 32); // 3 FILE structs, 32 bytes each
  msvcrt.register('_iob', 0, () => iobBase);
  msvcrt.register('__iob_func', 0, () => iobBase);

  const stdinFilePtr  = iobBase + 0;   // FILE* for stdin
  const stdoutFilePtr = iobBase + 32;  // FILE* for stdout
  const stderrFilePtr = iobBase + 64;  // FILE* for stderr

  msvcrt.register('fprintf', 0, () => {
    const filePtr = emu.readArg(0);
    const fmtPtr = emu.readArg(1);
    const fmt = emu.memory.readCString(fmtPtr);
    const result = formatString(fmt, stackArgReader(i => emu.readArg(i), 2), emu.memory, false);
    if (emu.isConsole && (filePtr === stdoutFilePtr || filePtr === stderrFilePtr)) {
      for (let j = 0; j < result.length; j++) emu.consoleWriteChar(result.charCodeAt(j));
      emu.onConsoleOutput?.();
    }
    return result.length;
  });

  msvcrt.register('printf', 0, () => {
    const fmtPtr = emu.readArg(0);
    const fmt = emu.memory.readCString(fmtPtr);
    const result = formatString(fmt, stackArgReader(i => emu.readArg(i), 1), emu.memory, false);
    if (emu.isConsole) {
      for (let j = 0; j < result.length; j++) emu.consoleWriteChar(result.charCodeAt(j));
      emu.onConsoleOutput?.();
    }
    return result.length;
  });

  // Helper: read a line from stdin into a JS string, then run a callback.
  // onLine returns the integer value scanf/fgets should return.
  // Used by scanf / fscanf(stdin, ...) / gets / fgets(stdin, ...).
  const readStdinLine = (onLine: (line: string) => number): undefined => {
    const tmpBuf = emu.allocHeap(1024);
    emu._pendingReadConsole = { bufPtr: tmpBuf, nCharsToRead: 512, charsReadPtr: 0 };
    emu._lineEditBuffer = [];
    emu._lineEditCursor = 0;
    emu._lineEditStartX = emu.consoleCursorX;
    emu._lineEditStartY = emu.consoleCursorY;
    emu._commandHistoryIndex = emu._commandHistory.length;
    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu._consoleInputResume = {
      stackBytes,
      completer: (_emu, _retVal, sb) => {
        const line = emu.memory.readUTF16String(tmpBuf);
        const retVal = onLine(line);
        emuCompleteThunk(emu, retVal, sb);
      },
    };
    return undefined;
  };

  // scanf(fmt, ...) — read from stdin, parse with fmt, write to pointer args
  msvcrt.register('scanf', 0, () => {
    const fmtPtr = emu.readArg(0);
    const fmt = emu.memory.readCString(fmtPtr);
    // Snapshot arg pointers now (before suspend) — cdecl, args start at index 1
    const argPtrs: number[] = [];
    for (let i = 1; i < 32; i++) argPtrs.push(emu.readArg(i));
    return readStdinLine(line => scanString(line, fmt, i => argPtrs[i], 0, emu.memory, false));
  });

  // fscanf(stream, fmt, ...) — if stream is stdin, behave like scanf
  msvcrt.register('fscanf', 0, () => {
    const stream = emu.readArg(0);
    const fmtPtr = emu.readArg(1);
    const fmt = emu.memory.readCString(fmtPtr);
    if (stream !== stdinFilePtr && stream !== 0) return 0;
    const argPtrs: number[] = [];
    for (let i = 2; i < 32; i++) argPtrs.push(emu.readArg(i));
    return readStdinLine(line => scanString(line, fmt, i => argPtrs[i], 0, emu.memory, false));
  });

  msvcrt.register('fflush', 0, () => {
    // fflush(FILE* stream) — flush buffer, return 0 on success
    const stream = emu.readArg(0);
    // No-op in our emulator, just return 0 (success)
    return 0;
  });

  msvcrt.register('abort', 0, () => {
    // abort() — terminate the program abnormally
    emu.halted = true;
    emu.exitedNormally = false;
    return 0;
  });

  // atexit(void (*func)(void)) — register exit handler
  // We don't actually call them, just return 0 (success)
  msvcrt.register('atexit', 0, () => 0);
  msvcrt.register('_crt_atexit', 0, () => 0);
  msvcrt.register('_configure_narrow_argv', 0, () => 0);
  msvcrt.register('_configure_wide_argv', 0, () => 0);

  // puts(const char* str) — write string + newline to stdout
  msvcrt.register('puts', 0, () => {
    const strPtr = emu.readArg(0);
    if (!strPtr) return 1;

    const str = emu.memory.readCString(strPtr);
    const writeFileAPI = emu.apiDefs.get('KERNEL32.DLL:WriteFile');

    if (writeFileAPI && writeFileAPI.handler) {
      const STD_OUTPUT_HANDLE = 0xFFFFFFF5;
      // Allocate buffer for string + newline
      const bufLen = str.length + 1;
      const buf = emu.allocHeap(bufLen);
      for (let i = 0; i < str.length; i++) {
        emu.memory.writeU8(buf + i, str.charCodeAt(i));
      }
      emu.memory.writeU8(buf + str.length, 0x0A); // newline

      // Call WriteFile(STD_OUTPUT_HANDLE, buf, bufLen, NULL, NULL)
      const savedEsp = emu.cpu.reg[4]; // reg[4] = ESP
      emu.cpu.reg[4] = (emu.cpu.reg[4] - 24) >>> 0; // Make room for return address + 5 args
      emu.memory.writeU32(emu.cpu.reg[4] + 0, 0);                   // dummy return address
      emu.memory.writeU32(emu.cpu.reg[4] + 4, STD_OUTPUT_HANDLE);   // arg0
      emu.memory.writeU32(emu.cpu.reg[4] + 8, buf);                 // arg1
      emu.memory.writeU32(emu.cpu.reg[4] + 12, bufLen);             // arg2
      emu.memory.writeU32(emu.cpu.reg[4] + 16, 0);                  // arg3
      emu.memory.writeU32(emu.cpu.reg[4] + 20, 0);                  // arg4

      writeFileAPI.handler(emu);
      emu.cpu.reg[4] = savedEsp;
      return 1;
    }

    return 1;
  });

  msvcrt.register('putchar', 0, () => {
    // putchar(int ch) — write character to stdout
    const ch = emu.readArg(0) & 0xFF;
    const writeFileAPI = emu.apiDefs.get('KERNEL32.DLL:WriteFile');

    if (writeFileAPI && writeFileAPI.handler) {
      const STD_OUTPUT_HANDLE = 0xFFFFFFF5;
      const buf = emu.allocHeap(1);
      emu.memory.writeU8(buf, ch);

      const savedEsp = emu.cpu.reg[4]; // reg[4] = ESP
      emu.cpu.reg[4] = (emu.cpu.reg[4] - 24) >>> 0;
      emu.memory.writeU32(emu.cpu.reg[4] + 0, 0);                   // dummy return address
      emu.memory.writeU32(emu.cpu.reg[4] + 4, STD_OUTPUT_HANDLE);   // arg0
      emu.memory.writeU32(emu.cpu.reg[4] + 8, buf);                 // arg1
      emu.memory.writeU32(emu.cpu.reg[4] + 12, 1);                  // arg2
      emu.memory.writeU32(emu.cpu.reg[4] + 16, 0);                  // arg3
      emu.memory.writeU32(emu.cpu.reg[4] + 20, 0);                  // arg4

      writeFileAPI.handler(emu);
      emu.cpu.reg[4] = savedEsp;
      return ch;
    }

    return ch;
  });

  msvcrt.register('_getch', 0, () => {
    if (emu.consoleInputBuffer.length > 0) {
      return emu.consoleInputBuffer.shift()!.char;
    }
    // Block until a key is pressed
    emu._pendingGetch = true;
    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu._consoleInputResume = { stackBytes, completer: emuCompleteThunk };
    return undefined;
  });

  msvcrt.register('_purecall', 0, () => 0);

  msvcrt.register('atol', 0, () => {
    const str = emu.memory.readCString(emu.readArg(0));
    return parseInt(str, 10) || 0;
  });

  msvcrt.register('_wtol', 0, () => {
    const str = emu.memory.readUTF16String(emu.readArg(0));
    return parseInt(str, 10) || 0;
  });

  msvcrt.register('_wtoi', 0, () => {
    const str = emu.memory.readUTF16String(emu.readArg(0));
    return parseInt(str, 10) || 0;
  });

  msvcrt.register('_itow', 0, () => {
    const val = emu.readArg(0) | 0;
    const buf = emu.readArg(1);
    const radix = emu.readArg(2);
    const str = val.toString(radix || 10);
    if (buf) emu.memory.writeUTF16String(buf, str);
    return buf;
  });

  msvcrt.register('_ltow', 0, () => {
    const val = emu.readArg(0) | 0;
    const buf = emu.readArg(1);
    const radix = emu.readArg(2);
    const str = val.toString(radix || 10);
    if (buf) emu.memory.writeUTF16String(buf, str);
    return buf;
  });

  msvcrt.register('wcscpy', 0, () => {
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

  msvcrt.register('wcsncpy', 0, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    const count = emu.readArg(2);
    let done = false;
    for (let i = 0; i < count; i++) {
      if (!done) {
        const ch = emu.memory.readU16(src + i * 2);
        emu.memory.writeU16(dst + i * 2, ch);
        if (ch === 0) done = true;
      } else {
        emu.memory.writeU16(dst + i * 2, 0);
      }
    }
    return dst;
  });

  msvcrt.register('wcscat', 0, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    // Find end of dst
    let dstLen = 0;
    while (emu.memory.readU16(dst + dstLen * 2) !== 0) dstLen++;
    // Copy src
    let i = 0;
    while (true) {
      const ch = emu.memory.readU16(src + i * 2);
      emu.memory.writeU16(dst + (dstLen + i) * 2, ch);
      if (ch === 0) break;
      i++;
    }
    return dst;
  });

  // mbstowcs(wcstr, mbstr, count) — convert multibyte string to wide string
  msvcrt.register('mbstowcs', 0, () => {
    const wcstr = emu.readArg(0);
    const mbstr = emu.readArg(1);
    const count = emu.readArg(2);
    const str = emu.memory.readCString(mbstr);
    const len = Math.min(str.length, count);
    if (wcstr) emu.memory.writeUTF16String(wcstr, str.slice(0, len));
    return len;
  });

  // wcstombs(mbstr, wcstr, count) — convert wide string to multibyte string
  msvcrt.register('wcstombs', 0, () => {
    const mbstr = emu.readArg(0);
    const wcstr = emu.readArg(1);
    const count = emu.readArg(2);
    const str = emu.memory.readUTF16String(wcstr);
    const len = Math.min(str.length, count);
    if (mbstr) emu.memory.writeCString(mbstr, str.slice(0, len));
    return len;
  });

  msvcrt.register('wcscmp', 0, () => {
    const s1 = emu.readArg(0);
    const s2 = emu.readArg(1);
    let i = 0;
    while (true) {
      const a = emu.memory.readU16(s1 + i * 2);
      const b = emu.memory.readU16(s2 + i * 2);
      if (a !== b) return a < b ? -1 : 1;
      if (a === 0) return 0;
      i++;
    }
  });

  msvcrt.register('wcsncmp', 0, () => {
    const s1 = emu.readArg(0);
    const s2 = emu.readArg(1);
    const n = emu.readArg(2);
    for (let i = 0; i < n; i++) {
      const a = emu.memory.readU16(s1 + i * 2);
      const b = emu.memory.readU16(s2 + i * 2);
      if (a !== b) return a < b ? -1 : 1;
      if (a === 0) return 0;
    }
    return 0;
  });

  msvcrt.register('_wcsicmp', 0, () => {
    const s1 = emu.memory.readUTF16String(emu.readArg(0)).toLowerCase();
    const s2 = emu.memory.readUTF16String(emu.readArg(1)).toLowerCase();
    return s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
  });

  msvcrt.register('_wcsnicmp', 0, () => {
    const s1 = emu.memory.readUTF16String(emu.readArg(0)).toLowerCase();
    const s2 = emu.memory.readUTF16String(emu.readArg(1)).toLowerCase();
    const n = emu.readArg(2);
    const a = s1.slice(0, n);
    const b = s2.slice(0, n);
    return a < b ? -1 : a > b ? 1 : 0;
  });

  msvcrt.register('wcstok', 0, () => {
    // Simplified: return NULL
    return 0;
  });

  msvcrt.register('strncmp', 0, () => {
    const s1 = emu.readArg(0);
    const s2 = emu.readArg(1);
    const n = emu.readArg(2);
    for (let i = 0; i < n; i++) {
      const a = emu.memory.readU8(s1 + i);
      const b = emu.memory.readU8(s2 + i);
      if (a !== b) return a < b ? -1 : 1;
      if (a === 0) return 0;
    }
    return 0;
  });

  msvcrt.register('_strnicmp', 0, () => {
    const s1 = emu.readArg(0);
    const s2 = emu.readArg(1);
    const n = emu.readArg(2);
    for (let i = 0; i < n; i++) {
      let a = emu.memory.readU8(s1 + i);
      let b = emu.memory.readU8(s2 + i);
      if (a >= 0x41 && a <= 0x5A) a += 0x20;
      if (b >= 0x41 && b <= 0x5A) b += 0x20;
      if (a !== b) return a < b ? -1 : 1;
      if (a === 0) return 0;
    }
    return 0;
  });

  msvcrt.register('_strcmpi', 0, () => {
    const s1 = emu.memory.readCString(emu.readArg(0)).toLowerCase();
    const s2 = emu.memory.readCString(emu.readArg(1)).toLowerCase();
    return s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
  });

  msvcrt.register('strrchr', 0, () => {
    const sPtr = emu.readArg(0);
    const ch = emu.readArg(1) & 0xFF;
    const str = emu.memory.readCString(sPtr);
    const idx = str.lastIndexOf(String.fromCharCode(ch));
    return idx >= 0 ? sPtr + idx : 0;
  });

  msvcrt.register('_wsplitpath', 0, () => {
    // _wsplitpath(path, drive, dir, fname, ext) — just write empty strings
    const drive = emu.readArg(1);
    const dir = emu.readArg(2);
    const fname = emu.readArg(3);
    const ext = emu.readArg(4);
    if (drive) emu.memory.writeU16(drive, 0);
    if (dir) emu.memory.writeU16(dir, 0);
    if (fname) emu.memory.writeU16(fname, 0);
    if (ext) emu.memory.writeU16(ext, 0);
    return 0;
  });

  msvcrt.register('_getdcwd', 0, () => {
    // _getdcwd(drive, buffer, maxlen) — return "C:\"
    const buf = emu.readArg(1);
    if (buf) emu.memory.writeCString(buf, 'C:\\');
    return buf;
  });

  msvcrt.register('towupper', 0, () => {
    const ch = emu.readArg(0) & 0xFFFF;
    return String.fromCharCode(ch).toUpperCase().charCodeAt(0);
  });

  msvcrt.register('towlower', 0, () => {
    const ch = emu.readArg(0) & 0xFFFF;
    return String.fromCharCode(ch).toLowerCase().charCodeAt(0);
  });

  msvcrt.register('isdigit', 0, () => {
    const ch = emu.readArg(0) & 0xFF;
    return (ch >= 0x30 && ch <= 0x39) ? 1 : 0;
  });
  msvcrt.register('isalpha', 0, () => {
    const ch = emu.readArg(0) & 0xFF;
    return ((ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A)) ? 1 : 0;
  });
  msvcrt.register('isalnum', 0, () => {
    const ch = emu.readArg(0) & 0xFF;
    return ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A)) ? 1 : 0;
  });
  msvcrt.register('isupper', 0, () => {
    const ch = emu.readArg(0) & 0xFF;
    return (ch >= 0x41 && ch <= 0x5A) ? 1 : 0;
  });
  msvcrt.register('islower', 0, () => {
    const ch = emu.readArg(0) & 0xFF;
    return (ch >= 0x61 && ch <= 0x7A) ? 1 : 0;
  });
  msvcrt.register('isspace', 0, () => {
    const ch = emu.readArg(0) & 0xFF;
    return (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D || ch === 0x0B || ch === 0x0C) ? 1 : 0;
  });
  msvcrt.register('isprint', 0, () => {
    const ch = emu.readArg(0) & 0xFF;
    return (ch >= 0x20 && ch <= 0x7E) ? 1 : 0;
  });
  msvcrt.register('ispunct', 0, () => {
    const ch = emu.readArg(0) & 0xFF;
    return (ch >= 0x21 && ch <= 0x7E && !((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A))) ? 1 : 0;
  });
  msvcrt.register('iscntrl', 0, () => {
    const ch = emu.readArg(0) & 0xFF;
    return (ch < 0x20 || ch === 0x7F) ? 1 : 0;
  });
  msvcrt.register('isxdigit', 0, () => {
    const ch = emu.readArg(0) & 0xFF;
    return ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66)) ? 1 : 0;
  });

  msvcrt.register('iswalpha', 0, () => {
    const ch = emu.readArg(0) & 0xFFFF;
    const c = String.fromCharCode(ch);
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ? 1 : 0;
  });

  msvcrt.register('iswdigit', 0, () => {
    const ch = emu.readArg(0) & 0xFFFF;
    return (ch >= 0x30 && ch <= 0x39) ? 1 : 0;
  });

  msvcrt.register('iswspace', 0, () => {
    const ch = emu.readArg(0) & 0xFFFF;
    return (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D || ch === 0x0B || ch === 0x0C) ? 1 : 0;
  });

  // MSVCRT wctype_t bitmask constants (from <wctype.h> / ctype.h)
  const _UPPER   = 0x0001;
  const _LOWER   = 0x0002;
  const _DIGIT   = 0x0004;
  const _SPACE   = 0x0008;
  const _PUNCT   = 0x0010;
  const _CONTROL = 0x0020;
  const _BLANK   = 0x0040;
  const _HEX     = 0x0080;
  const _ALPHA   = 0x0100;

  const getWctype = (ch: number): number => {
    if (ch > 0xFFFF) return 0;
    const c = String.fromCharCode(ch);
    let mask = 0;
    if (c >= 'A' && c <= 'Z') mask |= _UPPER | _ALPHA;
    if (c >= 'a' && c <= 'z') mask |= _LOWER | _ALPHA;
    if (ch >= 0x30 && ch <= 0x39) mask |= _DIGIT;
    if (ch === 0x20 || ch === 0x09) mask |= _BLANK | _SPACE;
    if (ch === 0x0A || ch === 0x0D || ch === 0x0B || ch === 0x0C) mask |= _SPACE;
    if (ch >= 0x00 && ch <= 0x1F || ch === 0x7F) mask |= _CONTROL;
    if (ch >= 0x30 && ch <= 0x39 || (ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66)) mask |= _HEX;
    if (ch > 0x20 && ch < 0x7F && !(mask & (_ALPHA | _DIGIT))) mask |= _PUNCT;
    return mask;
  };

  // iswctype(wc, wctype) — test wide char wc against character class desc
  msvcrt.register('iswctype', 0, () => {
    const ch   = emu.readArg(0) & 0xFFFF;
    const desc = emu.readArg(1);
    return (getWctype(ch) & desc) ? 1 : 0;
  });

  // wctype(property) — return wctype_t bitmask for named character class
  msvcrt.register('wctype', 0, () => {
    const namePtr = emu.readArg(0);
    if (!namePtr) return 0;
    const name = emu.memory.readCString(namePtr);
    switch (name) {
      case 'upper':  return _UPPER;
      case 'lower':  return _LOWER;
      case 'digit':  return _DIGIT;
      case 'space':  return _SPACE;
      case 'punct':  return _PUNCT;
      case 'cntrl':  return _CONTROL;
      case 'blank':  return _BLANK;
      case 'xdigit': return _HEX;
      case 'alpha':  return _ALPHA;
      case 'alnum':  return _ALPHA | _DIGIT;
      case 'graph':  return _ALPHA | _DIGIT | _PUNCT;
      case 'print':  return _ALPHA | _DIGIT | _PUNCT | _BLANK;
      default:       return 0;
    }
  });

  msvcrt.register('setlocale', 0, () => 0); // return NULL (fail)

  msvcrt.register('_ultoa', 0, () => {
    const val = emu.readArg(0) >>> 0;
    const buf = emu.readArg(1);
    const radix = emu.readArg(2) || 10;
    const str = val.toString(radix);
    if (buf) emu.memory.writeCString(buf, str);
    return buf;
  });

  // _setjmp3 — save CPU state into jmp_buf for setjmp/longjmp.
  // jmp_buf layout (MSVC _JUMP_BUFFER): Ebp(0), Ebx(4), Edi(8), Esi(12), Esp(16), Eip(20), ...
  // _setjmp3(buf, ...) — cdecl, nArgs=0
  // When thunk fires: stack is [retAddr, buf, ...]
  // After completeThunk (cdecl nArgs=0): ESP += 4 (pop retAddr), EIP = retAddr
  // Caller then cleans up args. We save the post-completeThunk state.
  msvcrt.register('_setjmp3', 0, () => {
    const buf = emu.readArg(0);
    const ESP = 4, EBP = 5, EBX = 3, EDI = 7, ESI = 6;
    const retAddr = emu.memory.readU32(emu.cpu.reg[ESP] >>> 0);
    emu.memory.writeU32(buf + 0, emu.cpu.reg[EBP]);
    emu.memory.writeU32(buf + 4, emu.cpu.reg[EBX]);
    emu.memory.writeU32(buf + 8, emu.cpu.reg[EDI]);
    emu.memory.writeU32(buf + 12, emu.cpu.reg[ESI]);
    // Save ESP as it will be after thunk cleanup (pop retAddr)
    emu.memory.writeU32(buf + 16, (emu.cpu.reg[ESP] + 4) >>> 0);
    emu.memory.writeU32(buf + 20, retAddr);
    return 0;
  });

  // longjmp(jmp_buf, value) — restore CPU state and return value to setjmp call site
  msvcrt.register('longjmp', 0, () => {
    const buf = emu.readArg(0);
    const value = emu.readArg(1) || 1; // longjmp(buf, 0) returns 1
    const EAX = 0, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;
    emu.cpu.reg[EBP] = emu.memory.readU32(buf + 0);
    emu.cpu.reg[EBX] = emu.memory.readU32(buf + 4);
    emu.cpu.reg[EDI] = emu.memory.readU32(buf + 8);
    emu.cpu.reg[ESI] = emu.memory.readU32(buf + 12);
    emu.cpu.reg[ESP] = emu.memory.readU32(buf + 16);
    emu.cpu.eip = emu.memory.readU32(buf + 20);
    emu.cpu.reg[EAX] = value;
    return undefined;
  });

  const writeWideN = (bufPtr: number, count: number, result: string) => {
    const writeLen = Math.min(result.length, count > 0 ? count - 1 : 0);
    if (bufPtr) {
      for (let j = 0; j < writeLen; j++) emu.memory.writeU16(bufPtr + j * 2, result.charCodeAt(j));
      if (count > 0) emu.memory.writeU16(bufPtr + writeLen * 2, 0);
    }
    return result.length;
  };

  const writeNarrowN = (bufPtr: number, count: number, result: string) => {
    const writeLen = Math.min(result.length, count > 0 ? count - 1 : 0);
    if (bufPtr) {
      for (let j = 0; j < writeLen; j++) emu.memory.writeU8(bufPtr + j, result.charCodeAt(j) & 0xFF);
      if (count > 0) emu.memory.writeU8(bufPtr + writeLen, 0);
    }
    return result.length;
  };

  msvcrt.register('_vsnprintf', 0, () => {
    const bufPtr = emu.readArg(0);
    const count = emu.readArg(1);
    const fmtPtr = emu.readArg(2);
    const vaList = emu.readArg(3);
    if (!fmtPtr) return 0;
    const fmt = emu.memory.readCString(fmtPtr);
    const result = formatString(fmt, vaListArgReader(emu.memory, vaList), emu.memory, false);
    return writeNarrowN(bufPtr, count, result);
  });

  msvcrt.register('_snprintf', 0, () => {
    const bufPtr = emu.readArg(0);
    const count = emu.readArg(1);
    const fmtPtr = emu.readArg(2);
    if (!fmtPtr) return 0;
    const fmt = emu.memory.readCString(fmtPtr);
    const result = formatString(fmt, stackArgReader(i => emu.readArg(i), 3), emu.memory, false);
    return writeNarrowN(bufPtr, count, result);
  });

  msvcrt.register('_vsnwprintf', 0, () => {
    const bufPtr = emu.readArg(0);
    const count = emu.readArg(1);
    const fmtPtr = emu.readArg(2);
    const vaList = emu.readArg(3);
    if (!fmtPtr) return 0;
    const fmt = emu.memory.readUTF16String(fmtPtr);
    const result = formatString(fmt, vaListArgReader(emu.memory, vaList), emu.memory, true);
    return writeWideN(bufPtr, count, result);
  });

  msvcrt.register('_snwprintf', 0, () => {
    const bufPtr = emu.readArg(0);
    const count = emu.readArg(1);
    const fmtPtr = emu.readArg(2);
    if (!fmtPtr) return 0;
    const fmt = emu.memory.readUTF16String(fmtPtr);
    const result = formatString(fmt, stackArgReader(i => emu.readArg(i), 3), emu.memory, true);
    return writeWideN(bufPtr, count, result);
  });

  // strcat
  msvcrt.register('strcat', 0, () => {
    const dest = emu.readArg(0);
    const src = emu.readArg(1);
    // Find end of dest
    let end = dest;
    while (emu.memory.readU8(end) !== 0) end++;
    // Copy src
    let i = 0;
    while (true) {
      const ch = emu.memory.readU8(src + i);
      emu.memory.writeU8(end + i, ch);
      if (ch === 0) break;
      i++;
    }
    return dest;
  });

  // strncpy
  msvcrt.register('strncpy', 0, () => {
    const dest = emu.readArg(0);
    const src = emu.readArg(1);
    const n = emu.readArg(2);
    let hitNull = false;
    for (let i = 0; i < n; i++) {
      if (!hitNull) {
        const ch = emu.memory.readU8(src + i);
        emu.memory.writeU8(dest + i, ch);
        if (ch === 0) hitNull = true;
      } else {
        emu.memory.writeU8(dest + i, 0);
      }
    }
    return dest;
  });

  // _mbsstr — find substring (treat as strstr for SBCS)
  msvcrt.register('_mbsstr', 0, () => {
    const haystack = emu.readArg(0);
    const needle = emu.readArg(1);
    const h = emu.memory.readCString(haystack);
    const n = emu.memory.readCString(needle);
    const idx = h.indexOf(n);
    return idx >= 0 ? haystack + idx : 0;
  });

  // atoi
  msvcrt.register('atoi', 0, () => {
    const str = emu.memory.readCString(emu.readArg(0));
    return parseInt(str, 10) || 0;
  });

  // strtol / strtoul / wcstol
  const strtolImpl = (readStr: (addr: number) => string, charSize: number) => {
    const nptr = emu.readArg(0);
    const endptrPtr = emu.readArg(1);
    const base = emu.readArg(2);
    const str = readStr(nptr);
    // Find how many chars are consumed
    const trimmed = str.replace(/^\s+/, '');
    const leadingSpaces = str.length - trimmed.length;
    let parsed = parseInt(trimmed, base || 10);
    if (isNaN(parsed)) parsed = 0;
    // Find end position: parseInt stops at first invalid char
    // Use a regex to find the consumed portion
    let consumed = 0;
    const match = trimmed.match(/^[+-]?(?:0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*|0)/);
    if (match) consumed = match[0].length;
    if (endptrPtr) {
      emu.memory.writeU32(endptrPtr, nptr + (leadingSpaces + consumed) * charSize);
    }
    return parsed | 0;
  };

  msvcrt.register('strtol', 0, () => strtolImpl(a => emu.memory.readCString(a), 1));
  msvcrt.register('strtoul', 0, () => strtolImpl(a => emu.memory.readCString(a), 1) >>> 0);
  msvcrt.register('wcstol', 0, () => strtolImpl(a => emu.memory.readUTF16String(a), 2));

  // FILE I/O: fopen, fread, fwrite, fclose, fseek, ftell, feof, fflush, fgetc, fputc, fgets, fputs
  interface CrtFile {
    filePtr: number;  // address of FILE struct in emulated memory
    data: Uint8Array;
    pos: number;
    writable: boolean;
    path: string;
  }
  const crtFiles = new Map<number, CrtFile>();

  msvcrt.register('fopen', 0, () => {
    const pathPtr = emu.readArg(0);
    const modePtr = emu.readArg(1);
    const path = emu.memory.readCString(pathPtr);
    const mode = emu.memory.readCString(modePtr);

    console.log(`[MSVCRT] fopen("${path}", "${mode}")`);

    // Resolve file from additionalFiles or file system
    const resolved = path.replace(/\\/g, '/');
    const baseName = resolved.split('/').pop()?.toUpperCase() || '';

    // Try to find file in additionalFiles
    let fileData: ArrayBuffer | undefined;
    for (const [name, ab] of emu.additionalFiles) {
      if (name.toUpperCase() === baseName) {
        fileData = ab;
        break;
      }
    }

    if (!fileData) {
      // Try file system (findFile + sync data)
      const resolvedPath = emu.resolvePath(path);
      const fileInfo = emu.fs.findFile(resolvedPath, emu.additionalFiles);
      if (fileInfo) {
        if (fileInfo.source === 'additional') {
          fileData = emu.additionalFiles.get(fileInfo.name) ?? undefined;
        } else if (fileInfo.source === 'external') {
          const ext = emu.fs.externalFiles.get(resolvedPath.toUpperCase());
          if (ext) fileData = ext.data.buffer.slice(ext.data.byteOffset, ext.data.byteOffset + ext.data.byteLength) as ArrayBuffer;
        }
      }
    }

    const writable = mode.includes('w') || mode.includes('a') || mode.includes('+');

    if (!fileData && !writable) {
      console.log(`[MSVCRT] fopen: file not found: ${path}`);
      return 0; // NULL — file not found
    }

    // Allocate FILE struct (32 bytes)
    const fileStructPtr = emu.allocHeap(32);
    const data = fileData ? new Uint8Array(fileData) : new Uint8Array(0);
    crtFiles.set(fileStructPtr, {
      filePtr: fileStructPtr,
      data,
      pos: mode.includes('a') ? data.length : 0,
      writable,
      path,
    });

    console.log(`[MSVCRT] fopen: opened ${path} (${data.length} bytes) => 0x${fileStructPtr.toString(16)}`);
    return fileStructPtr;
  });

  msvcrt.register('fread', 0, () => {
    const bufPtr = emu.readArg(0);
    const size = emu.readArg(1);
    const count = emu.readArg(2);
    const streamPtr = emu.readArg(3);
    const file = crtFiles.get(streamPtr);
    if (!file) return 0;
    const totalBytes = size * count;
    const available = file.data.length - file.pos;
    const toRead = Math.min(totalBytes, available);
    for (let i = 0; i < toRead; i++) {
      emu.memory.writeU8(bufPtr + i, file.data[file.pos + i]);
    }
    file.pos += toRead;
    return Math.floor(toRead / size); // return number of complete items read
  });

  msvcrt.register('fwrite', 0, () => {
    const bufPtr = emu.readArg(0);
    const size = emu.readArg(1);
    const count = emu.readArg(2);
    const streamPtr = emu.readArg(3);
    const file = crtFiles.get(streamPtr);
    if (!file) return 0;
    const totalBytes = size * count;
    // Extend data if needed
    const newSize = Math.max(file.data.length, file.pos + totalBytes);
    if (newSize > file.data.length) {
      const newData = new Uint8Array(newSize);
      newData.set(file.data);
      file.data = newData;
    }
    for (let i = 0; i < totalBytes; i++) {
      file.data[file.pos + i] = emu.memory.readU8(bufPtr + i);
    }
    file.pos += totalBytes;
    return count;
  });

  msvcrt.register('fclose', 0, () => {
    const streamPtr = emu.readArg(0);
    crtFiles.delete(streamPtr);
    return 0;
  });

  msvcrt.register('fseek', 0, () => {
    const streamPtr = emu.readArg(0);
    const offset = emu.readArg(1) | 0; // signed
    const origin = emu.readArg(2);
    const file = crtFiles.get(streamPtr);
    if (!file) return -1;
    const SEEK_SET = 0, SEEK_CUR = 1, SEEK_END = 2;
    if (origin === SEEK_SET) file.pos = offset;
    else if (origin === SEEK_CUR) file.pos += offset;
    else if (origin === SEEK_END) file.pos = file.data.length + offset;
    file.pos = Math.max(0, Math.min(file.pos, file.data.length));
    return 0;
  });

  msvcrt.register('ftell', 0, () => {
    const streamPtr = emu.readArg(0);
    const file = crtFiles.get(streamPtr);
    return file ? file.pos : -1;
  });

  msvcrt.register('feof', 0, () => {
    const streamPtr = emu.readArg(0);
    const file = crtFiles.get(streamPtr);
    return file ? (file.pos >= file.data.length ? 1 : 0) : 1;
  });

  msvcrt.register('fgetc', 0, () => {
    const streamPtr = emu.readArg(0);
    const file = crtFiles.get(streamPtr);
    if (!file || file.pos >= file.data.length) return -1; // EOF
    return file.data[file.pos++];
  });

  msvcrt.register('fputc', 0, () => {
    const ch = emu.readArg(0);
    const streamPtr = emu.readArg(1);
    const file = crtFiles.get(streamPtr);
    if (!file) return -1;
    if (file.pos >= file.data.length) {
      const newData = new Uint8Array(file.data.length + 1024);
      newData.set(file.data);
      file.data = newData;
    }
    file.data[file.pos++] = ch & 0xFF;
    return ch & 0xFF;
  });

  msvcrt.register('fgets', 0, () => {
    const bufPtr = emu.readArg(0);
    const maxCount = emu.readArg(1);
    const streamPtr = emu.readArg(2);
    const file = crtFiles.get(streamPtr);
    if (!file || file.pos >= file.data.length) return 0; // NULL on EOF
    let i = 0;
    while (i < maxCount - 1 && file.pos < file.data.length) {
      const ch = file.data[file.pos++];
      emu.memory.writeU8(bufPtr + i, ch);
      i++;
      if (ch === 0x0A) break; // newline
    }
    emu.memory.writeU8(bufPtr + i, 0); // null-terminate
    return bufPtr;
  });

  msvcrt.register('fputs', 0, () => {
    const strPtr = emu.readArg(0);
    const streamPtr = emu.readArg(1);
    const file = crtFiles.get(streamPtr);
    if (!file) return -1;
    const str = emu.memory.readCString(strPtr);
    for (let i = 0; i < str.length; i++) {
      if (file.pos >= file.data.length) {
        const newData = new Uint8Array(file.data.length + 1024);
        newData.set(file.data);
        file.data = newData;
      }
      file.data[file.pos++] = str.charCodeAt(i);
    }
    return 0;
  });

  // sscanf — cdecl varargs: sscanf(str, fmt, ...)
  msvcrt.register('sscanf', 0, () => {
    const strPtr = emu.readArg(0);
    const fmtPtr = emu.readArg(1);
    const str = emu.memory.readCString(strPtr);
    const fmt = emu.memory.readCString(fmtPtr);
    return scanString(str, fmt, i => emu.readArg(i), 2, emu.memory, false);
  });

  // swscanf — cdecl varargs: swscanf(str, fmt, ...) — wide version
  msvcrt.register('swscanf', 0, () => {
    const strPtr = emu.readArg(0);
    const fmtPtr = emu.readArg(1);
    const str = emu.memory.readUTF16String(strPtr);
    const fmt = emu.memory.readUTF16String(fmtPtr);
    return scanString(str, fmt, i => emu.readArg(i), 2, emu.memory, true);
  });

  // Alias all MSVCRT.DLL entries to other MSVCR*.DLL variants
  for (const [key, val] of emu.apiDefs.entries()) {
    if (key.startsWith('MSVCRT.DLL:')) {
      const name = key.slice(11);
      emu.apiDefs.set('MSVCRT20.DLL:' + name, val);
      emu.apiDefs.set('MSVCRT40.DLL:' + name, val);
      emu.apiDefs.set('MSVCR110.DLL:' + name, val);
      emu.apiDefs.set('MSVCR120.DLL:' + name, val);
      emu.apiDefs.set('MSVCR100.DLL:' + name, val);
      emu.apiDefs.set('MSVCR90.DLL:' + name, val);
      emu.apiDefs.set('MSVCR80.DLL:' + name, val);
      emu.apiDefs.set('MSVCR71.DLL:' + name, val);
      emu.apiDefs.set('MSVCR70.DLL:' + name, val);
    }
  }
}
