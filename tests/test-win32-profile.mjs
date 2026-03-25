/**
 * Integration tests for Win32 KERNEL32.DLL Profile APIs.
 * Exercises GetProfileStringA/W, GetPrivateProfileStringA/W,
 * WriteProfileStringA/W, WritePrivateProfileStringA/W,
 * GetProfileIntA/W, GetPrivateProfileIntA/W,
 * GetPrivateProfileSectionNamesA/W via the real handlers.
 *
 * Run: timeout 5 npx tsx tests/test-win32-profile.mjs
 */

import { Emulator } from '../src/lib/emu/emulator.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(actual, expected, msg) {
  if (actual === expected) { passed++; } else { failed++; console.error(`  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ---------- Setup ----------
const emu = new Emulator();
emu.cpu.use32 = true; // Win32 mode

const profStore = new ProfileStore();
emu.profileStore = profStore;

// Register the Win32 profile APIs
import { registerProfile } from '../src/lib/emu/win32/kernel32/profile.ts';
registerProfile(emu);

// Collect registered handlers
const handlers = new Map();
for (const [key, def] of emu.apiDefs) {
  if (key.startsWith('KERNEL32.DLL:')) {
    const name = key.replace('KERNEL32.DLL:', '');
    handlers.set(name, def);
  }
}

/**
 * Call a Win32 stdcall handler by name.
 * Args are placed at ESP+4, ESP+8, etc. (each 4 bytes, index-based).
 */
function call32(name, args) {
  const SP = 0x80000;
  emu.memory.writeU32(SP, 0xDEADDEAD); // return address
  for (let i = 0; i < args.length; i++) {
    emu.memory.writeU32(SP + 4 + i * 4, args[i] >>> 0);
  }
  emu.cpu.reg[4] = SP; // ESP
  const h = handlers.get(name);
  if (!h) throw new Error(`No handler for ${name}`);
  return h.handler(emu);
}

/** Write an ANSI string at addr, return addr */
function writeStrA(addr, str) {
  for (let i = 0; i < str.length; i++) emu.memory.writeU8(addr + i, str.charCodeAt(i));
  emu.memory.writeU8(addr + str.length, 0);
  return addr;
}

/** Write a UTF-16 string at addr, return addr */
function writeStrW(addr, str) {
  for (let i = 0; i < str.length; i++) emu.memory.writeU16(addr + i * 2, str.charCodeAt(i));
  emu.memory.writeU16(addr + str.length * 2, 0);
  return addr;
}

/** Read ANSI string from addr */
function readStrA(addr) {
  return emu.memory.readCString(addr);
}

/** Read UTF-16 string from addr */
function readStrW(addr) {
  return emu.memory.readUTF16String(addr);
}

/** Parse a double-null-terminated ANSI list */
function parseDoubleNullA(addr, maxLen) {
  const items = [];
  let pos = 0;
  while (pos < maxLen) {
    if (emu.memory.readU8(addr + pos) === 0) break;
    let str = '';
    while (emu.memory.readU8(addr + pos) !== 0) {
      str += String.fromCharCode(emu.memory.readU8(addr + pos));
      pos++;
    }
    items.push(str);
    pos++; // skip null
  }
  return items;
}

/** Parse a double-null-terminated UTF-16 list */
function parseDoubleNullW(addr, maxLen) {
  const items = [];
  let pos = 0;
  while (pos < maxLen) {
    if (emu.memory.readU16(addr + pos * 2) === 0) break;
    let str = '';
    while (emu.memory.readU16(addr + pos * 2) !== 0) {
      str += String.fromCharCode(emu.memory.readU16(addr + pos * 2));
      pos++;
    }
    items.push(str);
    pos++; // skip null
  }
  return items;
}

// ===== Test 1: WriteProfileStringA + GetProfileStringA =====
console.log('[TEST] 1. WriteProfileStringA + GetProfileStringA');
{
  const sec = writeStrA(0x10000, 'Desktop');
  const key = writeStrA(0x10100, 'Wallpaper');
  const val = writeStrA(0x10200, 'clouds.bmp');

  // WriteProfileStringA(section, key, value) — 3 args
  const ret = call32('WriteProfileStringA', [sec, key, val]);
  assertEq(ret, 1, 'WriteProfileStringA returns 1');

  // GetProfileStringA(section, key, default, buf, size) — 5 args
  const def = writeStrA(0x10300, '');
  const buf = 0x10400;
  const ret2 = call32('GetProfileStringA', [sec, key, def, buf, 256]);
  assert(ret2 > 0, 'GetProfileStringA returns length > 0');
  assertEq(readStrA(buf), 'clouds.bmp', 'reads back written value');
}

// ===== Test 2: GetProfileStringA default =====
console.log('[TEST] 2. GetProfileStringA with default');
{
  const sec = writeStrA(0x10000, 'NoSection');
  const key = writeStrA(0x10100, 'NoKey');
  const def = writeStrA(0x10200, 'fallback');
  const buf = 0x10300;

  const ret = call32('GetProfileStringA', [sec, key, def, buf, 256]);
  assertEq(readStrA(buf), 'fallback', 'returns default for missing');
}

// ===== Test 3: GetProfileIntA =====
console.log('[TEST] 3. GetProfileIntA');
{
  const sec = writeStrA(0x10000, 'Metrics');
  const key = writeStrA(0x10100, 'Border');
  const val = writeStrA(0x10200, '3');
  call32('WriteProfileStringA', [sec, key, val]);

  const ret = call32('GetProfileIntA', [sec, key, 99]);
  assertEq(ret, 3, 'GetProfileIntA parses integer');

  const key2 = writeStrA(0x10300, 'Missing');
  const ret2 = call32('GetProfileIntA', [sec, key2, 42]);
  assertEq(ret2, 42, 'GetProfileIntA returns default for missing');
}

// ===== Test 4: WritePrivateProfileStringA + GetPrivateProfileStringA =====
console.log('[TEST] 4. WritePrivateProfileStringA + GetPrivateProfileStringA');
{
  const sec = writeStrA(0x11000, 'Options');
  const key = writeStrA(0x11100, 'Language');
  const val = writeStrA(0x11200, 'French');
  const file = writeStrA(0x11300, 'C:\\WINDOWS\\MYAPP.INI');

  call32('WritePrivateProfileStringA', [sec, key, val, file]);

  const def = writeStrA(0x11400, '');
  const buf = 0x11500;
  const ret = call32('GetPrivateProfileStringA', [sec, key, def, buf, 256, file]);
  assert(ret > 0, 'GetPrivateProfileStringA returns length > 0');
  assertEq(readStrA(buf), 'French', 'reads back written private profile value');

  // Same file via normalized name
  const file2 = writeStrA(0x11600, 'myapp.ini');
  const buf2 = 0x11700;
  call32('GetPrivateProfileStringA', [sec, key, def, buf2, 256, file2]);
  assertEq(readStrA(buf2), 'French', 'file path normalized');
}

// ===== Test 5: GetPrivateProfileIntA =====
console.log('[TEST] 5. GetPrivateProfileIntA');
{
  const sec = writeStrA(0x12000, 'Options');
  const key = writeStrA(0x12100, 'Width');
  const val = writeStrA(0x12200, '1024');
  const file = writeStrA(0x12300, 'myapp.ini');
  call32('WritePrivateProfileStringA', [sec, key, val, file]);

  const ret = call32('GetPrivateProfileIntA', [sec, key, 0, file]);
  assertEq(ret, 1024, 'GetPrivateProfileIntA returns parsed value');
}

// ===== Test 6: Section enumeration (section=NULL) =====
console.log('[TEST] 6. GetProfileStringA section enumeration');
{
  // WIN.INI has 'desktop' and 'metrics' from previous tests
  const buf = 0x13000;
  const ret = call32('GetProfileStringA', [0, 0, 0, buf, 1024]);
  assert(ret > 0, 'section enumeration returns length > 0');

  const sections = parseDoubleNullA(buf, ret + 10);
  assert(sections.length >= 2, `got ${sections.length} sections`);
  assert(sections.includes('desktop'), 'has desktop');
  assert(sections.includes('metrics'), 'has metrics');
}

// ===== Test 7: Key enumeration (key=NULL) =====
console.log('[TEST] 7. GetProfileStringA key enumeration');
{
  const sec = writeStrA(0x14000, 'Desktop');
  const buf = 0x14100;
  const ret = call32('GetProfileStringA', [sec, 0, 0, buf, 1024]);
  assert(ret > 0, 'key enumeration returns length > 0');

  const keys = parseDoubleNullA(buf, ret + 10);
  assert(keys.includes('wallpaper'), 'keys include wallpaper');
}

// ===== Test 8: GetPrivateProfileSectionNamesA =====
console.log('[TEST] 8. GetPrivateProfileSectionNamesA');
{
  const buf = 0x15000;
  const file = writeStrA(0x15100, 'myapp.ini');
  const ret = call32('GetPrivateProfileSectionNamesA', [buf, 1024, file]);
  assert(ret > 0, 'section names returns length > 0');

  const sections = parseDoubleNullA(buf, ret + 10);
  assert(sections.includes('options'), 'has options section');
}

// ===== Test 9: Wide (W) variants =====
console.log('[TEST] 9. Wide (W) variants');
{
  const sec = writeStrW(0x20000, 'WideSection');
  const key = writeStrW(0x20200, 'WideKey');
  const val = writeStrW(0x20400, 'WideValue');

  call32('WriteProfileStringW', [sec, key, val]);

  const def = writeStrW(0x20600, '');
  const buf = 0x20800;
  const ret = call32('GetProfileStringW', [sec, key, def, buf, 256]);
  assert(ret > 0, 'GetProfileStringW returns length > 0');
  assertEq(readStrW(buf), 'WideValue', 'GetProfileStringW reads back value');
}

// ===== Test 10: GetProfileIntW =====
console.log('[TEST] 10. GetProfileIntW');
{
  const sec = writeStrW(0x21000, 'WideSection');
  const key = writeStrW(0x21200, 'NumKey');
  const val = writeStrW(0x21400, '777');
  call32('WriteProfileStringW', [sec, key, val]);

  const ret = call32('GetProfileIntW', [sec, key, 0]);
  assertEq(ret, 777, 'GetProfileIntW returns parsed value');
}

// ===== Test 11: WritePrivateProfileStringW + GetPrivateProfileStringW =====
console.log('[TEST] 11. WritePrivateProfileStringW + GetPrivateProfileStringW');
{
  const sec = writeStrW(0x22000, 'WConfig');
  const key = writeStrW(0x22200, 'Path');
  const val = writeStrW(0x22400, 'C:\\Program Files');
  const file = writeStrW(0x22600, 'wideapp.ini');

  call32('WritePrivateProfileStringW', [sec, key, val, file]);

  const def = writeStrW(0x22800, '');
  const buf = 0x22A00;
  call32('GetPrivateProfileStringW', [sec, key, def, buf, 256, file]);
  assertEq(readStrW(buf), 'C:\\Program Files', 'Wide private profile read/write');
}

// ===== Test 12: Delete via WriteProfileStringA =====
console.log('[TEST] 12. Delete key/section via WriteProfileStringA');
{
  const sec = writeStrA(0x23000, 'TmpSec');
  const key = writeStrA(0x23100, 'TmpKey');
  const val = writeStrA(0x23200, 'TmpVal');
  call32('WriteProfileStringA', [sec, key, val]);

  // Delete key (value=NULL=0)
  call32('WriteProfileStringA', [sec, key, 0]);
  const def = writeStrA(0x23300, 'GONE');
  const buf = 0x23400;
  call32('GetProfileStringA', [sec, key, def, buf, 256]);
  assertEq(readStrA(buf), 'GONE', 'key deleted');

  // Re-write, then delete section (key=NULL)
  call32('WriteProfileStringA', [sec, key, val]);
  call32('WriteProfileStringA', [sec, 0, 0]);
  call32('GetProfileStringA', [sec, key, def, buf, 256]);
  assertEq(readStrA(buf), 'GONE', 'section deleted');
}

// ===== Test 13: GetPrivateProfileSectionNamesW =====
console.log('[TEST] 13. GetPrivateProfileSectionNamesW');
{
  const buf = 0x24000;
  const file = writeStrW(0x24200, 'wideapp.ini');
  const ret = call32('GetPrivateProfileSectionNamesW', [buf, 512, file]);
  assert(ret > 0, 'W section names returns length > 0');

  const sections = parseDoubleNullW(buf, ret + 10);
  assert(sections.includes('wconfig'), 'has wconfig section');
}

// ===== Results =====
console.log('');
console.log(`[TEST] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('[TEST] SUCCESS: All Win32 profile integration tests passed');
}
