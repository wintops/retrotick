# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RetroTick is a browser-based x86 emulator that runs classic Windows PE/NE/MZ executables. Built with Preact + Vite + TypeScript + Tailwind CSS.

## Commands

- `npm run build` — Production build to `dist/`
- `npm run check` — Alias for `npm run build` (catches type errors and regressions)
- `timeout 2 npx tsx test-<name>.mjs` — Run a headless test for a specific exe

No test runner or linter scripts are configured.

## Architecture

### Core Layers

**PE/NE Parsing** (`src/lib/pe/`): Binary parsing of Windows executables. `parse.ts` handles PE header parsing and resource directory tree walking. Each `extract-*.ts` file handles one resource type (bitmap, icon, cursor, dialog, menu, string, version, accelerator, AVI, WAV, manifest, Delphi DFM, imports, exports). `decode-dib.ts` handles DIB-to-image conversion. RVA-to-file-offset mapping converts virtual addresses to actual file positions.

**x86 CPU** (`src/lib/emu/x86/`): Modular instruction execution:
- `cpu.ts` — CPU class with register accessors, flag get/set, push/pop, fetch, alu(), testCC()
- `flags.ts` — `materializeFlags()` for lazy flag evaluation
- `lazy-op.ts` — Lazy operation type definitions
- `decode.ts` — ModRM/SIB decoding, segment override, writeModRM
- `dispatch.ts` — Main instruction dispatch switch
- `ops-0f.ts` — Two-byte 0F opcode handler (Jcc/SETcc/CMOVcc/MOVZX/MOVSX/IMUL)
- `ops-0f-ext.ts` — Extended 0F opcodes (BT/BSF/BSR/SHLD/SHRD/XADD/CMPXCHG/BSWAP/RDTSC)
- `fpu.ts` — FPU helpers (fpuPush/fpuPop/fpuST/fpuSetST) + dispatcher
- `fpu-d8db.ts` — FPU opcodes D8-DB
- `fpu-dcdf.ts` — FPU opcodes DC-DF
- `shift.ts` — Shift/rotate operations (SHL/SHR/SAR/ROL/ROR/RCL/RCR/SHLD/SHRD)
- `string.ts` — String instructions (REP MOVS/STOS/CMPS/SCAS/LODS)

**Emulator Core** (`src/lib/emu/`):
- `memory.ts` — Linear 32-bit address space with segment translation and ANSI code page support
- `emulator.ts` — Emulator class with fields, heap/virtual alloc, arg reading, timer mgmt, delegates; `ApiDef`, `Win32Dll`, `Win16Module` for unified API registration
- `thread.ts` — Thread state management
- `pe-loader.ts` / `ne-loader.ts` / `mz-loader.ts` — Load PE32, NE (16-bit), and MZ (DOS) executables into memory
- `emu-exec.ts` — tick(), callWndProc(), callWndProc16(), completeThunk(), resume()
- `emu-load.ts` — load() and findResourceEntry()
- `emu-thunks-pe.ts` — Win32 thunk table builder, IAT verification, TEB init
- `emu-thunks-ne.ts` — Win16 thunk table builder, resource string reader
- `emu-render.ts` — fillTextBitmap, renderChildControls, sendDrawItem
- `emu-render-controls.ts` — renderButton, renderStatic, renderEdit
- `emu-window.ts` — DC management, canvas setup, SEH dispatch, resource loading
- `dos-int.ts` — DOS INT 21h interrupt services for MZ executables
- `file-manager.ts` — Virtual filesystem backed by IndexedDB
- `cp437.ts` — CP437 (DOS) character encoding table
- `format.ts` — Formatting utilities

**Windows API Stubs** (`src/lib/emu/win32/`): Modular — subdirectories per major DLL, files per functional area:
- `kernel32/` — atom, console, env, file, heap, locale, module, process, profile, resource, string, sync, sysinfo, tls
- `user32/` — clipboard, create-window, dialog, focus, input, menu, message, misc, paint, rect, register-class, resource, scroll, text, timer, window-long, wndproc
- `gdi32/` — bitmap, brush, dc, draw, metafile, palette, region, select, text
- `advapi32.ts` — registry, security
- `comctl32.ts` — common controls
- `comdlg32.ts` — common dialogs
- `shell32.ts`, `winspool.ts`, `winmm.ts`, `ws2_32.ts` — misc DLLs
- `msvcrt.ts` — C runtime (cdecl)
- `opengl32.ts`, `gl-context.ts`, `glu32.ts` — OpenGL 1.x → WebGL2
- `ddraw.ts` — DirectDraw stubs
- `ole32.ts`, `oleaut32.ts` — COM/OLE stubs
- `psapi.ts`, `shlwapi.ts`, `iphlpapi.ts`, `msacm32.ts`, `version.ts` — misc
- `handles.ts` — Unified handle table
- `helpers.ts` — Shared helper functions
- `types.ts` — Win32 constants and type definitions

**Win16 API Stubs** (`src/lib/emu/win16/`): Windows 3.x NE executable support:
- `kernel/` — atom, dos, error, file, memory, misc, module, profile, registry, resource, string, task
- `user/` — dialog, menu, message, misc, paint, rect, resource, window
- `gdi.ts` — graphics device interface
- `shell.ts`, `commdlg.ts`, `commctrl.ts`, `mmsystem.ts`, `keyboard.ts`, `ddeml.ts`, `win87em.ts`
- `lzexpand.ts`, `sound.ts`, `ver.ts`, `sconfig.ts` (Workgroup Security)

**UI Components** (`src/components/`): Display components per resource type. `win2k/` contains 24 widgets mimicking Windows 2000 UI (Window, Button, Edit, ListBox, ListView, TreeView, ComboBox, TabControl, MenuBar, Taskbar, MessageBox, etc.). `EmulatorView.tsx` renders emulated programs via Canvas + HTML controls. `App.tsx` manages the desktop, taskbar, and multi-window state.

### Key Patterns

- JSX uses Preact (React compat via tsconfig path aliases)
- `useBlobUrls` hook manages object URL lifecycle with automatic cleanup
- DIB-to-PNG conversion in `decode-dib.ts` and `image.ts` for rendering Windows bitmaps
- Resource extraction functions are parallel/independent — each returns typed results from parsed PE data
- Language detection from PE resource language IDs, propagated as `lang` attributes for correct CJK font rendering
- OpenGL 1.x immediate-mode pipeline mapped to WebGL2 for 3D screen savers

## Skill: Supporting a New EXE

When asked to make `examples/<name>.exe` run in the emulator, follow this iterative workflow:

### Important Rules

1. **Always use `timeout 2`** when test-running to save time: `timeout 2 npx tsx test-<name>.mjs 2>&1`
2. **Always check Microsoft documentation or public headers** for constant value definitions, API argument counts, struct types and sizes. Never guess these — look them up in official sources.
3. **Always fix Unimplemented APIs and missing arg counts first** before fixing other issues (unknown opcodes, WILD EIP, etc.). Most crashes and opcode errors are caused by unimplemented APIs returning bad values or missing stackBytes corrupting the stack — fix the root cause first.
4. **Always define constant values as named `const`** — look up the correct value from Microsoft documentation or public headers, then define it as a named constant (e.g. `const WM_PAINT = 0x000F;`). Never hardcode magic numbers directly into the code.

### Step 1: Create test harness

Copy an existing `test-*.mjs` (e.g. `test-calc.mjs`), change the filename to the target exe. The test file runs the emulator **headlessly via Node.js** — no dev server needed. It uses mock Canvas/OffscreenCanvas objects, loads the PE, creates an Emulator, and runs ticks until `emu.waitingForMessage` becomes true (= reached message loop = success).

After reaching the message loop, the test can simulate user input via `emu.postMessage()` (e.g. `WM_COMMAND` for button clicks, `WM_KEYDOWN`/`WM_CHAR` for keyboard input) and verify results by inspecting window state (child windows, control text, title bar, etc.).

```bash
timeout 2 npx tsx test-<name>.mjs 2>&1
```

### Step 2: Fix `No API definition` warnings

The output shows `[THUNK] No API definition for DLL:FuncName — defaulting to stackBytes=0`. Every missing definition defaults to stackBytes=0, which **corrupts the stack** for stdcall functions that take arguments. Fix by adding a `register()` call in the appropriate API module file (e.g. `kernel32.register('FuncName', nArgs, handler)`). Look up the correct argument count from the Win32 API docs (MSVCRT is cdecl so nArgs=0 is correct for it).

### Step 3: Fix crashes (WILD EIP)

If the output shows `[WILD EIP]`, check the **THUNK TRACE** at the bottom — the last few thunks before the crash reveal which API returned a bad value or corrupted the stack. Common causes:
- Missing API definition / stackBytes (Step 2) — the most frequent cause
- An API returning 0 when the caller dereferences the result (e.g. `LocalSize` returning 0 for a valid allocation)

### Step 4: Fix `Window class not found`

If CreateWindowEx fails because a class isn't found, check case sensitivity. Built-in classes are registered as uppercase (`EDIT`, `BUTTON`, `STATIC`, etc.) in `src/lib/emu/win32/user32/register-class.ts`. The lookup in `create-window.ts` should fall back to `.toUpperCase()`.

### Step 5: Implement `Unimplemented API` stubs

After API definitions are added and the program doesn't crash, the output shows `Unimplemented API: DLL:FuncName` for APIs that are called but have no handler. These return 0 by default, which is often fine but sometimes needs a real implementation.

Priority order:
1. **APIs that crash the program** — if the program halts right after an unimplemented call
2. **APIs called during init** (before message loop) — the program may abort if these fail
3. **APIs called later** (after message loop) — can be deferred

Common stub patterns:
- **Return 0/FALSE** for functions that "fail gracefully" (GetOpenFileName, FindFirstFile)
- **Return 1/TRUE** for functions that "always succeed" (RegCloseKey, CloseHandle)
- **Write to out-pointer** for functions that return data via pointer args (RegCreateKey writes a pseudo handle)
- **W variants** usually mirror the A version but use `readUTF16String`/`writeU16` instead of `readCString`/`writeU8`

### Step 6: Iterate

Re-run the test after each batch of fixes. The goal is `[TEST] SUCCESS: Reached message loop`. Once reached, the exe can be loaded in the browser UI.

### Checklist

- [ ] Test harness created and runs
- [ ] No `[THUNK] No API definition` warnings
- [ ] No `[WILD EIP]` crashes
- [ ] No `Window class not found` errors
- [ ] `[TEST] SUCCESS: Reached message loop`
- [ ] All `Unimplemented API` calls during init are stubbed
