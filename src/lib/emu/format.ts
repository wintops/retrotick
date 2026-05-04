/**
 * Unified C printf-style format string engine.
 *
 * Supports: %d %i %u %x %X %o %s %S %c %p %n %%
 * Flags:    - + 0 (space) #
 * Width:    number or *
 * Precision: .number or .*
 * Length:   h hh l ll (ignored for sizing — all ints are 32-bit in our emulator)
 *
 * `wide` controls whether %s reads UTF-16 and %S reads ANSI (wide=true)
 * or %s reads ANSI and %S reads UTF-16 (wide=false).
 */

import type { Memory } from './memory';

/** Reads the next 32-bit arg and advances the offset/index. */
export interface ArgReader {
  readU32(): number;
}

/** Stack-based arg reader using emu.readArg(). */
export function stackArgReader(readArg: (i: number) => number, startIdx: number): ArgReader {
  let idx = startIdx;
  return { readU32: () => readArg(idx++) };
}

/** va_list (memory) arg reader. */
export function vaListArgReader(mem: Memory, vaList: number): ArgReader {
  let off = 0;
  return { readU32: () => { const v = mem.readU32(vaList + off); off += 4; return v; } };
}

/**
 * Format a printf-style string.
 * @param fmt  The format string (already decoded to JS string)
 * @param args ArgReader for fetching arguments
 * @param mem  Memory for reading string pointers
 * @param wide true if the format string context is wide (UTF-16):
 *             %s reads wide, %S reads ANSI, %c is 16-bit
 *             false: %s reads ANSI, %S reads wide, %c is 8-bit
 */
/**
 * Parse a scanf-style format string.
 * @param str    The input string to scan
 * @param fmt    The format string
 * @param readArg Function to read stack args by index
 * @param startIdx First arg index (after str and fmt)
 * @param mem    Memory for writing results
 * @param wide   true for wide string context
 * @returns Number of fields successfully matched, or -1 (EOF) if no input
 */
export function scanString(
  str: string, fmt: string,
  readArg: (i: number) => number, startIdx: number,
  mem: Memory, wide: boolean
): number {
  let si = 0; // position in input str
  let fi = 0; // position in fmt
  let argIdx = startIdx;
  let matched = 0;

  if (str.length === 0) return -1; // EOF

  while (fi < fmt.length && si <= str.length) {
    const fc = fmt[fi];

    // Whitespace in format matches zero or more whitespace in input
    if (fc === ' ' || fc === '\t' || fc === '\n' || fc === '\r') {
      fi++;
      while (si < str.length && (str[si] === ' ' || str[si] === '\t' || str[si] === '\n' || str[si] === '\r')) si++;
      continue;
    }

    // Non-% literal must match exactly
    if (fc !== '%') {
      if (si >= str.length || str[si] !== fc) break;
      fi++;
      si++;
      continue;
    }

    fi++; // skip '%'
    if (fi >= fmt.length) break;

    // %% matches literal %
    if (fmt[fi] === '%') {
      if (si >= str.length || str[si] !== '%') break;
      fi++;
      si++;
      continue;
    }

    // Optional * (suppress assignment)
    let suppress = false;
    if (fmt[fi] === '*') { suppress = true; fi++; }

    // Optional width
    let width = 0;
    while (fi < fmt.length && fmt[fi] >= '0' && fmt[fi] <= '9') {
      width = width * 10 + (fmt.charCodeAt(fi) - 48);
      fi++;
    }
    if (width === 0) width = Infinity;

    // Length modifier (consumed but mostly ignored)
    let lengthMod = '';
    if (fi < fmt.length) {
      if (fmt[fi] === 'h') { lengthMod = 'h'; fi++; if (fi < fmt.length && fmt[fi] === 'h') { lengthMod = 'hh'; fi++; } }
      else if (fmt[fi] === 'l') { lengthMod = 'l'; fi++; if (fi < fmt.length && fmt[fi] === 'l') { lengthMod = 'll'; fi++; } }
    }

    if (fi >= fmt.length) break;
    const spec = fmt[fi++];

    // Skip leading whitespace for numeric conversions
    if ('diouxXnp'.includes(spec)) {
      while (si < str.length && (str[si] === ' ' || str[si] === '\t')) si++;
    }

    if (si >= str.length && spec !== 'n') break;

    switch (spec) {
      case 'd': case 'i': case 'u': {
        let numStr = '';
        let maxChars = Math.min(width, str.length - si);
        let j = 0;
        // Optional sign
        if (j < maxChars && (str[si + j] === '-' || str[si + j] === '+')) {
          numStr += str[si + j]; j++;
        }
        // For %i, detect base from prefix
        let base = 10;
        if (spec === 'i' && j + 1 < maxChars && str[si + j] === '0') {
          if (str[si + j + 1] === 'x' || str[si + j + 1] === 'X') {
            base = 16; numStr += str[si + j] + str[si + j + 1]; j += 2;
          } else {
            base = 8;
          }
        }
        const digits = base === 16 ? '0123456789abcdefABCDEF' : base === 8 ? '01234567' : '0123456789';
        while (j < maxChars && digits.includes(str[si + j])) {
          numStr += str[si + j]; j++;
        }
        if (numStr === '' || numStr === '-' || numStr === '+') break; // no match → stop
        si += j;
        if (!suppress) {
          const val = parseInt(numStr, base) | 0;
          const ptr = readArg(argIdx++);
          if (lengthMod === 'h') mem.writeU16(ptr, val & 0xFFFF);
          else if (lengthMod === 'hh') mem.writeU8(ptr, val & 0xFF);
          else mem.writeU32(ptr, val);
          matched++;
        }
        break;
      }
      case 'x': case 'X': {
        let numStr = '';
        let maxChars = Math.min(width, str.length - si);
        let j = 0;
        // Skip optional 0x prefix
        if (j + 1 < maxChars && str[si + j] === '0' && (str[si + j + 1] === 'x' || str[si + j + 1] === 'X')) {
          j += 2;
        }
        while (j < maxChars && '0123456789abcdefABCDEF'.includes(str[si + j])) {
          numStr += str[si + j]; j++;
        }
        if (numStr === '') break;
        si += j;
        if (!suppress) {
          const val = parseInt(numStr, 16) | 0;
          const ptr = readArg(argIdx++);
          mem.writeU32(ptr, val);
          matched++;
        }
        break;
      }
      case 'o': {
        let numStr = '';
        let maxChars = Math.min(width, str.length - si);
        let j = 0;
        while (j < maxChars && str[si + j] >= '0' && str[si + j] <= '7') {
          numStr += str[si + j]; j++;
        }
        if (numStr === '') break;
        si += j;
        if (!suppress) {
          const val = parseInt(numStr, 8) | 0;
          const ptr = readArg(argIdx++);
          mem.writeU32(ptr, val);
          matched++;
        }
        break;
      }
      case 's': {
        // Skip leading whitespace
        while (si < str.length && (str[si] === ' ' || str[si] === '\t' || str[si] === '\n' || str[si] === '\r')) si++;
        let s = '';
        let maxChars = Math.min(width, str.length - si);
        let j = 0;
        while (j < maxChars && str[si + j] !== ' ' && str[si + j] !== '\t' && str[si + j] !== '\n' && str[si + j] !== '\r') {
          s += str[si + j]; j++;
        }
        if (s.length === 0) break;
        si += j;
        if (!suppress) {
          const ptr = readArg(argIdx++);
          if (wide) {
            for (let k = 0; k < s.length; k++) mem.writeU16(ptr + k * 2, s.charCodeAt(k));
            mem.writeU16(ptr + s.length * 2, 0);
          } else {
            for (let k = 0; k < s.length; k++) mem.writeU8(ptr + k, s.charCodeAt(k));
            mem.writeU8(ptr + s.length, 0);
          }
          matched++;
        }
        break;
      }
      case 'c': {
        const count = width === Infinity ? 1 : width;
        if (si + count > str.length) break;
        if (!suppress) {
          const ptr = readArg(argIdx++);
          if (wide) {
            for (let k = 0; k < count; k++) mem.writeU16(ptr + k * 2, str.charCodeAt(si + k));
          } else {
            for (let k = 0; k < count; k++) mem.writeU8(ptr + k, str.charCodeAt(si + k));
          }
          matched++;
        }
        si += count;
        break;
      }
      case 'n': {
        if (!suppress) {
          const ptr = readArg(argIdx++);
          mem.writeU32(ptr, si);
        }
        // %n does not count as a matched field
        break;
      }
      case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': case 'a': case 'A': {
        let numStr = '';
        const maxChars = Math.min(width, str.length - si);
        let j = 0;
        if (j < maxChars && (str[si + j] === '-' || str[si + j] === '+')) { numStr += str[si + j]; j++; }
        while (j < maxChars && str[si + j] >= '0' && str[si + j] <= '9') { numStr += str[si + j]; j++; }
        if (j < maxChars && str[si + j] === '.') {
          numStr += str[si + j]; j++;
          while (j < maxChars && str[si + j] >= '0' && str[si + j] <= '9') { numStr += str[si + j]; j++; }
        }
        if (j < maxChars && (str[si + j] === 'e' || str[si + j] === 'E')) {
          numStr += str[si + j]; j++;
          if (j < maxChars && (str[si + j] === '-' || str[si + j] === '+')) { numStr += str[si + j]; j++; }
          while (j < maxChars && str[si + j] >= '0' && str[si + j] <= '9') { numStr += str[si + j]; j++; }
        }
        const val = parseFloat(numStr);
        if (numStr === '' || numStr === '-' || numStr === '+' || numStr === '.' || isNaN(val)) break;
        si += j;
        if (!suppress) {
          const ptr = readArg(argIdx++);
          const isDouble = lengthMod === 'l' || lengthMod === 'L';
          const buf = new ArrayBuffer(8);
          const dv = new DataView(buf);
          if (isDouble) {
            dv.setFloat64(0, val, true);
            mem.writeU32(ptr, dv.getUint32(0, true));
            mem.writeU32(ptr + 4, dv.getUint32(4, true));
          } else {
            dv.setFloat32(0, val, true);
            mem.writeU32(ptr, dv.getUint32(0, true));
          }
          matched++;
        }
        break;
      }
      default:
        // Unknown specifier — stop
        return matched;
    }
  }
  return matched;
}

export function formatString(fmt: string, args: ArgReader, mem: Memory, wide: boolean): string {
  let result = '';
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] !== '%' || i + 1 >= fmt.length) {
      result += fmt[i++];
      continue;
    }
    i++; // skip '%'

    // Flags
    let flagMinus = false, flagPlus = false, flagZero = false, flagSpace = false, flagHash = false;
    for (;;) {
      const ch = fmt[i];
      if (ch === '-') flagMinus = true;
      else if (ch === '+') flagPlus = true;
      else if (ch === '0') flagZero = true;
      else if (ch === ' ') flagSpace = true;
      else if (ch === '#') flagHash = true;
      else break;
      i++;
    }

    // Width
    let width = 0;
    if (fmt[i] === '*') {
      width = args.readU32() | 0;
      if (width < 0) { flagMinus = true; width = -width; }
      i++;
    } else {
      while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') {
        width = width * 10 + (fmt.charCodeAt(i) - 48);
        i++;
      }
    }

    // Precision
    let precision = -1;
    if (i < fmt.length && fmt[i] === '.') {
      i++;
      precision = 0;
      if (fmt[i] === '*') {
        precision = args.readU32() | 0;
        if (precision < 0) precision = -1;
        i++;
      } else {
        while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') {
          precision = precision * 10 + (fmt.charCodeAt(i) - 48);
          i++;
        }
      }
    }

    // Length modifier (consumed but ignored — all ints are 32-bit)
    if (i < fmt.length) {
      if (fmt[i] === 'h') { i++; if (i < fmt.length && fmt[i] === 'h') i++; }
      else if (fmt[i] === 'l') { i++; if (i < fmt.length && fmt[i] === 'l') i++; }
      else if (fmt[i] === 'I') {
        // MSVC extension: I32, I64
        i++;
        if (fmt[i] === '3' && fmt[i + 1] === '2') i += 2;
        else if (fmt[i] === '6' && fmt[i + 1] === '4') i += 2;
      }
      else if (fmt[i] === 'w') i++; // MSVC wide modifier
    }
    if (i >= fmt.length) break;

    const spec = fmt[i++];

    // Literal %
    if (spec === '%') { result += '%'; continue; }

    let val = '';
    let isNeg = false;
    let isNumeric = false;

    switch (spec) {
      case 'd': case 'i': {
        isNumeric = true;
        const n = args.readU32() | 0;
        isNeg = n < 0;
        val = Math.abs(n).toString();
        break;
      }
      case 'u': {
        isNumeric = true;
        val = (args.readU32() >>> 0).toString();
        break;
      }
      case 'o': {
        isNumeric = true;
        const n = args.readU32() >>> 0;
        val = n.toString(8);
        if (flagHash && val[0] !== '0') val = '0' + val;
        break;
      }
      case 'x': case 'X': {
        isNumeric = true;
        const n = args.readU32() >>> 0;
        val = n.toString(16);
        if (spec === 'X') val = val.toUpperCase();
        if (flagHash && n !== 0) val = (spec === 'X' ? '0X' : '0x') + val;
        break;
      }
      case 'p': {
        isNumeric = true;
        val = (args.readU32() >>> 0).toString(16).toUpperCase().padStart(8, '0');
        break;
      }
      case 's': {
        // %s: wide context → read wide; ANSI context → read ANSI
        const p = args.readU32();
        val = p ? (wide ? mem.readUTF16String(p) : mem.readCString(p)) : '(null)';
        if (precision >= 0 && val.length > precision) val = val.slice(0, precision);
        break;
      }
      case 'S': {
        // %S: opposite of %s
        const p = args.readU32();
        val = p ? (wide ? mem.readCString(p) : mem.readUTF16String(p)) : '(null)';
        if (precision >= 0 && val.length > precision) val = val.slice(0, precision);
        break;
      }
      case 'c': {
        const code = args.readU32();
        val = String.fromCharCode(wide ? (code & 0xFFFF) : (code & 0xFF));
        break;
      }
      case 'C': {
        const code = args.readU32();
        val = String.fromCharCode(wide ? (code & 0xFF) : (code & 0xFFFF));
        break;
      }
      case 'n': {
        // %n writes the number of characters so far to a pointer
        const p = args.readU32();
        if (p) mem.writeU32(p, result.length);
        continue;
      }
      default:
        // Unknown specifier — consume an arg and output literal
        args.readU32();
        result += '%' + spec;
        continue;
    }

    // Apply precision to numeric types (minimum digits)
    if (isNumeric && precision >= 0) {
      // Strip any 0x/0X prefix for padding, re-add after
      let prefix = '';
      if (flagHash && (spec === 'x' || spec === 'X') && val.startsWith('0')) {
        prefix = val.slice(0, 2);
        val = val.slice(2);
      }
      val = val.padStart(precision, '0');
      val = prefix + val;
      flagZero = false; // precision overrides zero-padding for width
    }

    // Sign / space prefix for signed types
    let sign = '';
    if (spec === 'd' || spec === 'i') {
      if (isNeg) sign = '-';
      else if (flagPlus) sign = '+';
      else if (flagSpace) sign = ' ';
    }

    // Apply width padding
    const totalLen = sign.length + val.length;
    if (width > totalLen) {
      const padLen = width - totalLen;
      if (flagMinus) {
        // Left-align: pad right with spaces
        result += sign + val + ' '.repeat(padLen);
      } else if (flagZero && !flagMinus) {
        // Zero-pad between sign and digits
        result += sign + '0'.repeat(padLen) + val;
      } else {
        // Right-align: pad left with spaces
        result += ' '.repeat(padLen) + sign + val;
      }
    } else {
      result += sign + val;
    }
  }
  return result;
}
