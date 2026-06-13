// Shared GDI primitives used by HLP rendering, x86 GDI emulation
// (GDI32/USER32, Win16 GDI), DirectDraw text overlays and DOS text-mode
// surfaces. Pure browser code — no emulator dependency.

export * from './color';
export * from './font';
export * from './metrics';
export * from './surface';
