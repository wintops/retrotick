// LZ77 decompressor used for |TOPIC blocks, |PhrImage, and |Phrases (HCW31+).
// 12-bit distance window (1..4096), 4-bit length (3..18), 8 literals or
// back-refs per flag byte.
export function lz77Decompress(src: Uint8Array, decompSize: number): Uint8Array {
  const out = new Uint8Array(decompSize);
  let outLen = 0;
  let i = 0;
  while (i < src.length && outLen < decompSize) {
    const flag = src[i++];
    for (let bit = 0; bit < 8; bit++) {
      if (i >= src.length || outLen >= decompSize) break;
      if ((flag & (1 << bit)) === 0) {
        out[outLen++] = src[i++];
      } else {
        if (i + 1 >= src.length) return out.subarray(0, outLen);
        const w = src[i] | (src[i + 1] << 8);
        i += 2;
        const length = (w >> 12) + 3;
        const distance = (w & 0x0FFF) + 1;
        const start = outLen - distance;
        if (start < 0) return out.subarray(0, outLen);
        for (let k = 0; k < length && outLen < decompSize; k++) {
          out[outLen++] = out[start + k];
        }
      }
    }
  }
  return out.subarray(0, outLen);
}

