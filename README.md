# RetroTick

<a lang="fr" href="./README.fr.md">Français</a> | <a lang="zh-Hans" href="./README.zh-Hans.md">简体中文</a> | <a lang="ja" href="./README.ja.md">日本語</a>

**Run classic Windows and DOS executables directly in your browser.** No OS emulation. Just an x86 CPU emulator with reimplemented Windows/DOS APIs. Drag an `.exe` into the page and see what happens.

### [Try it now → retrotick.com](https://retrotick.com/)

<img src="https://static.retrotick.com/screenshot.webp" width="800" height="600" alt="Screenshot" />

RetroTick is an x86/ARM CPU emulator and Windows/DOS API compatibility layer built from scratch in TypeScript. Rather than emulating an entire operating system, it emulates the processor and reimplements OS APIs directly. It parses PE (Win32/WinCE), NE (Win16), and MZ (DOS) binaries, executes x86 and ARM machine code instruction by instruction, and provides partial Win32, Win16, and DOS APIs, allowing some classic Windows-era `.exe` files to run and render their GUIs in the browser.

## What Runs

| Category | Programs |
|----------|----------|
| Games | FreeCell, Solitaire, Minesweeper, SkiFree, Prince of Persia (DOS), Chinese Paladin (DOS), Moktar (DOS) |
| Programs | Calculator, Clock, Command Prompt, Task Manager, Sound Recorder, Notepad (Win 3.1x), QBasic, GLX Gears |
| Screen Savers | 3D Maze (OpenGL), 3D Pipes (OpenGL), Mystify, Starfield, Bezier, Flower Box, Marquee |

Most programs have rendering glitches or missing features. This is a work in progress.

## What's Under the Hood

- **x86 CPU emulator** — x87 FPU, lazy flag evaluation, 32-bit protected mode (flat model) and 16-bit real mode with segment:offset addressing, IVT, PSP, A20 gate
- **ARM CPU emulator** — Basic ARM instruction execution for Windows CE (WinCE) PE binaries
- **PE/NE/MZ binary loader** — Parses headers, maps sections, resolves imports, extracts resources; PE DLL loading with base relocation and conflict detection
- **Win32 API compatibility layer** — kernel32, user32, gdi32, advapi32, comctl32, comdlg32, shell32, msvcrt, ntdll, opengl32, glu32, ddraw, dsound, ole32, oleaut32, winmm, imm32, uxtheme, winspool, ws2_32, version, psapi, shlwapi, iphlpapi, msacm32, secur32, setupapi, netapi32, mpr, msimg32, and more
- **Win16 API compatibility layer** — KERNEL, USER, GDI, SHELL, COMMDLG, COMMCTRL, MMSYSTEM, KEYBOARD, DDEML, LZEXPAND, SOUND, VER, SCONFIG, WIN87EM
- **WinCE API compatibility layer** — COREDLL (combined kernel32/user32/gdi32 for Windows CE ARM binaries)
- **DOS interrupt emulation** — INT 21h file/process services, INT 10h video BIOS, INT 08h/1Ch timer, INT 09h/16h keyboard, INT 1Ah real-time clock, INT 15h system services, INT 33h mouse, INT 2Fh multiplex, EMS (INT 67h) and XMS extended memory; DPMI/PMODE/W protected mode DOS extender support
- **VGA emulation** — 14 video modes (text, CGA, EGA, VGA, Mode 13h, Mode X), full CRTC/Sequencer/GC/ATC register emulation, 256-color palette, planar memory
- **Sound Blaster / OPL2 / GUS audio** — Sound Blaster 2.0 DSP with 8-bit DMA playback, OPL2 (YM3812) 9-channel FM synthesis, Gravis Ultrasound (GUS) emulation, PC Speaker square wave, Intel 8237A DMA controller, AudioWorklet real-time output
- **OpenGL 1.x → WebGL2 translation** — Full immediate-mode pipeline mapped to WebGL2, powering 3D screen savers
- **DirectDraw / DirectSound** — COM-based surface and audio buffer management for DOS-era Windows games
- **Window manager** — Multiple windows, z-order, focus, MDI (Multiple Document Interface), taskbar, message dispatch, common dialogs
- **GDI rendering engine** — Bitmaps, brushes, pens, regions, text, DIB-to-Canvas mapping
- **Virtual filesystem** — IndexedDB-backed persistent storage for uploaded files

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173` and drop a `.exe` file onto the page, or pick one from the built-in example launcher.

## Build

```bash
npm run build     # Production build → dist/
```

## Testing

Headless tests run executables in Node.js with a mock Canvas:

```bash
timeout 2 npx tsx tests/test-<name>.mjs
```

See [`tests/`](./tests/) for details.

## Contributing

PRs welcome! The main goal is to make more executables run correctly, which typically means implementing missing Win32/Win16 API stubs, fixing rendering issues, and improving GDI fidelity. See `CLAUDE.md` for the step-by-step workflow.

We strongly recommend contributing with [Claude Code](https://claude.ai/code) or similar AI coding tools. The project ships a detailed `CLAUDE.md` that Claude Code picks up automatically, making it easy to navigate x86 internals and Win32 API surfaces. Of course, coding by hand is also welcome.

## License

This project is released under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). The initial codebase was generated entirely by AI. You are free to use, modify, and distribute this project for any purpose without attribution. Third-party dependencies retain their own licenses (MIT).

## Disclaimer

Like QEMU, DOSBox, Wine, and other emulators, RetroTick implements documented public interfaces (x86 instruction set, Win32 API, PE/NE/MZ file formats) and does not contain code derived from any proprietary implementation. During development, AI coding tools were used and may have inspected bytes from test executables to diagnose compatibility issues, much like a developer using a debugger or hex editor. Such analysis only reveals which public APIs and x86 instructions a program uses, not its proprietary logic.

The example programs demonstrated by this project are classic Windows utilities and games from the 1990s that have been widely available on the internet for decades. They are included solely for demonstrating interoperability. If you are a rights holder and would like a program removed, please open an issue.

All product names, trademarks, and registered trademarks mentioned in this project are the property of their respective owners. This project is not affiliated with, endorsed by, or sponsored by any trademark holder.
