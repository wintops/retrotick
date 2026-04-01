import type { Emulator } from '../../emulator';
import { GL1Context } from '../gl-context';
 

export function registerWinTops(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');
  const user32 = emu.registerDll('USER32.DLL');
    const gdi32 = emu.registerDll('GDI32.DLL');
    const opengl32 = emu.registerDll('OPENGL32.DLL');
  
     user32.register('CharToOemW', 2, () => 1);

    user32.register('GetComboBoxInfo', 2, () => 1);
    
      user32.register('log', 1, () =>  {

    const hResInfo = emu.readArg(0);
    console.log('  [LOG]: '+ emu.memory.readCString(hResInfo));
    return 0;
  });
  
 




kernel32.register('GetFileAttributesExA', 3, () => 0);

// Helper: read N floats from a pointer in emulator memory
function readFloatPtr(emu: Emulator, ptr: number, count: number): Float32Array {
  const result = new Float32Array(count);
  const buf = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < count; i++) {
    const bits = emu.memory.readU32(ptr + i * 4);
    buf.setUint32(0, bits, false);
    result[i] = buf.getFloat32(0, false);
  }
  return result;
}  

function getGL(emu: Emulator): GL1Context | null {
  return emu.glContext;
}

// Helper: read a float from stack arg (passed as 32-bit IEEE 754)
function readFloat(emu: Emulator, argIdx: number): number {
  const bits = emu.readArg(argIdx);
  const buf = new DataView(new ArrayBuffer(4));
  buf.setUint32(0, bits, false);
  return buf.getFloat32(0, false);
}

  opengl32.register('glColor4f', 4, () => {

    getGL(emu)?.color4f(readFloat(emu, 0), readFloat(emu, 1),readFloat(emu,2), readFloat(emu, 3));
    return 0;
  });
  
  
  
  
gdi32.register('StretchDIBits', 13, () => {
  const hdc = emu.readArg(0);
  const xDest = emu.readArg(1) | 0;
  const yDest = emu.readArg(2) | 0;
  const destWidth = emu.readArg(3);
  const destHeight = emu.readArg(4);
  const xSrc = emu.readArg(5) | 0;
  const ySrc = emu.readArg(6) | 0;
  const srcWidth = emu.readArg(7);
  const srcHeight = emu.readArg(8);
  const bitsPtr = emu.readArg(9);
  const bmiPtr = emu.readArg(10);
  const fuUsage = emu.readArg(11);   // DIB_RGB_COLORS=0, DIB_PAL_COLORS=1
  const rop = emu.readArg(12);       // 一般传 SRCCOPY = 0x00CC0020

  const dc = emu.getDC(hdc);
  if (!dc || !bitsPtr || !bmiPtr) return 0;

  // 读取 BITMAPINFOHEADER
  const biSize = emu.memory.readU32(bmiPtr);
  const biWidth = Math.abs(emu.memory.readI32(bmiPtr + 4));
  const biHeight = emu.memory.readI32(bmiPtr + 8);
  const biBitCount = emu.memory.readU16(bmiPtr + 14);
  const biCompression = emu.memory.readU32(bmiPtr + 16);
  const biClrUsed = emu.memory.readU32(bmiPtr + 32);
  const isBottomUp = biHeight > 0;
  const absHeight = Math.abs(biHeight);

  if (biCompression !== 0) return 0; // 只支持 BI_RGB

  // 构建调色板
  const numColors = biClrUsed || (biBitCount <= 8 ? (1 << biBitCount) : 0);
  let palette;
  if (fuUsage === 1 && numColors > 0) {
    palette = resolvePaletteColors(emu, dc, bmiPtr, biSize, numColors);
  } else {
    palette = [];
    const paletteOffset = bmiPtr + biSize;
    for (let i = 0; i < numColors; i++) {
      const b = emu.memory.readU8(paletteOffset + i * 4);
      const g = emu.memory.readU8(paletteOffset + i * 4 + 1);
      const r = emu.memory.readU8(paletteOffset + i * 4 + 2);
      palette.push([r, g, b]);
    }
  }

  // 计算行对齐
  let paddedRow;
  if (biBitCount === 1) paddedRow = ((Math.ceil(biWidth / 8)) + 3) & ~3;
  else if (biBitCount === 4) paddedRow = ((Math.ceil(biWidth / 2)) + 3) & ~3;
  else if (biBitCount === 8) paddedRow = (biWidth + 3) & ~3;
  else if (biBitCount === 24) paddedRow = (biWidth * 3 + 3) & ~3;
  else if (biBitCount === 32) paddedRow = biWidth * 4;
  else return 0;

  // 源图有效区域裁剪
  const srcW = Math.min(srcWidth, biWidth - xSrc);
  const srcH = Math.min(srcHeight, absHeight - ySrc);
  if (srcW <= 0 || srcH <= 0 || destWidth <= 0 || destHeight <= 0) return 0;

  // ==============================================
  // 先把源DIB读取成 ImageData（和 SetDIBitsToDevice 一致）
  // ==============================================
  const srcImage = dc.ctx.createImageData(srcW, srcH);
  const srcPx = srcImage.data;

  for (let y = 0; y < srcH; y++) {
    const scanLine = isBottomUp ? (ySrc + srcH - 1 - y) : (ySrc + y);
    const rowStart = bitsPtr + scanLine * paddedRow;

    for (let x = 0; x < srcW; x++) {
      const sx = xSrc + x;
      const off = (y * srcW + x) * 4;
      let r = 0, g = 0, b = 0;

      if (biBitCount === 4) {
        const byteVal = emu.memory.readU8(rowStart + (sx >> 1));
        const idx = (sx & 1) === 0 ? (byteVal >> 4) & 0x0F : byteVal & 0x0F;
        [r, g, b] = palette[idx] || [0, 0, 0];
      } else if (biBitCount === 8) {
        const idx = emu.memory.readU8(rowStart + sx);
        [r, g, b] = palette[idx] || [0, 0, 0];
      } else if (biBitCount === 1) {
        const idx = (emu.memory.readU8(rowStart + (sx >> 3)) >> (7 - (sx & 7))) & 1;
        [r, g, b] = palette[idx] || [0, 0, 0];
      } else if (biBitCount === 24) {
        const o = rowStart + sx * 3;
        b = emu.memory.readU8(o);
        g = emu.memory.readU8(o+1);
        r = emu.memory.readU8(o+2);
      } else if (biBitCount === 32) {
        const o = rowStart + sx * 4;
        b = emu.memory.readU8(o);
        g = emu.memory.readU8(o+1);
        r = emu.memory.readU8(o+2);
      }

      srcPx[off] = r;
      srcPx[off+1] = g;
      srcPx[off+2] = b;
      srcPx[off+3] = 255;
    }
  }

  // ==============================================
  // Stretch 核心：缩放绘制（Canvas 原生支持）
  // ==============================================
  dc.ctx.save();
  dc.ctx.imageSmoothingEnabled = false; // 像素风/复古风格用 nearest
  dc.ctx.drawImage(
    createCanvasFromImageData(srcImage),
    0, 0, srcW, srcH,          // 源
    xDest, yDest, destWidth, destHeight  // 目标（缩放）
  );
  dc.ctx.restore();

  emu.syncDCToCanvas(hdc);
  return 1; // 成功
});

// 辅助函数：把 ImageData 转成 Canvas 用于 drawImage
function createCanvasFromImageData(imgData) {
  const c = document.createElement('canvas');
  c.width = imgData.width;
  c.height = imgData.height;
  const ctx = c.getContext('2d');
  ctx.putImageData(imgData, 0, 0);
  return c;
}  
  
}
 