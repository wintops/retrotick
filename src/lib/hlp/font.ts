// |FONT parser.

export interface FontDescriptor {
  attributes: number;       // bit flags: bold/italic/underline/strikeout/dbl-underline/smallcaps/mark
  halfPoints: number;       // size in half-points
  family: number;
  facenameIdx: number;
  fgR: number; fgG: number; fgB: number;
  bgR: number; bgG: number; bgB: number;
}

export interface FontTable {
  facenames: string[];
  descriptors: FontDescriptor[];
}

export const FONT_BOLD = 0x01;
export const FONT_ITALIC = 0x02;
export const FONT_UNDERLINE = 0x04;
export const FONT_STRIKEOUT = 0x08;
export const FONT_DBL_UNDERLINE = 0x10;
export const FONT_SMALL_CAPS = 0x20;
export const FONT_MARK = 0x40;

export function parseFont(body: Uint8Array): FontTable {
  if (body.length < 8) return { facenames: [], descriptors: [] };
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const numFacenames = dv.getUint16(0, true);
  const numDescriptors = dv.getUint16(2, true);
  const facenamesOffset = dv.getUint16(4, true);
  const descriptorsOffset = dv.getUint16(6, true);
  const facenameSize = numFacenames > 0 ? Math.floor((descriptorsOffset - facenamesOffset) / numFacenames) : 0;

  const facenames: string[] = [];
  for (let i = 0; i < numFacenames; i++) {
    const off = facenamesOffset + i * facenameSize;
    let s = '';
    for (let j = 0; j < facenameSize; j++) {
      const c = body[off + j];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    facenames.push(s);
  }

  // Descriptor size depends on SystemHeader.Minor and the presence of
  // NumFormats; we infer it from the available bytes.
  const totalRemaining = body.length - descriptorsOffset;
  const descriptorSize = numDescriptors > 0 ? Math.floor(totalRemaining / numDescriptors) : 11;
  const descriptors: FontDescriptor[] = [];
  for (let i = 0; i < numDescriptors; i++) {
    const off = descriptorsOffset + i * descriptorSize;
    if (off + 11 > body.length) break;
    descriptors.push({
      attributes: body[off],
      halfPoints: body[off + 1],
      family: body[off + 2],
      facenameIdx: dv.getUint16(off + 3, true),
      fgR: body[off + 5], fgG: body[off + 6], fgB: body[off + 7],
      bgR: body[off + 8], bgG: body[off + 9], bgB: body[off + 10],
    });
  }

  return { facenames, descriptors };
}
