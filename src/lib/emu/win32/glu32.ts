import type { Emulator } from '../emulator';

function readDouble(emu: Emulator, argIdx: number): number {
  const lo = emu.readArg(argIdx);
  const hi = emu.readArg(argIdx + 1);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setUint32(0, lo, true);
  buf.setUint32(4, hi, true);
  return buf.getFloat64(0, true);
}

function readDoubleMem(emu: Emulator, addr: number): number {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setUint32(0, emu.memory.readU32(addr), true);
  buf.setUint32(4, emu.memory.readU32(addr + 4), true);
  return buf.getFloat64(0, true);
}

function writeDoubleMem(emu: Emulator, addr: number, val: number): void {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, val, true);
  emu.memory.writeU32(addr, buf.getUint32(0, true));
  emu.memory.writeU32(addr + 4, buf.getUint32(4, true));
}

// OpenGL matrices are stored column-major: m[col*4 + row].
function mat4MulVec4(m: Float64Array, v: Float64Array, out: Float64Array): void {
  for (let r = 0; r < 4; r++) {
    out[r] = m[0 * 4 + r] * v[0] + m[1 * 4 + r] * v[1] +
             m[2 * 4 + r] * v[2] + m[3 * 4 + r] * v[3];
  }
}

export function registerGlu32(emu: Emulator): void {
  const glu32 = emu.registerDll('GLU32.DLL');

  glu32.register('gluPerspective', 8, () => {
    // gluPerspective(fovy, aspect, zNear, zFar) — 4 doubles = 8 dwords
    const fovy = readDouble(emu, 0);
    const aspect = readDouble(emu, 2);
    const zNear = readDouble(emu, 4);
    const zFar = readDouble(emu, 6);
    emu.glContext?.perspective(fovy, aspect, zNear, zFar);
    return 0;
  });

  glu32.register('gluOrtho2D', 8, () => {
    // gluOrtho2D(left, right, bottom, top) — 4 doubles = 8 dwords
    const left = readDouble(emu, 0);
    const right = readDouble(emu, 2);
    const bottom = readDouble(emu, 4);
    const top = readDouble(emu, 6);
    emu.glContext?.ortho2D(left, right, bottom, top);
    return 0;
  });

  glu32.register('gluLookAt', 18, () => {
    // gluLookAt(eyeX,eyeY,eyeZ, centerX,centerY,centerZ, upX,upY,upZ) — 9 doubles = 18 dwords
    const eyeX = readDouble(emu, 0), eyeY = readDouble(emu, 2), eyeZ = readDouble(emu, 4);
    const centerX = readDouble(emu, 6), centerY = readDouble(emu, 8), centerZ = readDouble(emu, 10);
    const upX = readDouble(emu, 12), upY = readDouble(emu, 14), upZ = readDouble(emu, 16);
    emu.glContext?.lookAt(eyeX, eyeY, eyeZ, centerX, centerY, centerZ, upX, upY, upZ);
    return 0;
  });

  // gluBuild2DMipmaps(target, internalFormat, width, height, format, type, data)
  glu32.register('gluBuild2DMipmaps', 7, () => {
    const target = emu.readArg(0);
    const internalFormat = emu.readArg(1);
    const width = emu.readArg(2);
    const height = emu.readArg(3);
    const format = emu.readArg(4);
    const type = emu.readArg(5);
    const pixelsPtr = emu.readArg(6);

    if (!emu.glContext) return 0;
    if (target !== 0x0DE1) return 0; // GL_TEXTURE_2D

    let pixels: Uint8Array | null = null;
    if (pixelsPtr && width > 0 && height > 0) {
      let bpp = 4;
      if (format === 0x1907) bpp = 3;        // GL_RGB
      else if (format === 0x1909) bpp = 1;   // GL_LUMINANCE
      else if (format === 0x190A) bpp = 2;   // GL_LUMINANCE_ALPHA
      else if (format === 0x1906) bpp = 1;   // GL_ALPHA
      const size = width * height * bpp;
      pixels = new Uint8Array(size);
      for (let i = 0; i < size; i++) pixels[i] = emu.memory.readU8(pixelsPtr + i);
    }

    emu.glContext.build2DMipmaps(target, internalFormat, width, height, format, type, pixels);
    return 0;
  });

  // gluProject(objX, objY, objZ, model[16], proj[16], view[4], winX*, winY*, winZ*)
  //  3 doubles (6 dwords) + 6 pointers = 12 dwords
  glu32.register('gluProject', 12, () => {
    const objX = readDouble(emu, 0);
    const objY = readDouble(emu, 2);
    const objZ = readDouble(emu, 4);
    const modelPtr = emu.readArg(6);
    const projPtr = emu.readArg(7);
    const viewPtr = emu.readArg(8);
    const winXPtr = emu.readArg(9);
    const winYPtr = emu.readArg(10);
    const winZPtr = emu.readArg(11);

    const model = new Float64Array(16);
    const proj = new Float64Array(16);
    for (let i = 0; i < 16; i++) {
      model[i] = readDoubleMem(emu, modelPtr + i * 8);
      proj[i] = readDoubleMem(emu, projPtr + i * 8);
    }
    const vp = [
      emu.memory.readI32(viewPtr),
      emu.memory.readI32(viewPtr + 4),
      emu.memory.readI32(viewPtr + 8),
      emu.memory.readI32(viewPtr + 12),
    ];

    const v = new Float64Array([objX, objY, objZ, 1]);
    const t = new Float64Array(4);
    mat4MulVec4(model, v, t);
    const c = new Float64Array(4);
    mat4MulVec4(proj, t, c);
    if (c[3] === 0) return 0; // GL_FALSE

    const ndcX = c[0] / c[3];
    const ndcY = c[1] / c[3];
    const ndcZ = c[2] / c[3];

    const winX = vp[0] + vp[2] * (ndcX + 1) * 0.5;
    const winY = vp[1] + vp[3] * (ndcY + 1) * 0.5;
    const winZ = (ndcZ + 1) * 0.5;

    if (winXPtr) writeDoubleMem(emu, winXPtr, winX);
    if (winYPtr) writeDoubleMem(emu, winYPtr, winY);
    if (winZPtr) writeDoubleMem(emu, winZPtr, winZ);
    return 1; // GL_TRUE
  });

  glu32.register('gluScaleImage', 9, () => {
    const format = emu.readArg(0);
    const wIn = emu.readArg(1), hIn = emu.readArg(2);
    const wOut = emu.readArg(5), hOut = emu.readArg(6);
    const dataIn = emu.readArg(4);
    const dataOut = emu.readArg(8);
    // Simple nearest-neighbor scale
    let bpp = 4;
    if (format === 0x1907) bpp = 3; // GL_RGB
    else if (format === 0x1909) bpp = 1; // GL_LUMINANCE
    if (dataIn && dataOut && wIn > 0 && hIn > 0 && wOut > 0 && hOut > 0) {
      for (let y = 0; y < hOut; y++) {
        const sy = Math.floor(y * hIn / hOut);
        for (let x = 0; x < wOut; x++) {
          const sx = Math.floor(x * wIn / wOut);
          for (let c = 0; c < bpp; c++) {
            emu.memory.writeU8(dataOut + (y * wOut + x) * bpp + c,
                               emu.memory.readU8(dataIn + (sy * wIn + sx) * bpp + c));
          }
        }
      }
    }
    return 0;
  });
}
