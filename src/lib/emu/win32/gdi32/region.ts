import type { Emulator } from '../../emulator';

export function registerRegion(emu: Emulator): void {
  const gdi32 = emu.registerDll('GDI32.DLL');

  gdi32.register('CreateRectRgn', 4, () => emu.handles.alloc('region', {}));
  gdi32.register('CreateRectRgnIndirect', 1, () => emu.handles.alloc('region', {}));
  gdi32.register('CreateEllipticRgn', 4, () => emu.handles.alloc('region', {}));

  // CombineRgn returns COMPLEXREGION(3) / SIMPLEREGION(2) / NULLREGION(1) / ERROR(0)
  gdi32.register('CreatePolygonRgn', 3, () => emu.handles.alloc('region', {}));
  gdi32.register('CreatePolyPolygonRgn', 4, () => emu.handles.alloc('region', {}));
  gdi32.register('CombineRgn', 4, () => 2); // SIMPLEREGION
  gdi32.register('SetRectRgn', 5, () => 1);
  gdi32.register('PaintRgn', 2, () => 1);
  // FillRgn(hdc, hrgn, hbr) → BOOL
  gdi32.register('FillRgn', 3, () => 1);
  gdi32.register('OffsetRgn', 3, () => 1); // SIMPLEREGION
  // FrameRgn(hdc, hrgn, hbr, w, h) → BOOL
  gdi32.register('FrameRgn', 5, () => 1);
  // GetRgnBox(hRgn, lprc) → int — return SIMPLEREGION
  gdi32.register('GetRgnBox', 2, () => {
    const lprc = emu.readArg(1);
    if (lprc) {
      emu.memory.writeU32(lprc, 0);
      emu.memory.writeU32(lprc + 4, 0);
      emu.memory.writeU32(lprc + 8, 100);
      emu.memory.writeU32(lprc + 12, 100);
    }
    return 2; // SIMPLEREGION
  });
}
