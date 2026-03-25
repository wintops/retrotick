/**
 * Unit tests for ProfileStore class.
 * Run: timeout 2 npx tsx tests/test-profile-store.mjs
 */

import { ProfileStore } from '../src/lib/profile-store.ts';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ===== Test 1: Basic getString / writeString =====
console.log('[TEST] 1. Basic getString / writeString');
{
  const ps = new ProfileStore();
  // Default value when nothing written
  assertEq(ps.getString('test.ini', 'section1', 'key1', 'default'), 'default', 'getString returns default when empty');

  // Write and read back
  ps.writeString('test.ini', 'section1', 'key1', 'hello');
  assertEq(ps.getString('test.ini', 'section1', 'key1', 'default'), 'hello', 'getString returns written value');

  // Different key
  assertEq(ps.getString('test.ini', 'section1', 'key2', 'nope'), 'nope', 'getString returns default for missing key');
}

// ===== Test 2: Case insensitivity =====
console.log('[TEST] 2. Case insensitivity');
{
  const ps = new ProfileStore();
  ps.writeString('TEST.INI', 'MySection', 'MyKey', 'value1');

  // File name case insensitive
  assertEq(ps.getString('test.ini', 'MySection', 'MyKey', ''), 'value1', 'file name case insensitive');

  // Section name case insensitive
  assertEq(ps.getString('test.ini', 'mysection', 'MyKey', ''), 'value1', 'section name case insensitive');

  // Key name case insensitive
  assertEq(ps.getString('test.ini', 'mysection', 'mykey', ''), 'value1', 'key name case insensitive');
}

// ===== Test 3: File path normalization =====
console.log('[TEST] 3. File path normalization');
{
  const ps = new ProfileStore();
  ps.writeString('C:\\WINDOWS\\MYAPP.INI', 'sec', 'k', 'v');

  // Should strip path and lowercase
  assertEq(ps.getString('myapp.ini', 'sec', 'k', ''), 'v', 'path stripped and lowercased');
  assertEq(ps.getString('C:\\WINDOWS\\MYAPP.INI', 'sec', 'k', ''), 'v', 'full path also works');
}

// ===== Test 4: getInt =====
console.log('[TEST] 4. getInt');
{
  const ps = new ProfileStore();
  assertEq(ps.getInt('test.ini', 'sec', 'num', 42), 42, 'getInt returns default when empty');

  ps.writeString('test.ini', 'sec', 'num', '123');
  assertEq(ps.getInt('test.ini', 'sec', 'num', 42), 123, 'getInt parses integer');

  ps.writeString('test.ini', 'sec', 'bad', 'abc');
  assertEq(ps.getInt('test.ini', 'sec', 'bad', 99), 99, 'getInt returns default for non-numeric');
}

// ===== Test 5: Delete key (value=null) =====
console.log('[TEST] 5. Delete key (value=null)');
{
  const ps = new ProfileStore();
  ps.writeString('test.ini', 'sec', 'k1', 'v1');
  ps.writeString('test.ini', 'sec', 'k2', 'v2');

  ps.writeString('test.ini', 'sec', 'k1', null);
  assertEq(ps.getString('test.ini', 'sec', 'k1', 'gone'), 'gone', 'key deleted');
  assertEq(ps.getString('test.ini', 'sec', 'k2', ''), 'v2', 'other key still exists');
}

// ===== Test 6: Delete section (key=null) =====
console.log('[TEST] 6. Delete section (key=null)');
{
  const ps = new ProfileStore();
  ps.writeString('test.ini', 'sec', 'k1', 'v1');
  ps.writeString('test.ini', 'sec', 'k2', 'v2');
  ps.writeString('test.ini', 'other', 'k3', 'v3');

  ps.writeString('test.ini', 'sec', null, null);
  assertEq(ps.getString('test.ini', 'sec', 'k1', 'gone'), 'gone', 'section deleted - k1');
  assertEq(ps.getString('test.ini', 'sec', 'k2', 'gone'), 'gone', 'section deleted - k2');
  assertEq(ps.getString('test.ini', 'other', 'k3', ''), 'v3', 'other section intact');
}

// ===== Test 7: getSectionNames =====
console.log('[TEST] 7. getSectionNames');
{
  const ps = new ProfileStore();
  assertEq(ps.getSectionNames('test.ini').length, 0, 'no sections initially');

  ps.writeString('test.ini', 'alpha', 'k', 'v');
  ps.writeString('test.ini', 'beta', 'k', 'v');
  ps.writeString('test.ini', 'gamma', 'k', 'v');

  const names = ps.getSectionNames('test.ini');
  assertEq(names.length, 3, '3 sections');
  assert(names.includes('alpha'), 'has alpha');
  assert(names.includes('beta'), 'has beta');
  assert(names.includes('gamma'), 'has gamma');
}

// ===== Test 8: getSectionKeys =====
console.log('[TEST] 8. getSectionKeys');
{
  const ps = new ProfileStore();
  ps.writeString('test.ini', 'sec', 'key_a', 'v1');
  ps.writeString('test.ini', 'sec', 'key_b', 'v2');
  ps.writeString('test.ini', 'sec', 'key_c', 'v3');

  const keys = ps.getSectionKeys('test.ini', 'sec');
  assertEq(keys.length, 3, '3 keys');
  assert(keys.includes('key_a'), 'has key_a');
  assert(keys.includes('key_b'), 'has key_b');
  assert(keys.includes('key_c'), 'has key_c');
}

// ===== Test 9: Serialize / Deserialize =====
console.log('[TEST] 9. Serialize / Deserialize');
{
  const ps1 = new ProfileStore();
  ps1.writeString('win.ini', 'Desktop', 'Wallpaper', 'forest.bmp');
  ps1.writeString('win.ini', 'Desktop', 'TileWallpaper', '0');
  ps1.writeString('myapp.ini', 'Settings', 'LastFile', 'doc.txt');

  const data = ps1.serialize();

  const ps2 = new ProfileStore();
  ps2.deserialize(data);

  assertEq(ps2.getString('win.ini', 'Desktop', 'Wallpaper', ''), 'forest.bmp', 'deserialized value 1');
  assertEq(ps2.getString('win.ini', 'Desktop', 'TileWallpaper', ''), '0', 'deserialized value 2');
  assertEq(ps2.getString('myapp.ini', 'Settings', 'LastFile', ''), 'doc.txt', 'deserialized value 3');
  assertEq(ps2.getSectionNames('win.ini').length, 1, 'deserialized section count');
}

// ===== Test 10: onChange callback =====
console.log('[TEST] 10. onChange callback');
{
  const ps = new ProfileStore();
  let count = 0;
  ps.onChange = () => count++;

  ps.writeString('test.ini', 'sec', 'k', 'v');
  assertEq(count, 1, 'onChange called on write');

  ps.writeString('test.ini', 'sec', 'k', null);
  assertEq(count, 2, 'onChange called on delete key');

  ps.writeString('test.ini', 'sec2', 'k', 'v');
  ps.writeString('test.ini', 'sec2', null, null);
  assertEq(count, 4, 'onChange called on write + delete section');
}

// ===== Test 11: Multiple files =====
console.log('[TEST] 11. Multiple files');
{
  const ps = new ProfileStore();
  ps.writeString('win.ini', 'sec', 'key', 'from_win');
  ps.writeString('app.ini', 'sec', 'key', 'from_app');

  assertEq(ps.getString('win.ini', 'sec', 'key', ''), 'from_win', 'win.ini value');
  assertEq(ps.getString('app.ini', 'sec', 'key', ''), 'from_app', 'app.ini value');
}

// ===== Results =====
console.log('');
console.log(`[TEST] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('[TEST] SUCCESS: All ProfileStore tests passed');
}
