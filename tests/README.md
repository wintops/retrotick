# Headless Tests

These scripts run executables in Node.js without a browser, using mock Canvas/OffscreenCanvas objects. They verify that the emulator can load a binary and reach the Windows message loop (= the program initialized successfully).

## Running a test

```bash
timeout 2 npx tsx tests/test-<name>.mjs
```

A successful run prints `[TEST] SUCCESS: Reached message loop`.

## Creating a new test

1. Copy an existing `test-*.mjs` file
2. Change the exe path and any companion DLLs
3. Adjust `MAX_TICKS` if needed (some programs need more ticks to initialize)

## How it works

Each test file:
- Creates mock Canvas/OffscreenCanvas/DOM objects
- Loads the target executable with `parsePE()` + `emu.load()`
- Calls `emu.tick()` in a loop until `emu.waitingForMessage` is true
- Optionally inspects window hierarchy, child positions, and control state
