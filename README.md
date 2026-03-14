# RetroTick

<a lang="zh-Hans" href="./README.zh-Hans.md">简体中文</a> | <a lang="ja" href="./README.ja.md">日本語</a>

**Run classic Windows and DOS executables directly in your browser.** No OS emulation. Just an x86 CPU emulator with reimplemented Windows/DOS APIs. Drag, drop, and play.

### [Try it now → retrotick.com](https://retrotick.com/)

<img src="https://static.retrotick.com/screenshot.webp" width="800" height="600" alt="Screenshot" />

RetroTick is an x86 CPU emulator and Windows/DOS API compatibility layer built from scratch in TypeScript. Rather than emulating an entire operating system, it emulates the x86 processor and reimplements OS APIs directly. It parses PE (Win32), NE (Win16), and MZ (DOS) binaries, executes x86 machine code instruction by instruction, and provides a subset of the Win32, Win16, and DOS API surface, enough to boot several `.exe` files from the classic Windows era and render their GUIs in the browser.

## What Runs

| Category | Programs |
|----------|----------|
| Games | FreeCell, Solitaire, Minesweeper, SkiFree, Prince of Persia (DOS), Chinese Paladin (DOS) |
| Programs | Calculator, Clock, Command Prompt, Task Manager, Sound Recorder, QBasic, GLX Gears |
| Screen Savers | 3D Maze (OpenGL), 3D Pipes (OpenGL), Mystify, Starfield, Bezier, Flower Box, Marquee |

Most programs have rendering glitches or missing features. This is a work in progress.

## What's Under the Hood

- **x86 CPU emulator** — x87 FPU, lazy flag evaluation, 32-bit protected mode (flat model) and 16-bit real mode with segment:offset addressing, IVT, and PSP
- **PE/NE/MZ binary loader** — Parses headers, maps sections, resolves imports, extracts resources
- **Win32 API compatibility layer** — kernel32, user32, gdi32, advapi32, comctl32, comdlg32, shell32, msvcrt, opengl32, glu32, ddraw, ole32, oleaut32, winmm, winspool, ws2_32, version, psapi, shlwapi, iphlpapi, msacm32, and more
- **Win16 API compatibility layer** — KERNEL, USER, GDI, SHELL, COMMDLG, COMMCTRL, MMSYSTEM, KEYBOARD, DDEML, LZEXPAND, SOUND, VER, SCONFIG, WIN87EM
- **DOS interrupt emulation** — INT 21h services for MZ executables
- **OpenGL 1.x → WebGL2 translation** — Full immediate-mode pipeline mapped to WebGL2, powering 3D screen savers
- **Window manager** — Multiple windows, z-order, focus, taskbar, message dispatch, common dialogs
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

## Contributing

PRs welcome! The main goal is to make more executables run correctly, which typically means implementing missing Win32/Win16 API stubs, fixing rendering issues, and improving GDI fidelity. See `CLAUDE.md` for the step-by-step workflow.

We strongly recommend contributing with [Claude Code](https://claude.ai/code) or similar AI coding tools. The project ships a detailed `CLAUDE.md` that Claude Code picks up automatically, making it easy to navigate x86 internals and Win32 API surfaces. Of course, coding by hand is also welcome.

## License

This project is released under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). The initial codebase was generated entirely by AI. You are free to use, modify, and distribute this project for any purpose without attribution. Third-party dependencies retain their own licenses (MIT).

## Disclaimer

Like QEMU, DOSBox, Wine, and other emulators, RetroTick implements documented public interfaces (x86 instruction set, Win32 API, PE/NE/MZ file formats) and does not contain code derived from any proprietary implementation. During development, AI coding tools were used and may have inspected bytes from test executables to diagnose compatibility issues, much like a developer using a debugger or hex editor. Such analysis only reveals which public APIs and x86 instructions a program uses, not its proprietary logic.

The example programs demonstrated by this project are classic Windows utilities and games from the 1990s that have been widely available on the internet for decades. They are included solely for demonstrating interoperability. If you are a rights holder and would like a program removed, please open an issue.

All product names, trademarks, and registered trademarks mentioned in this project are the property of their respective owners. This project is not affiliated with, endorsed by, or sponsored by any trademark holder.
