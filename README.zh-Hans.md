<div lang="zh-Hans">

# RetroTick

[English](./README.md) | <a lang="fr" href="./README.fr.md">Français</a> | <a lang="ja" href="./README.ja.md">日本語</a>

**在浏览器中直接运行经典 Windows 和 DOS 程序。** 不模拟操作系统，只模拟 x86 CPU 并重新实现 Windows/DOS API。把 `.exe` 拖进页面试试看。

### [立即体验 → retrotick.com](https://retrotick.com/)

<img src="https://static.retrotick.com/screenshot.webp" width="800" height="600" alt="截图" />

RetroTick 是一个完全使用 TypeScript 从零构建的 x86/ARM CPU 模拟器与 Windows/DOS API 兼容层。它不模拟整个操作系统，而是模拟处理器并直接重新实现操作系统 API。它解析 PE (Win32/WinCE)、NE (Win16) 和 MZ (DOS) 二进制文件，逐条执行 x86 和 ARM 机器码，并提供部分 Win32、Win16 和 DOS API，可以运行经典 Windows 时代的一些 `.exe` 文件，在浏览器中渲染出它们的图形界面。

## 可运行的程序

| 分类 | 程序 |
|------|------|
| 游戏 | 空当接龙、纸牌、扫雷、SkiFree、波斯王子 (DOS)、仙剑奇侠传 (DOS)、Moktar (DOS) |
| 程序 | 计算器、时钟、命令提示符、任务管理器、录音机、记事本 (Win 3.1x)、QBasic、GLX Gears |
| 屏幕保护 | 三维迷宫 (OpenGL)、三维管道 (OpenGL)、变幻线、星空、贝塞尔、花盒、字幕 |

大多数程序存在渲染瑕疵或功能缺失，仍在持续开发中。

## 技术内幕

- **x86 CPU 模拟器** — x87 FPU、惰性标志求值、32 位保护模式（平坦模型）和 16 位实模式（segment:offset 寻址、IVT、PSP、A20 门）
- **ARM CPU 模拟器** — 基础 ARM 指令执行，用于 Windows CE (WinCE) PE 二进制文件
- **PE/NE/MZ 二进制加载器** — 解析文件头、映射节区、解析导入表、提取资源；PE DLL 加载（支持基址重定位和冲突检测）
- **Win32 API 兼容层** — kernel32、user32、gdi32、advapi32、comctl32、comdlg32、shell32、msvcrt、ntdll、opengl32、glu32、ddraw、dsound、ole32、oleaut32、winmm、imm32、uxtheme、winspool、ws2_32、version、psapi、shlwapi、iphlpapi、msacm32、secur32、setupapi、netapi32、mpr、msimg32 等
- **Win16 API 兼容层** — KERNEL、USER、GDI、SHELL、COMMDLG、COMMCTRL、MMSYSTEM、KEYBOARD、DDEML、LZEXPAND、SOUND、VER、SCONFIG、WIN87EM
- **WinCE API 兼容层** — COREDLL（Windows CE ARM 二进制的 kernel32/user32/gdi32 合并层）
- **DOS 中断模拟** — INT 21h 文件/进程服务、INT 10h 视频 BIOS、INT 08h/1Ch 定时器、INT 09h/16h 键盘、INT 1Ah 实时时钟、INT 15h 系统服务、INT 33h 鼠标、INT 2Fh 多路复用、EMS (INT 67h) 和 XMS 扩展内存；DPMI/PMODE/W 保护模式 DOS 扩展器支持
- **VGA 模拟** — 14 种视频模式（文本、CGA、EGA、VGA、Mode 13h、Mode X），完整的 CRTC/Sequencer/GC/ATC 寄存器模拟，256 色调色板，平面内存
- **Sound Blaster / OPL2 / GUS 音频** — Sound Blaster 2.0 DSP 8 位 DMA 回放、OPL2 (YM3812) 9 通道 FM 合成、Gravis Ultrasound (GUS) 模拟、PC 扬声器方波、Intel 8237A DMA 控制器、AudioWorklet 实时输出
- **OpenGL 1.x → WebGL2 转译** — 完整的立即模式管线，映射到 WebGL2，驱动 3D 屏幕保护程序
- **DirectDraw / DirectSound** — 基于 COM 的表面和音频缓冲区管理，用于 DOS 时代的 Windows 游戏
- **窗口管理器** — 多窗口、Z 序、焦点、MDI（多文档界面）、任务栏、消息分发、通用对话框
- **GDI 渲染引擎** — 位图、画刷、画笔、区域、文本、DIB 到 Canvas 的映射
- **虚拟文件系统** — 基于 IndexedDB 的持久化存储

## 快速开始

```bash
npm install
npm run dev
```

打开 `http://localhost:5173`，将 `.exe` 文件拖放到页面上，或从内置的示例启动器中选择。

## 构建

```bash
npm run build     # 生产构建 → dist/
```

## 测试

无头测试使用模拟 Canvas 在 Node.js 中运行可执行文件：

```bash
timeout 2 npx tsx tests/test-<name>.mjs
```

详见 [`tests/`](./tests/)。

## 参与贡献

欢迎 PR！主要目标是让更多可执行文件正确运行，通常是实现缺失的 Win32/Win16 API 桩函数、修复渲染问题、提升 GDI 保真度。详见 `CLAUDE.md` 中的分步工作流程。

我们强烈推荐使用 [Claude Code](https://claude.ai/code) 或类似的 AI 编程工具进行贡献。项目自带详细的 `CLAUDE.md`，Claude Code 会自动读取，帮助你快速理解 x86 内部机制和 Win32 API。当然也欢迎纯手工编码。

## 许可证

本项目以 [CC0 1.0 通用](https://creativecommons.org/publicdomain/zero/1.0/)发布。初始代码完全由 AI 生成。你可以自由使用、修改和分发本项目，无需署名。第三方依赖保留各自的许可证（MIT）。

## 免责声明

与 QEMU、DOSBox、Wine 等模拟器一样，RetroTick 实现的是公开的接口（x86 指令集、Win32 API、PE/NE/MZ 文件格式），不包含任何来自专有实现的代码。开发过程中使用了 AI 编程工具，AI 可能自主检查了测试用可执行文件的字节以诊断兼容性问题，就像开发者使用调试器或十六进制编辑器一样。这类分析仅揭示程序使用了哪些公开 API 和 x86 指令，而非其专有逻辑。

本项目演示的示例程序均为 1990 年代的经典 Windows 实用工具和游戏，已在互联网上广泛流传数十年。它们仅用于演示互操作性。如果您是权利人并希望移除某个程序，请提交 issue。

本项目中提及的所有产品名称、商标和注册商标均为其各自所有者的财产。本项目与任何商标持有者无关联、未获其认可或赞助。

</div>
