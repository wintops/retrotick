/**
 * Unit tests for RegistryStore class — validates the store API that
 * Win16 KERNEL registry (ordinals 216-227) and SHELL (ordinals 1-6) rely on.
 * Run: timeout 2 npx tsx tests/test-registry-store.mjs
 */

import { RegistryStore } from '../src/lib/registry-store.ts';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(actual, expected, msg) {
  if (actual === expected) { passed++; } else { failed++; console.error(`  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const HKEY_CLASSES_ROOT  = 0x80000000;
const HKEY_CURRENT_USER  = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
const REG_SZ = 1;
const REG_DWORD = 4;

// ===== Test 1: createKey + openKey =====
console.log('[TEST] 1. createKey + openKey');
{
  const s = new RegistryStore();
  const r = s.createKey(HKEY_CURRENT_USER, 'Software\\MyApp');
  assert(r !== null, 'createKey returns non-null');
  assertEq(r.disposition, 1, 'disposition = REG_CREATED_NEW_KEY');

  // Open same key
  const h = s.openKey(HKEY_CURRENT_USER, 'Software\\MyApp');
  assert(h !== null, 'openKey succeeds for existing key');

  // Open non-existent
  const h2 = s.openKey(HKEY_CURRENT_USER, 'Software\\NoSuchKey');
  assertEq(h2, null, 'openKey returns null for missing key');

  // Create same key again → REG_OPENED_EXISTING_KEY
  const r2 = s.createKey(HKEY_CURRENT_USER, 'Software\\MyApp');
  assertEq(r2.disposition, 2, 'disposition = REG_OPENED_EXISTING_KEY on re-create');
}

// ===== Test 2: setValue + queryValue =====
console.log('[TEST] 2. setValue + queryValue');
{
  const s = new RegistryStore();
  const r = s.createKey(HKEY_CURRENT_USER, 'Software\\Test');
  const h = r.handle;

  // Set a REG_SZ value
  const data = new TextEncoder().encode('Hello World\0');
  s.setValue(h, 'greeting', REG_SZ, new Uint8Array(data));

  const val = s.queryValue(h, 'greeting');
  assert(val !== null, 'queryValue returns non-null');
  assertEq(val.type, REG_SZ, 'type = REG_SZ');
  const str = new TextDecoder().decode(val.data);
  assert(str.startsWith('Hello World'), 'data matches');

  // Set a REG_DWORD value
  const dwordData = new Uint8Array(4);
  new DataView(dwordData.buffer).setUint32(0, 42, true);
  s.setValue(h, 'count', REG_DWORD, dwordData);

  const val2 = s.queryValue(h, 'count');
  assertEq(val2.type, REG_DWORD, 'type = REG_DWORD');
  assertEq(new DataView(val2.data.buffer).getUint32(0, true), 42, 'dword value = 42');

  // Query default value (empty name)
  assertEq(s.queryValue(h, ''), null, 'default value is null when not set');

  // Set and query default value
  s.setValue(h, '', REG_SZ, new TextEncoder().encode('default\0'));
  const defVal = s.queryValue(h, '');
  assert(defVal !== null, 'default value set');
}

// ===== Test 3: deleteValue =====
console.log('[TEST] 3. deleteValue');
{
  const s = new RegistryStore();
  const r = s.createKey(HKEY_CURRENT_USER, 'Software\\DelTest');
  const h = r.handle;
  s.setValue(h, 'tmp', REG_SZ, new Uint8Array([65, 0]));

  assert(s.deleteValue(h, 'tmp'), 'deleteValue returns true');
  assertEq(s.queryValue(h, 'tmp'), null, 'value gone after delete');
  assert(!s.deleteValue(h, 'tmp'), 'deleteValue returns false on second call');
}

// ===== Test 4: deleteKey =====
console.log('[TEST] 4. deleteKey');
{
  const s = new RegistryStore();
  s.createKey(HKEY_CURRENT_USER, 'Software\\Parent\\Child');

  // Can't delete parent if it has subkeys
  assert(!s.deleteKey(HKEY_CURRENT_USER, 'Software\\Parent'), 'cannot delete key with subkeys');

  // Delete leaf first
  const ph = s.openKey(HKEY_CURRENT_USER, 'Software\\Parent');
  assert(s.deleteKey(ph, 'Child'), 'delete leaf key');

  // Now parent can be deleted
  assert(s.deleteKey(HKEY_CURRENT_USER, 'Software\\Parent'), 'delete parent after child removed');

  // Verify gone
  assertEq(s.openKey(HKEY_CURRENT_USER, 'Software\\Parent'), null, 'parent key gone');
}

// ===== Test 5: enumKey =====
console.log('[TEST] 5. enumKey');
{
  const s = new RegistryStore();
  s.createKey(HKEY_LOCAL_MACHINE, 'Software\\Alpha');
  s.createKey(HKEY_LOCAL_MACHINE, 'Software\\Beta');
  s.createKey(HKEY_LOCAL_MACHINE, 'Software\\Gamma');

  const hSw = s.openKey(HKEY_LOCAL_MACHINE, 'Software');
  assert(hSw !== null, 'open Software key');

  const names = [];
  for (let i = 0; ; i++) {
    const name = s.enumKey(hSw, i);
    if (name === null) break;
    names.push(name);
  }
  assertEq(names.length, 3, '3 subkeys');
  assert(names.includes('alpha'), 'has alpha (lowercased)');
  assert(names.includes('beta'), 'has beta');
  assert(names.includes('gamma'), 'has gamma');
}

// ===== Test 6: enumValue =====
console.log('[TEST] 6. enumValue');
{
  const s = new RegistryStore();
  const r = s.createKey(HKEY_CURRENT_USER, 'Software\\EnumTest');
  const h = r.handle;
  s.setValue(h, 'Name', REG_SZ, new Uint8Array([65, 0]));
  s.setValue(h, 'Version', REG_DWORD, new Uint8Array([1, 0, 0, 0]));

  const val0 = s.enumValue(h, 0);
  assert(val0 !== null, 'enumValue(0) returns non-null');

  const val1 = s.enumValue(h, 1);
  assert(val1 !== null, 'enumValue(1) returns non-null');

  const val2 = s.enumValue(h, 2);
  assertEq(val2, null, 'enumValue(2) returns null (no more)');

  // Verify we got both values (order may vary)
  const enumNames = [val0.name, val1.name].sort();
  assertEq(enumNames[0], 'name', 'first enum name (lowercased)');
  assertEq(enumNames[1], 'version', 'second enum name');
}

// ===== Test 7: closeKey =====
console.log('[TEST] 7. closeKey');
{
  const s = new RegistryStore();
  const r = s.createKey(HKEY_CURRENT_USER, 'Software\\CloseTest');
  const h = r.handle;
  s.setValue(h, 'x', REG_SZ, new Uint8Array([48, 0]));

  // Close the handle
  s.closeKey(h);

  // After close, queryValue with that handle should fail
  assertEq(s.queryValue(h, 'x'), null, 'queryValue returns null after closeKey');

  // But re-opening should work
  const h2 = s.openKey(HKEY_CURRENT_USER, 'Software\\CloseTest');
  assert(h2 !== null, 'key still exists after close');
  const val = s.queryValue(h2, 'x');
  assert(val !== null, 'value still accessible via new handle');
}

// ===== Test 8: Serialize / Deserialize =====
console.log('[TEST] 8. Serialize / Deserialize');
{
  const s1 = new RegistryStore();
  s1.createKey(HKEY_CURRENT_USER, 'Software\\SerTest');
  const h = s1.openKey(HKEY_CURRENT_USER, 'Software\\SerTest');
  s1.setValue(h, 'val', REG_SZ, new Uint8Array([72, 105, 0])); // "Hi\0"

  const data = s1.serialize();

  const s2 = new RegistryStore();
  s2.deserialize(data);

  const h2 = s2.openKey(HKEY_CURRENT_USER, 'Software\\SerTest');
  assert(h2 !== null, 'key exists after deserialize');
  const val = s2.queryValue(h2, 'val');
  assert(val !== null, 'value exists after deserialize');
  assertEq(val.data[0], 72, 'data[0] = H');
  assertEq(val.data[1], 105, 'data[1] = i');
}

// ===== Test 9: Root keys always exist =====
console.log('[TEST] 9. Root keys always exist');
{
  const s = new RegistryStore();
  // Should be able to open root keys directly (with empty subkey)
  const h1 = s.openKey(HKEY_CLASSES_ROOT, '');
  assert(h1 !== null, 'HKEY_CLASSES_ROOT exists');

  const h2 = s.openKey(HKEY_CURRENT_USER, '');
  assert(h2 !== null, 'HKEY_CURRENT_USER exists');

  const h3 = s.openKey(HKEY_LOCAL_MACHINE, '');
  assert(h3 !== null, 'HKEY_LOCAL_MACHINE exists');
}

// ===== Test 10: Case insensitive paths =====
console.log('[TEST] 10. Case insensitive paths');
{
  const s = new RegistryStore();
  s.createKey(HKEY_CURRENT_USER, 'Software\\MyApp');

  const h = s.openKey(HKEY_CURRENT_USER, 'SOFTWARE\\MYAPP');
  assert(h !== null, 'case-insensitive key open');

  s.setValue(h, 'Key', REG_SZ, new Uint8Array([65, 0]));
  const val = s.queryValue(h, 'key');
  assert(val !== null, 'case-insensitive value query');
}

// ===== Results =====
console.log('');
console.log(`[TEST] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('[TEST] SUCCESS: All RegistryStore tests passed');
}
