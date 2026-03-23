/** WASM binary format constants — section codes, type codes, and instruction opcodes. */

// Magic number and version
export const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6D];
export const WASM_VERSION = [0x01, 0x00, 0x00, 0x00];

// Section codes
export const SC_TYPE = 1;
export const SC_IMPORT = 2;
export const SC_FUNCTION = 3;
export const SC_MEMORY = 5;
export const SC_EXPORT = 7;
export const SC_CODE = 10;

// Type codes
export const TYPE_I32 = 0x7F;
export const TYPE_I64 = 0x7E;
export const TYPE_F32 = 0x7D;
export const TYPE_F64 = 0x7C;
export const TYPE_FUNC = 0x60;
export const TYPE_VOID_BLOCK = 0x40;
export const TYPE_I32_BLOCK = 0x7F; // block returning i32

// Export kinds
export const EXPORT_FUNC = 0x00;
export const EXPORT_MEMORY = 0x02;

// Import kinds
export const IMPORT_FUNC = 0x00;
export const IMPORT_MEMORY = 0x02;

// Memory alignment
export const MEM_NO_ALIGN = 0;
export const MEM_ALIGN16 = 1;
export const MEM_ALIGN32 = 2;
export const MEM_ALIGN64 = 3;

// Control flow
export const OP_UNREACHABLE = 0x00;
export const OP_NOP = 0x01;
export const OP_BLOCK = 0x02;
export const OP_LOOP = 0x03;
export const OP_IF = 0x04;
export const OP_ELSE = 0x05;
export const OP_END = 0x0B;
export const OP_BR = 0x0C;
export const OP_BR_IF = 0x0D;
export const OP_BR_TABLE = 0x0E;
export const OP_RETURN = 0x0F;
export const OP_CALL = 0x10;
export const OP_DROP = 0x1A;
export const OP_SELECT = 0x1B;

// Local/global
export const OP_GET_LOCAL = 0x20;
export const OP_SET_LOCAL = 0x21;
export const OP_TEE_LOCAL = 0x22;

// Memory
export const OP_I32_LOAD = 0x28;
export const OP_I64_LOAD = 0x29;
export const OP_I32_LOAD8_S = 0x2C;
export const OP_I32_LOAD8_U = 0x2D;
export const OP_I32_LOAD16_S = 0x2E;
export const OP_I32_LOAD16_U = 0x2F;
export const OP_I32_STORE = 0x36;
export const OP_I32_STORE8 = 0x3A;
export const OP_I32_STORE16 = 0x3B;

// Constants
export const OP_I32_CONST = 0x41;
export const OP_I64_CONST = 0x42;

// Comparison
export const OP_I32_EQZ = 0x45;
export const OP_I32_EQ = 0x46;
export const OP_I32_NE = 0x47;
export const OP_I32_LT_S = 0x48;
export const OP_I32_LT_U = 0x49;
export const OP_I32_GT_S = 0x4A;
export const OP_I32_GT_U = 0x4B;
export const OP_I32_LE_S = 0x4C;
export const OP_I32_LE_U = 0x4D;
export const OP_I32_GE_S = 0x4E;
export const OP_I32_GE_U = 0x4F;

// Arithmetic
export const OP_I32_CLZ = 0x67;
export const OP_I32_CTZ = 0x68;
export const OP_I32_ADD = 0x6A;
export const OP_I32_SUB = 0x6B;
export const OP_I32_MUL = 0x6C;
export const OP_I32_DIV_S = 0x6D;
export const OP_I32_DIV_U = 0x6E;
export const OP_I32_REM_S = 0x6F;
export const OP_I32_REM_U = 0x70;
export const OP_I32_AND = 0x71;
export const OP_I32_OR = 0x72;
export const OP_I32_XOR = 0x73;
export const OP_I32_SHL = 0x74;
export const OP_I32_SHR_S = 0x75;
export const OP_I32_SHR_U = 0x76;
export const OP_I32_ROTL = 0x77;
export const OP_I32_ROTR = 0x78;
