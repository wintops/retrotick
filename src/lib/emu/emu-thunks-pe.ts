import type { Emulator } from './emulator';
import { extractStrings } from '../pe/extract-string';

export function buildThunkTable(emu: Emulator): void {

  // Well-known ordinal-to-name mappings for DLLs that export by ordinal
  const ordinalMap: Record<string, Record<number, string>> = {
    'COMCTL32.DLL': {
      2: 'MenuHelp', 4: 'GetEffectiveClientRect',
      7: 'CreateToolbar', 8: 'CreateMappedBitmap', 17: 'InitCommonControls',
      71: 'ImageList_Create', 72: 'ImageList_Destroy', 73: 'ImageList_GetImageCount',
      74: 'ImageList_Add', 75: 'ImageList_ReplaceIcon', 76: 'ImageList_Remove',
      84: 'ImageList_SetBkColor', 85: 'ImageList_GetBkColor',
      236: 'Str_SetPtrW',
      329: 'DSA_Destroy', 337: 'DPA_DeletePtr', 338: 'DPA_DeleteAllPtrs', 340: 'DPA_CreateEx',
      320: 'CreatePropertySheetPageA', 321: 'CreatePropertySheetPageW',
      322: 'DestroyPropertySheetPage',
      334: 'PropertySheetA', 335: 'PropertySheetW',
      358: 'StrChrW', 359: 'StrRChrW', 363: 'StrStrIW', 365: 'StrToIntW',
      410: 'FlatSB_SetScrollProp', 413: 'FlatSB_SetScrollInfo',
    },
    'SHLWAPI.DLL': {
      219: 'SHLoadIndirectString',
      437: 'IsOS',
    },
    'SHELL32.DLL': {
      30: 'PathBuildRootA', // shlwapi
      34: 'PathRemoveBlanksA', // shlwapi
      36: 'PathAppendA', // shlwapi
      39: 'PathIsRelativeA', // shlwapi
      45: 'PathFileExistsA', // shlwapi
      61: 'ord_61', // RunFileDlg
      100: 'ord_100', // IsExeTSAware / SHDefExtractIcon
      183: 'ShellMessageBoxA',
      195: 'SHFree',
    },
    'WINMM.DLL': {
      2: 'PlaySoundA',
    },
    'WS2_32.DLL': {
      1: 'accept', 2: 'bind', 3: 'closesocket', 4: 'connect',
      5: 'getpeername', 6: 'getsockname', 7: 'getsockopt',
      8: 'htonl', 9: 'htons', 10: 'ioctlsocket',
      11: 'inet_addr', 12: 'inet_ntoa', 13: 'listen',
      14: 'ntohl', 15: 'ntohs', 16: 'recv', 17: 'recvfrom',
      18: 'select', 19: 'send', 20: 'sendto', 21: 'setsockopt',
      22: 'shutdown', 23: 'socket',
      51: 'gethostbyaddr', 52: 'gethostbyname',
      53: 'getprotobyname', 54: 'getprotobynumber',
      55: 'getservbyname', 56: 'getservbyport', 57: 'gethostname',
      101: 'WSAStartup', 102: 'WSACleanup', 103: 'WSASetLastError',
      104: 'WSAGetLastError', 105: 'WSAIsBlocking',
      108: 'WSACancelBlockingCall',
      111: 'WSAAsyncGetProtoByName', 112: 'WSAAsyncGetProtoByNumber',
      113: 'WSAAsyncGetHostByName', 114: 'WSAAsyncGetHostByAddr',
      115: 'WSACancelAsyncRequest', 116: 'WSAAsyncSelect',
    },
    // WSOCK32 ordinals are DIFFERENT from WS2_32 above ordinal 100!
    'WSOCK32.DLL': {
      1: 'accept', 2: 'bind', 3: 'closesocket', 4: 'connect',
      5: 'getpeername', 6: 'getsockname', 7: 'getsockopt',
      8: 'htonl', 9: 'htons', 10: 'ioctlsocket',
      11: 'inet_addr', 12: 'inet_ntoa', 13: 'listen',
      14: 'ntohl', 15: 'ntohs', 16: 'recv', 17: 'recvfrom',
      18: 'select', 19: 'send', 20: 'sendto', 21: 'setsockopt',
      22: 'shutdown', 23: 'socket',
      51: 'gethostbyaddr', 52: 'gethostbyname',
      53: 'getprotobyname', 54: 'getprotobynumber',
      55: 'getservbyname', 56: 'getservbyport', 57: 'gethostname',
      101: 'WSAAsyncSelect', 102: 'WSAAsyncGetHostByAddr',
      103: 'WSAAsyncGetHostByName', 104: 'WSAAsyncGetProtoByName',
      105: 'WSAAsyncGetProtoByNumber', 106: 'WSAAsyncGetServByName',
      107: 'WSAAsyncGetServByPort', 108: 'WSACancelAsyncRequest',
      109: 'WSASetBlockingHook', 110: 'WSAUnhookBlockingHook',
      111: 'WSAGetLastError', 112: 'WSASetLastError',
      113: 'WSACancelBlockingCall', 114: 'WSAIsBlocking',
      115: 'WSAStartup', 116: 'WSACleanup',
    },
    'COREDLL.DLL': {
      23: 'GetLocalTime',
      61: 'wcscpy', 63: 'wcslen',
      90: 'CreateDIBSection', 95: 'RegisterClassW',
      246: 'CreateWindowExW', 247: 'SetWindowPos', 248: 'GetWindowRect',
      250: 'InvalidateRect', 260: 'BeginPaint', 261: 'EndPaint',
      262: 'GetDC', 264: 'DefWindowProcW', 265: 'DestroyWindow',
      266: 'ShowWindow', 267: 'UpdateWindow',
      535: 'GetTickCount',
      708: 'SetCapture', 709: 'ReleaseCapture',
      858: 'MessageBoxW', 859: 'DispatchMessageW', 861: 'GetMessageW',
      865: 'PostMessageW', 866: 'PostQuitMessage', 870: 'TranslateMessage',
      873: 'LoadBitmapW', 874: 'LoadStringW', 875: 'SetTimer', 876: 'KillTimer',
      885: 'GetSystemMetrics', 895: 'CreateFontIndirectW',
      902: 'CreateCompatibleBitmap', 903: 'BitBlt',
      909: 'CreateDCW', 910: 'CreateCompatibleDC', 911: 'DeleteDC',
      912: 'DeleteObject', 918: 'GetObjectW', 919: 'GetStockObject',
      921: 'SelectObject', 923: 'SetBkMode', 924: 'SetTextColor',
      931: 'CreateSolidBrush', 933: 'DrawFocusRect', 936: 'GetPixel',
      941: 'Rectangle', 945: 'DrawTextW',
      968: 'CombineRgn', 980: 'CreateRectRgn',
      1018: 'free', 1041: 'malloc', 1047: 'memset', 1053: 'rand', 1061: 'srand',
      1097: 'swprintf', 1398: 'SetWindowRgn',
    },
    'OLEAUT32.DLL': {
      2: 'SysAllocString', 3: 'SysReAllocString', 4: 'SysAllocStringLen',
      5: 'SysReAllocStringLen', 6: 'SysFreeString', 7: 'SysStringLen',
      8: 'VariantInit', 9: 'VariantClear', 10: 'VariantCopy',
      11: 'SafeArrayDestroy', 12: 'VariantChangeType',
      147: 'VariantChangeTypeEx',
      149: 'SysAllocStringLen', 150: 'SysFreeString', 151: 'SysStringLen',
    },
  };

  // DLL name aliases (map old names to canonical names used in API registration)
  const dllAliases: Record<string, string> = {
    // WSOCK32 has its own ordinal mapping above — only alias for API name resolution
    'WSOCK32.DLL': 'WS2_32.DLL',
    'API-MS-WIN-CRT-RUNTIME-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-STDIO-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-STRING-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-MATH-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-HEAP-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-LOCALE-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-CONVERT-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-ENVIRONMENT-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-TIME-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-FILESYSTEM-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-UTILITY-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-MULTIBYTE-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-CONIO-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-PROCESS-L1-1-0.DLL': 'MSVCRT.DLL',
    'UCRTBASE.DLL': 'MSVCRT.DLL',
    'VCRUNTIME140.DLL': 'MSVCRT.DLL',
  };

  // MSVCRT uses cdecl (caller cleans stack), so nArgs=0 is correct for them
  const cdeclDlls = new Set([
    'MSVCRT.DLL', 'MSVCRT20.DLL', 'MSVCRT40.DLL',
    'MSVCR70.DLL', 'MSVCR71.DLL', 'MSVCR80.DLL', 'MSVCR90.DLL',
    'MSVCR100.DLL', 'MSVCR110.DLL', 'MSVCR120.DLL',
    'UCRTBASE.DLL', 'VCRUNTIME140.DLL',
  ]);

  for (const [addr, info] of emu.pe.apiMap) {
    // Resolve ordinal imports to names BEFORE alias renaming (ordinals differ between WSOCK32 and WS2_32)
    const ordMatch = info.name.match(/^ord_(\d+)$/);
    if (ordMatch) {
      const ord = parseInt(ordMatch[1]);
      const nameFromOrd = ordinalMap[info.dll]?.[ord];
      if (nameFromOrd) info.name = nameFromOrd;
    }
    // Normalize DLL name aliases
    info.dll = dllAliases[info.dll] || info.dll;

    const key = `${info.dll}:${info.name}`;
    const def = emu.apiDefs.get(key);
    const stackBytes = def?.stackBytes ?? 0;
    // Suppress warning for DLLs provided as additional files (they'll be resolved by pre-loading)
    const dllBasename = info.dll.toLowerCase();
    const hasExternalDll = [...emu.additionalFiles.keys()].some(f => f.toLowerCase() === dllBasename);
    if (!def && !cdeclDlls.has(info.dll) && !hasExternalDll) {
      console.warn(`[THUNK] No API definition for ${info.dll}:${info.name} — defaulting to stackBytes=0`);
    }
    emu.thunkToApi.set(addr, { dll: info.dll, name: info.name, stackBytes });
  }
}

export function preloadStrings(emu: Emulator): void {
  const strings = extractStrings(emu.peInfo, emu.arrayBuffer);
  // Track which language each string came from; prefer English (0x09) or neutral (0x00)
  const langMap = new Map<number, number>(); // id → languageId
  for (const s of strings) {
    const prevLang = langMap.get(s.id);
    if (prevLang !== undefined) {
      const prevPrimary = prevLang & 0x3FF;
      const curPrimary = (s.languageId || 0) & 0x3FF;
      // Skip if we already have English and this isn't English
      if (prevPrimary === 0x09 && curPrimary !== 0x09) continue;
      // Skip if we already have neutral and this isn't English or neutral
      if (prevPrimary === 0x00 && curPrimary !== 0x09 && curPrimary !== 0x00) continue;
    }
    emu.stringCache.set(s.id, s.string);
    langMap.set(s.id, s.languageId || 0);
  }
}

export function verifyIAT(emu: Emulator): void {
  const base = emu.pe.imageBase;
  const end = base + Math.min(emu.pe.sizeOfImage, 0x2000);
  let unresolved = 0;
  for (let addr = base + 0x1000; addr < end; addr += 2) {
    if (emu.memory.readU8(addr) === 0xFF && emu.memory.readU8(addr + 1) === 0x25) {
      const iatAddr = emu.memory.readU32(addr + 2);
      // Skip false positives where iatAddr is outside the image
      if (iatAddr < base || iatAddr >= base + emu.pe.sizeOfImage) continue;
      const target = emu.memory.readU32(iatAddr);
      if (!emu.thunkToApi.has(target)) {
        console.warn(`[IAT] Unresolved import stub at 0x${addr.toString(16)}: JMP [0x${iatAddr.toString(16)}] → 0x${target.toString(16)} (not a thunk)`);
        unresolved++;
      }
    }
  }
  if (unresolved > 0) {
    console.warn(`[IAT] ${unresolved} unresolved import stubs found!`);
  }
}

/**
 * Initialize a TEB (Thread Environment Block) for a thread.
 * Returns the TEB address. For the main thread, also creates PEB and process params.
 */
export function initThreadTEB(emu: Emulator, stackTop: number, threadId: number, pebAddr?: number): number {
  const tebSize = 0x1000;
  const teb = emu.allocHeap(tebSize);
  const tlsSlots = emu.allocHeap(256 * 4);

  let peb = pebAddr || 0;
  if (!peb) {
    // Main thread: create PEB and process params
    peb = emu.allocHeap(0x100);
    const processParams = emu.allocHeap(0x80);
    const STD_INPUT_HANDLE  = 0xFFFFFFF6;
    const STD_OUTPUT_HANDLE = 0xFFFFFFF5;
    const STD_ERROR_HANDLE  = 0xFFFFFFF4;
    emu.memory.writeU32(processParams + 0x18, STD_INPUT_HANDLE);
    emu.memory.writeU32(processParams + 0x1C, STD_OUTPUT_HANDLE);
    emu.memory.writeU32(processParams + 0x20, STD_ERROR_HANDLE);
    emu.memory.writeU32(peb + 0x08, emu.pe.imageBase);
    emu.memory.writeU32(peb + 0x0C, 0);
    emu.memory.writeU32(peb + 0x10, processParams);
  }

  emu.memory.writeU32(teb + 0x00, 0xFFFFFFFF); // SEH chain head
  emu.memory.writeU32(teb + 0x04, stackTop);
  emu.memory.writeU32(teb + 0x08, (stackTop - 0x100000) >>> 0);
  emu.memory.writeU32(teb + 0x18, teb); // self pointer
  emu.memory.writeU32(teb + 0x20, threadId);
  emu.memory.writeU32(teb + 0x24, threadId + 4);
  emu.memory.writeU32(teb + 0x2C, tlsSlots);
  emu.memory.writeU32(teb + 0x30, peb);
  emu.memory.writeU32(teb + 0x34, 0);

  console.log(`[EMU] TEB at 0x${teb.toString(16)}, TLS at 0x${tlsSlots.toString(16)}, PEB at 0x${peb.toString(16)}, threadId=${threadId}`);
  return teb;
}

export function initTEB(emu: Emulator): void {
  const teb = initThreadTEB(emu, emu.pe.stackTop, 1000);
  emu.cpu.fsBase = teb;
  console.log(`[EMU] fsBase=0x${teb.toString(16)}`);
}
