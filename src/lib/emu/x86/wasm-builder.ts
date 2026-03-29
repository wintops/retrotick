/**
 * WASM binary module builder — constructs valid WASM bytecode from scratch.
 *
 * Ported from v86's wasm_builder.rs concept: writes raw WASM opcodes into a
 * byte buffer with LEB128 encoding, local management, control flow labels,
 * and module assembly (types, imports, exports, code section).
 */

import {
  WASM_MAGIC, WASM_VERSION, SC_TYPE, SC_IMPORT, SC_FUNCTION, SC_EXPORT, SC_CODE,
  TYPE_I32, TYPE_FUNC, TYPE_VOID_BLOCK,
  IMPORT_FUNC, IMPORT_MEMORY, EXPORT_FUNC,
  OP_BLOCK, OP_LOOP, OP_IF, OP_ELSE, OP_END, OP_BR, OP_BR_IF, OP_BR_TABLE, OP_RETURN,
  OP_GET_LOCAL, OP_SET_LOCAL, OP_TEE_LOCAL,
  OP_I32_LOAD, OP_I32_LOAD8_U, OP_I32_LOAD16_U, OP_I32_STORE, OP_I32_STORE8, OP_I32_STORE16,
  OP_I32_CONST,
  OP_I32_EQZ, OP_I32_EQ, OP_I32_NE,
  OP_I32_LT_S, OP_I32_LT_U, OP_I32_GT_S, OP_I32_GT_U,
  OP_I32_LE_S, OP_I32_LE_U, OP_I32_GE_S, OP_I32_GE_U,
  OP_I32_ADD, OP_I32_SUB, OP_I32_MUL, OP_I32_DIV_S, OP_I32_DIV_U,
  OP_I32_REM_S, OP_I32_REM_U,
  OP_I32_AND, OP_I32_OR, OP_I32_XOR,
  OP_I32_SHL, OP_I32_SHR_S, OP_I32_SHR_U, OP_I32_ROTL, OP_I32_ROTR,
  OP_CALL, OP_DROP, OP_SELECT,
  MEM_NO_ALIGN, MEM_ALIGN32,
  OP_I32_LOAD8_S, OP_I32_LOAD16_S,
} from './wasm-opcodes';

/** Write an unsigned LEB128 value into a byte array */
function writeLebU32(buf: number[], val: number): void {
  val = val >>> 0;
  do {
    let byte = val & 0x7F;
    val >>>= 7;
    if (val !== 0) byte |= 0x80;
    buf.push(byte);
  } while (val !== 0);
}

/** Write a signed LEB128 value into a byte array */
function writeLebI32(buf: number[], val: number): void {
  val = val | 0;
  let more = true;
  while (more) {
    let byte = val & 0x7F;
    val >>= 7;
    if ((val === 0 && (byte & 0x40) === 0) || (val === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    buf.push(byte);
  }
}

/** Write a UTF-8 string prefixed by its length */
function writeString(buf: number[], s: string): void {
  writeLebU32(buf, s.length);
  for (let i = 0; i < s.length; i++) buf.push(s.charCodeAt(i));
}

/** Write a section: section code + length-prefixed content */
function writeSection(out: number[], code: number, content: number[]): void {
  out.push(code);
  writeLebU32(out, content.length);
  for (let i = 0; i < content.length; i++) out.push(content[i]);
}

/** A label for structured control flow (block/loop/if) */
export type Label = number;

/** Function type signature for imports */
interface FuncType {
  params: number[]; // TYPE_I32, TYPE_I64, etc.
  results: number[];
}

export class WasmBuilder {
  /** Instruction body for the main exported function */
  private body: number[] = [];

  /** Registered imports (functions + memory) */
  private imports: { module: string; name: string; kind: 'func' | 'memory'; type?: FuncType; memPages?: number }[] = [];

  /** Unique function type signatures (deduped) */
  private types: FuncType[] = [];

  /** Function params and locals count */
  private paramCount = 0;
  private localCount = 0;
  private freeLocals: number[] = [];

  /** Label nesting depth (for br/br_if depth computation) */
  private labelStack: number[] = [];
  private labelCounter = 0;

  /** Result type of the exported function */
  private resultTypes: number[] = [];

  // --- Local management ---

  /** Set param count (must be called before allocLocal) */
  setParams(count: number): void {
    this.paramCount = count;
    this.localCount = count; // locals start after params
  }

  /** Set result types */
  setResults(types: number[]): void {
    this.resultTypes = types;
  }

  /** Allocate a new i32 local (or reuse a freed one) */
  allocLocal(): number {
    if (this.freeLocals.length > 0) return this.freeLocals.pop()!;
    return this.localCount++;
  }

  /** Free a local for reuse */
  freeLocal(idx: number): void {
    if (idx >= this.paramCount) this.freeLocals.push(idx);
  }

  // --- Imports ---

  /** Import a function, returns the function index */
  addFuncImport(module: string, name: string, params: number[], results: number[]): number {
    const typeIdx = this.getOrAddType({ params, results });
    const funcIdx = this.imports.filter(i => i.kind === 'func').length;
    this.imports.push({ module, name, kind: 'func', type: { params, results } });
    return funcIdx;
  }

  /** Import a memory */
  addMemoryImport(module: string, name: string, minPages: number): void {
    this.imports.push({ module, name, kind: 'memory', memPages: minPages });
  }

  /** Find or add a function type, return its index */
  private getOrAddType(ft: FuncType): number {
    for (let i = 0; i < this.types.length; i++) {
      const t = this.types[i];
      if (t.params.length === ft.params.length && t.results.length === ft.results.length &&
          t.params.every((p, j) => p === ft.params[j]) &&
          t.results.every((r, j) => r === ft.results[j])) {
        return i;
      }
    }
    this.types.push(ft);
    return this.types.length - 1;
  }

  // --- Instructions ---

  constI32(val: number): void { this.body.push(OP_I32_CONST); writeLebI32(this.body, val); }
  getLocal(idx: number): void { this.body.push(OP_GET_LOCAL); writeLebU32(this.body, idx); }
  setLocal(idx: number): void { this.body.push(OP_SET_LOCAL); writeLebU32(this.body, idx); }
  teeLocal(idx: number): void { this.body.push(OP_TEE_LOCAL); writeLebU32(this.body, idx); }

  // Memory
  loadI32(offset: number): void { this.body.push(OP_I32_LOAD, MEM_ALIGN32); writeLebU32(this.body, offset); }
  loadI32Unaligned(offset: number): void { this.body.push(OP_I32_LOAD, MEM_NO_ALIGN); writeLebU32(this.body, offset); }
  loadU8(offset: number): void { this.body.push(OP_I32_LOAD8_U, MEM_NO_ALIGN); writeLebU32(this.body, offset); }
  loadS8(offset: number): void { this.body.push(OP_I32_LOAD8_S, MEM_NO_ALIGN); writeLebU32(this.body, offset); }
  loadU16(offset: number): void { this.body.push(OP_I32_LOAD16_U, MEM_NO_ALIGN); writeLebU32(this.body, offset); }
  loadS16(offset: number): void { this.body.push(OP_I32_LOAD16_S, MEM_NO_ALIGN); writeLebU32(this.body, offset); }
  storeI32(offset: number): void { this.body.push(OP_I32_STORE, MEM_ALIGN32); writeLebU32(this.body, offset); }
  storeI32Unaligned(offset: number): void { this.body.push(OP_I32_STORE, MEM_NO_ALIGN); writeLebU32(this.body, offset); }
  storeU8(offset: number): void { this.body.push(OP_I32_STORE8, MEM_NO_ALIGN); writeLebU32(this.body, offset); }
  storeU16(offset: number): void { this.body.push(OP_I32_STORE16, MEM_NO_ALIGN); writeLebU32(this.body, offset); }

  // Arithmetic
  addI32(): void { this.body.push(OP_I32_ADD); }
  subI32(): void { this.body.push(OP_I32_SUB); }
  mulI32(): void { this.body.push(OP_I32_MUL); }
  divSI32(): void { this.body.push(OP_I32_DIV_S); }
  divUI32(): void { this.body.push(OP_I32_DIV_U); }
  remSI32(): void { this.body.push(OP_I32_REM_S); }
  remUI32(): void { this.body.push(OP_I32_REM_U); }
  andI32(): void { this.body.push(OP_I32_AND); }
  orI32(): void { this.body.push(OP_I32_OR); }
  xorI32(): void { this.body.push(OP_I32_XOR); }
  shlI32(): void { this.body.push(OP_I32_SHL); }
  shrSI32(): void { this.body.push(OP_I32_SHR_S); }
  shrUI32(): void { this.body.push(OP_I32_SHR_U); }
  rotlI32(): void { this.body.push(OP_I32_ROTL); }
  rotrI32(): void { this.body.push(OP_I32_ROTR); }

  // Comparison
  eqzI32(): void { this.body.push(OP_I32_EQZ); }
  eqI32(): void { this.body.push(OP_I32_EQ); }
  neI32(): void { this.body.push(OP_I32_NE); }
  ltSI32(): void { this.body.push(OP_I32_LT_S); }
  ltUI32(): void { this.body.push(OP_I32_LT_U); }
  gtSI32(): void { this.body.push(OP_I32_GT_S); }
  gtUI32(): void { this.body.push(OP_I32_GT_U); }
  leSI32(): void { this.body.push(OP_I32_LE_S); }
  leUI32(): void { this.body.push(OP_I32_LE_U); }
  geSI32(): void { this.body.push(OP_I32_GE_S); }
  geUI32(): void { this.body.push(OP_I32_GE_U); }

  // Misc
  call(funcIdx: number): void { this.body.push(OP_CALL); writeLebU32(this.body, funcIdx); }
  drop(): void { this.body.push(OP_DROP); }
  select(): void { this.body.push(OP_SELECT); }
  return_(): void { this.body.push(OP_RETURN); }

  // --- Control flow ---

  blockVoid(): Label {
    const label = this.labelCounter++;
    this.body.push(OP_BLOCK, TYPE_VOID_BLOCK);
    this.labelStack.push(label);
    return label;
  }

  loopVoid(): Label {
    const label = this.labelCounter++;
    this.body.push(OP_LOOP, TYPE_VOID_BLOCK);
    this.labelStack.push(label);
    return label;
  }

  ifVoid(): void {
    const label = this.labelCounter++;
    this.body.push(OP_IF, TYPE_VOID_BLOCK);
    this.labelStack.push(label);
  }

  elseBlock(): void {
    this.body.push(OP_ELSE);
  }

  end(): void {
    this.body.push(OP_END);
    this.labelStack.pop();
  }

  /** Branch to a label. Depth is computed from the current label stack. */
  br(label: Label): void {
    this.body.push(OP_BR);
    writeLebU32(this.body, this.labelDepth(label));
  }

  brIf(label: Label): void {
    this.body.push(OP_BR_IF);
    writeLebU32(this.body, this.labelDepth(label));
  }

  brTable(targets: Label[], defaultLabel: Label): void {
    this.body.push(OP_BR_TABLE);
    writeLebU32(this.body, targets.length);
    for (const t of targets) writeLebU32(this.body, this.labelDepth(t));
    writeLebU32(this.body, this.labelDepth(defaultLabel));
  }

  private labelDepth(label: Label): number {
    for (let i = this.labelStack.length - 1; i >= 0; i--) {
      if (this.labelStack[i] === label) return this.labelStack.length - 1 - i;
    }
    throw new Error(`Label ${label} not found in stack`);
  }

  // --- Module assembly ---

  /** Finalize and produce a complete WASM binary module */
  finish(): Uint8Array {
    const out: number[] = [];

    // Header
    out.push(...WASM_MAGIC, ...WASM_VERSION);

    // Collect function imports for type section
    const funcImports = this.imports.filter(i => i.kind === 'func');

    // The exported function type
    const exportFuncParams: number[] = [];
    for (let i = 0; i < this.paramCount; i++) exportFuncParams.push(TYPE_I32);
    const exportFuncTypeIdx = this.getOrAddType({ params: exportFuncParams, results: this.resultTypes });

    // Type section
    {
      const sec: number[] = [];
      writeLebU32(sec, this.types.length);
      for (const t of this.types) {
        sec.push(TYPE_FUNC);
        writeLebU32(sec, t.params.length);
        for (const p of t.params) sec.push(p);
        writeLebU32(sec, t.results.length);
        for (const r of t.results) sec.push(r);
      }
      writeSection(out, SC_TYPE, sec);
    }

    // Import section
    {
      const sec: number[] = [];
      writeLebU32(sec, this.imports.length);
      for (const imp of this.imports) {
        writeString(sec, imp.module);
        writeString(sec, imp.name);
        if (imp.kind === 'func') {
          sec.push(IMPORT_FUNC);
          const typeIdx = this.getOrAddType(imp.type!);
          writeLebU32(sec, typeIdx);
        } else {
          sec.push(IMPORT_MEMORY);
          sec.push(0x00); // no maximum
          writeLebU32(sec, imp.memPages!);
        }
      }
      writeSection(out, SC_IMPORT, sec);
    }

    // Function section (1 function: the exported "run")
    {
      const sec: number[] = [];
      writeLebU32(sec, 1); // 1 function
      writeLebU32(sec, exportFuncTypeIdx);
      writeSection(out, SC_FUNCTION, sec);
    }

    // Export section
    {
      const sec: number[] = [];
      writeLebU32(sec, 1); // 1 export
      writeString(sec, 'run');
      sec.push(EXPORT_FUNC);
      writeLebU32(sec, funcImports.length); // function index (after imports)
      writeSection(out, SC_EXPORT, sec);
    }

    // Code section
    {
      const sec: number[] = [];
      writeLebU32(sec, 1); // 1 function body

      // Function body
      const funcBody: number[] = [];

      // Locals declaration: all extra locals are i32
      const extraLocals = this.localCount - this.paramCount;
      if (extraLocals > 0) {
        writeLebU32(funcBody, 1); // 1 local declaration group
        writeLebU32(funcBody, extraLocals);
        funcBody.push(TYPE_I32);
      } else {
        writeLebU32(funcBody, 0); // no locals
      }

      // Instruction body
      for (let i = 0; i < this.body.length; i++) funcBody.push(this.body[i]);
      funcBody.push(OP_END); // function end

      // Write function body with length prefix
      writeLebU32(sec, funcBody.length);
      for (let i = 0; i < funcBody.length; i++) sec.push(funcBody[i]);

      writeSection(out, SC_CODE, sec);
    }

    return new Uint8Array(out);
  }

  /** Reset the builder for reuse */
  reset(): void {
    this.body.length = 0;
    this.imports.length = 0;
    this.types.length = 0;
    this.paramCount = 0;
    this.localCount = 0;
    this.freeLocals.length = 0;
    this.labelStack.length = 0;
    this.labelCounter = 0;
    this.resultTypes.length = 0;
  }
}
