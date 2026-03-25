/**
 * Integration tests for Win16 KERNEL registry (ordinals 216-227) and
 * profile APIs (ordinals 57-59, 127-129, 142-143) — exercises the real
 * handlers through the Emulator's memory and 16-bit stack.
 *
 * Run: timeout 5 npx tsx tests/test-win16-registry-profile.mjs
 */

import { Emulator } from '../src/lib/emu/emulator.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(actual, expected, msg) {
  if (actual === expected) { passed++; } else { failed++; console.error(`  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ---------- Emulator setup ----------
// We use SS=0 → segBase returns 0, so stack addresses = linear addresses.
// SP = 0x8000, data area at 0x1000-0x7FFF.
// Far pointers with seg=0 ⇒ resolveFarPtr returns the offset directly.

const emu = new Emulator();
emu.cpu.use32 = false;     // NE 16-bit mode
emu.cpu.ss = 0;

const regStore = new RegistryStore();
emu.registryStore = regStore;
const profStore = new ProfileStore();
emu.profileStore = profStore;

// Register Win16 KERNEL module APIs (registry + profile + misc)
import { registerKernelRegistry } from '../src/lib/emu/win16/kernel/registry.ts';
import { registerKernelProfile } from '../src/lib/emu/win16/kernel/profile.ts';

// Create a minimal Win16Module-like object to capture registrations
const handlers = new Map(); // ordinal → handler fn

const fakeKernel = {
  register(name, stackBytes, handler, ordinal) {
    handlers.set(ordinal, { name, stackBytes, handler });
  }
};

registerKernelRegistry(fakeKernel, emu, {});
registerKernelProfile(fakeKernel, emu, {});

/** Call a Win16 ordinal handler with Pascal-convention args.
 *  argDefs: array of { size: 2|4, value: number } in source order (left→right).
 *  Pascal: rightmost arg at lowest stack offset.
 */
function call16(ordinal, argDefs) {
  const SP = 0x8000;
  // Write 4-byte fake return address at SP+0
  emu.memory.writeU32(SP, 0xDEAD);
  // Write args: rightmost first at SP+4, then next at SP+4+size_of_rightmost, etc.
  let off = 4;
  for (let i = argDefs.length - 1; i >= 0; i--) {
    const a = argDefs[i];
    if (a.size === 4) {
      emu.memory.writeU32(SP + off, a.value >>> 0);
    } else {
      emu.memory.writeU16(SP + off, a.value & 0xFFFF);
    }
    off += a.size;
  }
  emu.cpu.reg[4] = SP; // ESP (low 16 = SP)
  const h = handlers.get(ordinal);
  if (!h) throw new Error(`No handler for ordinal ${ordinal}`);
  return h.handler(emu);
}

/** Write a C string at a linear address, return the address (usable as far ptr with seg=0). */
function writeCStr(addr, str) {
  for (let i = 0; i < str.length; i++) emu.memory.writeU8(addr + i, str.charCodeAt(i));
  emu.memory.writeU8(addr + str.length, 0);
  return addr; // seg=0, off=addr → far ptr = addr
}

// Error codes
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_NO_MORE_ITEMS = 259;

const HKEY_CURRENT_USER = 0x80000001;

// ==================== REGISTRY TESTS ====================

console.log('[TEST] === Win16 KERNEL Registry (ordinals 216-227) ===');

// --- Test R1: RegCreateKey (ord 218) + RegOpenKey (ord 217) ---
console.log('[TEST] R1. RegCreateKey + RegOpenKey');
{
  const subKeyAddr = 0x1000;
  writeCStr(subKeyAddr, 'Software\\TestApp');
  const phkAddr = 0x1100;

  // RegCreateKey(hKey:long, lpSubKey:ptr, phkResult:ptr) — sizes [4,4,4]
  const ret = call16(218, [
    { size: 4, value: HKEY_CURRENT_USER },
    { size: 4, value: subKeyAddr },
    { size: 4, value: phkAddr },
  ]);
  assertEq(ret, ERROR_SUCCESS, 'RegCreateKey returns SUCCESS');
  const hKey = emu.memory.readU32(phkAddr);
  assert(hKey !== 0, 'RegCreateKey writes a handle');

  // RegOpenKey the same path
  const phk2Addr = 0x1200;
  const ret2 = call16(217, [
    { size: 4, value: HKEY_CURRENT_USER },
    { size: 4, value: subKeyAddr },
    { size: 4, value: phk2Addr },
  ]);
  assertEq(ret2, ERROR_SUCCESS, 'RegOpenKey returns SUCCESS');
  const hKey2 = emu.memory.readU32(phk2Addr);
  assert(hKey2 !== 0, 'RegOpenKey writes a handle');

  // RegOpenKey for non-existent key
  const noKeyAddr = 0x1300;
  writeCStr(noKeyAddr, 'Software\\NoSuchKey');
  const phk3Addr = 0x1400;
  const ret3 = call16(217, [
    { size: 4, value: HKEY_CURRENT_USER },
    { size: 4, value: noKeyAddr },
    { size: 4, value: phk3Addr },
  ]);
  assertEq(ret3, ERROR_FILE_NOT_FOUND, 'RegOpenKey returns NOT_FOUND for missing key');
}

// --- Test R2: RegSetValue (ord 221) + RegQueryValue (ord 224) ---
console.log('[TEST] R2. RegSetValue + RegQueryValue');
{
  const subKeyAddr = 0x2000;
  writeCStr(subKeyAddr, 'Software\\TestApp');
  const dataAddr = 0x2100;
  writeCStr(dataAddr, 'MyAppClass');
  const dataLen = 10; // "MyAppClass" length

  // RegSetValue(hKey, lpSubKey, dwType=REG_SZ, lpData, cbData) — sizes [4,4,4,4,4]
  const ret = call16(221, [
    { size: 4, value: HKEY_CURRENT_USER },
    { size: 4, value: subKeyAddr },
    { size: 4, value: 1 }, // REG_SZ
    { size: 4, value: dataAddr },
    { size: 4, value: dataLen },
  ]);
  assertEq(ret, ERROR_SUCCESS, 'RegSetValue returns SUCCESS');

  // RegQueryValue(hKey, lpSubKey, lpValue, lpcbValue) — sizes [4,4,4,4]
  const valueBufAddr = 0x2200;
  const cbAddr = 0x2300;
  emu.memory.writeU32(cbAddr, 256); // buffer size
  const ret2 = call16(224, [
    { size: 4, value: HKEY_CURRENT_USER },
    { size: 4, value: subKeyAddr },
    { size: 4, value: valueBufAddr },
    { size: 4, value: cbAddr },
  ]);
  assertEq(ret2, ERROR_SUCCESS, 'RegQueryValue returns SUCCESS');
  const resultStr = emu.memory.readCString(valueBufAddr);
  assertEq(resultStr, 'MyAppClass', 'RegQueryValue reads correct data');
}

// --- Test R3: RegSetValueEx (ord 226) + RegQueryValueEx (ord 225) ---
console.log('[TEST] R3. RegSetValueEx + RegQueryValueEx');
{
  // First create and open a key
  const subKeyAddr = 0x3000;
  writeCStr(subKeyAddr, 'Software\\TestApp\\Settings');
  const phkAddr = 0x3100;
  call16(218, [
    { size: 4, value: HKEY_CURRENT_USER },
    { size: 4, value: subKeyAddr },
    { size: 4, value: phkAddr },
  ]);
  const hKey = emu.memory.readU32(phkAddr);

  // RegSetValueEx(hKey, lpValueName, dwReserved, dwType, lpData, cbData) — sizes [4,4,4,4,4,4]
  const nameAddr = 0x3200;
  writeCStr(nameAddr, 'Language');
  const valDataAddr = 0x3300;
  writeCStr(valDataAddr, 'French');
  const ret = call16(226, [
    { size: 4, value: hKey },
    { size: 4, value: nameAddr },
    { size: 4, value: 0 }, // reserved
    { size: 4, value: 1 }, // REG_SZ
    { size: 4, value: valDataAddr },
    { size: 4, value: 7 }, // "French\0" = 7 bytes
  ]);
  assertEq(ret, ERROR_SUCCESS, 'RegSetValueEx returns SUCCESS');

  // RegQueryValueEx(hKey, lpValueName, lpReserved, lpType, lpData, lpcbData) — sizes [4,4,4,4,4,4]
  const typeAddr = 0x3400;
  const dataBufAddr = 0x3500;
  const cbDataAddr = 0x3600;
  emu.memory.writeU32(cbDataAddr, 256);
  const ret2 = call16(225, [
    { size: 4, value: hKey },
    { size: 4, value: nameAddr },
    { size: 4, value: 0 }, // reserved
    { size: 4, value: typeAddr },
    { size: 4, value: dataBufAddr },
    { size: 4, value: cbDataAddr },
  ]);
  assertEq(ret2, ERROR_SUCCESS, 'RegQueryValueEx returns SUCCESS');
  assertEq(emu.memory.readU32(typeAddr), 1, 'type = REG_SZ');
  assertEq(emu.memory.readCString(dataBufAddr), 'French', 'data = French');
}

// --- Test R4: RegEnumKey (ord 216) ---
console.log('[TEST] R4. RegEnumKey');
{
  // Create some subkeys under a parent
  const parentAddr = 0x4000;
  writeCStr(parentAddr, 'Software\\EnumParent');
  const phkAddr = 0x4100;
  call16(218, [{ size: 4, value: HKEY_CURRENT_USER }, { size: 4, value: parentAddr }, { size: 4, value: phkAddr }]);
  const hParent = emu.memory.readU32(phkAddr);

  for (const child of ['Alpha', 'Beta', 'Gamma']) {
    const childAddr = 0x4200;
    writeCStr(childAddr, child);
    call16(218, [{ size: 4, value: hParent }, { size: 4, value: childAddr }, { size: 4, value: 0x4300 }]);
  }

  // Re-open parent to enumerate
  const phk2Addr = 0x4400;
  call16(217, [{ size: 4, value: HKEY_CURRENT_USER }, { size: 4, value: parentAddr }, { size: 4, value: phk2Addr }]);
  const hEnum = emu.memory.readU32(phk2Addr);

  // RegEnumKey(hKey, dwIndex, lpName, cbName) — sizes [4,4,4,4]
  const nameBufAddr = 0x4500;
  const names = [];
  for (let i = 0; i < 10; i++) {
    emu.memory.writeU8(nameBufAddr, 0); // clear
    const ret = call16(216, [
      { size: 4, value: hEnum },
      { size: 4, value: i },
      { size: 4, value: nameBufAddr },
      { size: 4, value: 256 },
    ]);
    if (ret === ERROR_NO_MORE_ITEMS) break;
    assertEq(ret, ERROR_SUCCESS, `RegEnumKey(${i}) returns SUCCESS`);
    names.push(emu.memory.readCString(nameBufAddr));
  }
  assertEq(names.length, 3, 'enumerated 3 subkeys');
  assert(names.includes('alpha'), 'has alpha');
  assert(names.includes('beta'), 'has beta');
  assert(names.includes('gamma'), 'has gamma');
}

// --- Test R5: RegEnumValue (ord 223) ---
console.log('[TEST] R5. RegEnumValue');
{
  const subKeyAddr = 0x5000;
  writeCStr(subKeyAddr, 'Software\\EnumValTest');
  const phkAddr = 0x5100;
  call16(218, [{ size: 4, value: HKEY_CURRENT_USER }, { size: 4, value: subKeyAddr }, { size: 4, value: phkAddr }]);
  const hKey = emu.memory.readU32(phkAddr);

  // Set two values
  const name1Addr = 0x5200;
  writeCStr(name1Addr, 'Color');
  const data1Addr = 0x5300;
  writeCStr(data1Addr, 'Blue');
  call16(226, [{ size: 4, value: hKey }, { size: 4, value: name1Addr }, { size: 4, value: 0 }, { size: 4, value: 1 }, { size: 4, value: data1Addr }, { size: 4, value: 5 }]);

  const name2Addr = 0x5400;
  writeCStr(name2Addr, 'Size');
  const data2Addr = 0x5500;
  // REG_DWORD = 4
  emu.memory.writeU32(data2Addr, 42);
  call16(226, [{ size: 4, value: hKey }, { size: 4, value: name2Addr }, { size: 4, value: 0 }, { size: 4, value: 4 }, { size: 4, value: data2Addr }, { size: 4, value: 4 }]);

  // RegEnumValue(hKey, dwIndex, lpName, lpcbName, lpReserved, lpType, lpData, lpcbData) — sizes [4,4,4,4,4,4,4,4]
  const vNameAddr = 0x5600;
  const vCbNameAddr = 0x5700;
  const vTypeAddr = 0x5800;
  const vDataAddr = 0x5900;
  const vCbDataAddr = 0x5A00;

  const valNames = [];
  for (let i = 0; i < 10; i++) {
    emu.memory.writeU32(vCbNameAddr, 256);
    emu.memory.writeU32(vCbDataAddr, 256);
    const ret = call16(223, [
      { size: 4, value: hKey },
      { size: 4, value: i },
      { size: 4, value: vNameAddr },
      { size: 4, value: vCbNameAddr },
      { size: 4, value: 0 },
      { size: 4, value: vTypeAddr },
      { size: 4, value: vDataAddr },
      { size: 4, value: vCbDataAddr },
    ]);
    if (ret === ERROR_NO_MORE_ITEMS) break;
    assertEq(ret, ERROR_SUCCESS, `RegEnumValue(${i}) returns SUCCESS`);
    valNames.push(emu.memory.readCString(vNameAddr));
  }
  assertEq(valNames.length, 2, 'enumerated 2 values');
  assert(valNames.includes('color'), 'has color');
  assert(valNames.includes('size'), 'has size');
}

// --- Test R6: RegDeleteValue (ord 222) + RegDeleteKey (ord 219) + RegCloseKey (ord 220) ---
console.log('[TEST] R6. RegDeleteValue + RegDeleteKey + RegCloseKey');
{
  const subKeyAddr = 0x6000;
  writeCStr(subKeyAddr, 'Software\\DelTest');
  const phkAddr = 0x6100;
  call16(218, [{ size: 4, value: HKEY_CURRENT_USER }, { size: 4, value: subKeyAddr }, { size: 4, value: phkAddr }]);
  const hKey = emu.memory.readU32(phkAddr);

  // Set a value, then delete it
  const vnAddr = 0x6200;
  writeCStr(vnAddr, 'tmp');
  const vdAddr = 0x6300;
  writeCStr(vdAddr, 'x');
  call16(226, [{ size: 4, value: hKey }, { size: 4, value: vnAddr }, { size: 4, value: 0 }, { size: 4, value: 1 }, { size: 4, value: vdAddr }, { size: 4, value: 2 }]);

  // RegDeleteValue(hKey, lpValueName) — sizes [4,4]
  const ret = call16(222, [{ size: 4, value: hKey }, { size: 4, value: vnAddr }]);
  assertEq(ret, ERROR_SUCCESS, 'RegDeleteValue returns SUCCESS');

  // Verify deleted
  const typeAddr = 0x6400;
  const dataBufAddr = 0x6500;
  const cbAddr = 0x6600;
  emu.memory.writeU32(cbAddr, 256);
  const ret2 = call16(225, [{ size: 4, value: hKey }, { size: 4, value: vnAddr }, { size: 4, value: 0 }, { size: 4, value: typeAddr }, { size: 4, value: dataBufAddr }, { size: 4, value: cbAddr }]);
  assertEq(ret2, ERROR_FILE_NOT_FOUND, 'deleted value not found');

  // RegCloseKey(hKey) — sizes [4]
  // Note: ordinal 220 uses readArg16DWord(0) not readPascalArgs16, so arg is at offset 0
  const retClose = call16(220, [{ size: 4, value: hKey }]);
  assertEq(retClose, ERROR_SUCCESS, 'RegCloseKey returns SUCCESS');

  // RegDeleteKey(hKey, lpSubKey) — sizes [4,4]
  const ret3 = call16(219, [{ size: 4, value: HKEY_CURRENT_USER }, { size: 4, value: subKeyAddr }]);
  assertEq(ret3, ERROR_SUCCESS, 'RegDeleteKey returns SUCCESS');
}

// ==================== PROFILE TESTS ====================

console.log('');
console.log('[TEST] === Win16 KERNEL Profile (ordinals 57-59, 127-129) ===');

// --- Test P1: WriteProfileString (ord 59) + GetProfileString (ord 58) ---
console.log('[TEST] P1. WriteProfileString + GetProfileString');
{
  const appAddr = 0x1000;
  writeCStr(appAddr, 'Desktop');
  const keyAddr = 0x1100;
  writeCStr(keyAddr, 'Wallpaper');
  const valAddr = 0x1200;
  writeCStr(valAddr, 'forest.bmp');

  // WriteProfileString(lpAppName, lpKeyName, lpString) — sizes [4,4,4]
  const ret = call16(59, [
    { size: 4, value: appAddr },
    { size: 4, value: keyAddr },
    { size: 4, value: valAddr },
  ]);
  assertEq(ret, 1, 'WriteProfileString returns 1');

  // GetProfileString(lpAppName, lpKeyName, lpDefault, lpRetBuf, nSize) — sizes [4,4,4,4,2]
  const defAddr = 0x1300;
  writeCStr(defAddr, '');
  const bufAddr = 0x1400;
  const ret2 = call16(58, [
    { size: 4, value: appAddr },
    { size: 4, value: keyAddr },
    { size: 4, value: defAddr },
    { size: 4, value: bufAddr },
    { size: 2, value: 256 },
  ]);
  assert(ret2 > 0, 'GetProfileString returns length > 0');
  assertEq(emu.memory.readCString(bufAddr), 'forest.bmp', 'GetProfileString returns written value');
}

// --- Test P2: GetProfileString with default value ---
console.log('[TEST] P2. GetProfileString default value');
{
  const appAddr = 0x1000;
  writeCStr(appAddr, 'NoSuchSection');
  const keyAddr = 0x1100;
  writeCStr(keyAddr, 'NoKey');
  const defAddr = 0x1200;
  writeCStr(defAddr, 'fallback');
  const bufAddr = 0x1300;

  const ret = call16(58, [
    { size: 4, value: appAddr },
    { size: 4, value: keyAddr },
    { size: 4, value: defAddr },
    { size: 4, value: bufAddr },
    { size: 2, value: 256 },
  ]);
  assertEq(emu.memory.readCString(bufAddr), 'fallback', 'returns default for missing key');
}

// --- Test P3: GetProfileInt (ord 57) ---
console.log('[TEST] P3. GetProfileInt');
{
  // Write a numeric value first
  const appAddr = 0x1000;
  writeCStr(appAddr, 'Settings');
  const keyAddr = 0x1100;
  writeCStr(keyAddr, 'FontSize');
  const valAddr = 0x1200;
  writeCStr(valAddr, '14');
  call16(59, [{ size: 4, value: appAddr }, { size: 4, value: keyAddr }, { size: 4, value: valAddr }]);

  // GetProfileInt(lpAppName, lpKeyName, nDefault) — sizes [4,4,2]
  const ret = call16(57, [
    { size: 4, value: appAddr },
    { size: 4, value: keyAddr },
    { size: 2, value: 99 },
  ]);
  assertEq(ret, 14, 'GetProfileInt returns parsed value');

  // Missing key → default
  const key2Addr = 0x1300;
  writeCStr(key2Addr, 'NoKey');
  const ret2 = call16(57, [
    { size: 4, value: appAddr },
    { size: 4, value: key2Addr },
    { size: 2, value: 42 },
  ]);
  assertEq(ret2, 42, 'GetProfileInt returns default for missing key');
}

// --- Test P4: WritePrivateProfileString (ord 129) + GetPrivateProfileString (ord 128) ---
console.log('[TEST] P4. WritePrivateProfileString + GetPrivateProfileString');
{
  const appAddr = 0x2000;
  writeCStr(appAddr, 'Config');
  const keyAddr = 0x2100;
  writeCStr(keyAddr, 'LastFile');
  const valAddr = 0x2200;
  writeCStr(valAddr, 'C:\\docs\\readme.txt');
  const fileAddr = 0x2300;
  writeCStr(fileAddr, 'C:\\WINDOWS\\MYAPP.INI');

  // WritePrivateProfileString(app, key, val, file) — sizes [4,4,4,4]
  const ret = call16(129, [
    { size: 4, value: appAddr },
    { size: 4, value: keyAddr },
    { size: 4, value: valAddr },
    { size: 4, value: fileAddr },
  ]);
  assertEq(ret, 1, 'WritePrivateProfileString returns 1');

  // GetPrivateProfileString(app, key, default, buf, size, file) — sizes [4,4,4,4,2,4]
  const defAddr = 0x2400;
  writeCStr(defAddr, '');
  const bufAddr = 0x2500;

  const ret2 = call16(128, [
    { size: 4, value: appAddr },
    { size: 4, value: keyAddr },
    { size: 4, value: defAddr },
    { size: 4, value: bufAddr },
    { size: 2, value: 256 },
    { size: 4, value: fileAddr },
  ]);
  assert(ret2 > 0, 'GetPrivateProfileString returns length > 0');
  assertEq(emu.memory.readCString(bufAddr), 'C:\\docs\\readme.txt', 'GetPrivateProfileString returns written value');

  // Same file via normalized name
  const file2Addr = 0x2600;
  writeCStr(file2Addr, 'myapp.ini');
  const buf2Addr = 0x2700;
  call16(128, [
    { size: 4, value: appAddr },
    { size: 4, value: keyAddr },
    { size: 4, value: defAddr },
    { size: 4, value: buf2Addr },
    { size: 2, value: 256 },
    { size: 4, value: file2Addr },
  ]);
  assertEq(emu.memory.readCString(buf2Addr), 'C:\\docs\\readme.txt', 'file path normalized');
}

// --- Test P5: GetPrivateProfileInt (ord 127) ---
console.log('[TEST] P5. GetPrivateProfileInt');
{
  const appAddr = 0x2000;
  writeCStr(appAddr, 'Config');
  const keyAddr = 0x2100;
  writeCStr(keyAddr, 'Width');
  const valAddr = 0x2200;
  writeCStr(valAddr, '800');
  const fileAddr = 0x2300;
  writeCStr(fileAddr, 'myapp.ini');
  call16(129, [{ size: 4, value: appAddr }, { size: 4, value: keyAddr }, { size: 4, value: valAddr }, { size: 4, value: fileAddr }]);

  // GetPrivateProfileInt(app, key, default, file) — sizes [4,4,2,4]
  const ret = call16(127, [
    { size: 4, value: appAddr },
    { size: 4, value: keyAddr },
    { size: 2, value: 0 },
    { size: 4, value: fileAddr },
  ]);
  assertEq(ret, 800, 'GetPrivateProfileInt returns parsed value');
}

// --- Test P6: GetProfileString section enumeration (lpKeyName=NULL) ---
console.log('[TEST] P6. GetProfileString section/key enumeration');
{
  // WIN.INI already has 'Desktop' and 'Settings' from previous tests
  const bufAddr = 0x3000;

  // section=NULL → enumerate section names (double-null terminated)
  const ret = call16(58, [
    { size: 4, value: 0 }, // NULL = enumerate sections
    { size: 4, value: 0 }, // NULL key (ignored)
    { size: 4, value: 0 }, // NULL default (ignored)
    { size: 4, value: bufAddr },
    { size: 2, value: 512 },
  ]);
  assert(ret > 0, 'section enumeration returns length > 0');

  // Parse double-null-terminated list
  const sections = [];
  let pos = 0;
  while (pos < ret + 10) {
    const ch = emu.memory.readU8(bufAddr + pos);
    if (ch === 0) {
      if (sections.length > 0 && sections[sections.length - 1] === '') break;
      // End of one string — but we already built it
      break;
    }
    let str = '';
    while (emu.memory.readU8(bufAddr + pos) !== 0) {
      str += String.fromCharCode(emu.memory.readU8(bufAddr + pos));
      pos++;
    }
    sections.push(str);
    pos++; // skip null terminator
  }
  assert(sections.length >= 2, `found ${sections.length} sections (expected >= 2)`);
  assert(sections.includes('desktop'), 'has desktop section');
  assert(sections.includes('settings'), 'has settings section');

  // key=NULL → enumerate keys in a section
  const appAddr = 0x3200;
  writeCStr(appAddr, 'Desktop');
  const buf2Addr = 0x3300;
  const ret2 = call16(58, [
    { size: 4, value: appAddr },
    { size: 4, value: 0 }, // NULL key = enumerate keys
    { size: 4, value: 0 },
    { size: 4, value: buf2Addr },
    { size: 2, value: 512 },
  ]);
  assert(ret2 > 0, 'key enumeration returns length > 0');

  const keys = [];
  pos = 0;
  while (pos < ret2 + 10) {
    if (emu.memory.readU8(buf2Addr + pos) === 0) break;
    let str = '';
    while (emu.memory.readU8(buf2Addr + pos) !== 0) {
      str += String.fromCharCode(emu.memory.readU8(buf2Addr + pos));
      pos++;
    }
    keys.push(str);
    pos++;
  }
  assert(keys.includes('wallpaper'), 'keys include wallpaper');
}

// --- Test P7: Delete key via WriteProfileString with value=NULL ---
console.log('[TEST] P7. Delete key (value=NULL) and delete section (key=NULL)');
{
  // Write a key
  const appAddr = 0x4000;
  writeCStr(appAddr, 'TempSection');
  const keyAddr = 0x4100;
  writeCStr(keyAddr, 'TempKey');
  const valAddr = 0x4200;
  writeCStr(valAddr, 'TempVal');
  call16(59, [{ size: 4, value: appAddr }, { size: 4, value: keyAddr }, { size: 4, value: valAddr }]);

  // Delete key (value=NULL → far ptr = 0)
  call16(59, [{ size: 4, value: appAddr }, { size: 4, value: keyAddr }, { size: 4, value: 0 }]);

  // Verify deleted
  const defAddr = 0x4300;
  writeCStr(defAddr, 'GONE');
  const bufAddr = 0x4400;
  call16(58, [
    { size: 4, value: appAddr },
    { size: 4, value: keyAddr },
    { size: 4, value: defAddr },
    { size: 4, value: bufAddr },
    { size: 2, value: 256 },
  ]);
  assertEq(emu.memory.readCString(bufAddr), 'GONE', 'key deleted, returns default');

  // Write back and delete whole section (key=NULL)
  call16(59, [{ size: 4, value: appAddr }, { size: 4, value: keyAddr }, { size: 4, value: valAddr }]);
  call16(59, [{ size: 4, value: appAddr }, { size: 4, value: 0 }, { size: 4, value: 0 }]);

  call16(58, [
    { size: 4, value: appAddr },
    { size: 4, value: keyAddr },
    { size: 4, value: defAddr },
    { size: 4, value: bufAddr },
    { size: 2, value: 256 },
  ]);
  assertEq(emu.memory.readCString(bufAddr), 'GONE', 'section deleted, returns default');
}

// ===== Results =====
console.log('');
console.log(`[TEST] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('[TEST] SUCCESS: All Win16 registry + profile integration tests passed');
}
