import type { Emulator } from '../emulator';

// Win87em.dll — Windows 3.x 80x87 math coprocessor emulator
// Based on Wine's win87em.dll16 implementation
// Most apps just need the install/deinstall/query stubs.

// Register indices
const EAX = 0, EDX = 2, EBX = 3;

export function registerWin16Win87em(emu: Emulator): void {
  const mod = emu.registerModule16('WIN87EM');

  let refCount = 0;
  let ctrlWord = 0;
  let savedAx = 0;

  // --- Ordinal 1: __fpMath() — register-based dispatch on BX ---
  // This is a register-based call; Wine dispatches on context->Ebx.
  // In our 16-bit emulator, BX holds the sub-operation code.
  mod.register('__fpMath', 0, () => {
    const cpu = emu.cpu;
    const op = cpu.getReg16(EBX);

    switch (op) {
      case 0: // Install emulator
        refCount++;
        cpu.setReg16(EAX, 0);
        break;
      case 1: // Init emulator
        cpu.setReg16(EAX, 0);
        break;
      case 2: // Deinstall emulator
        if (refCount > 0) refCount--;
        cpu.setReg16(EAX, 0);
        break;
      case 3: // Set interrupt handler — not implemented
        break;
      case 4: // Set control word from AX
        ctrlWord = cpu.getReg16(EAX);
        break;
      case 5: // Get control word → AX
        cpu.setReg16(EAX, ctrlWord);
        break;
      case 6: // Round stack top to integer — stub
        break;
      case 7: // Pop stack value as integer → DX:AX — stub
        cpu.setReg16(EAX, 0);
        cpu.setReg16(EDX, 0);
        break;
      case 8: // Restore internal status — stub
        break;
      case 9: // Clear control word
        ctrlWord = 0;
        break;
      case 10: // Return number of stack items → AX
        cpu.setReg16(EAX, 0);
        break;
      case 11: // Return installed flag → DX:AX (1 = installed)
        cpu.setReg16(EDX, 0);
        cpu.setReg16(EAX, 1);
        break;
      case 12: // Save AX value
        savedAx = cpu.getReg16(EAX);
        break;
      default:
        // Unknown sub-operation — set error
        cpu.setReg16(EAX, 0);
        break;
    }
    return 0;
  }, 1);

  // --- Ordinal 3: __WinEm87Info(ptr, word) — 6 bytes (dword ptr + word) ---
  mod.register('__WinEm87Info', 6, () => 0, 3);

  // --- Ordinal 4: __WinEm87Restore(ptr, word) — 6 bytes ---
  mod.register('__WinEm87Restore', 6, () => 0, 4);

  // --- Ordinal 5: __WinEm87Save(ptr, word) — 6 bytes ---
  mod.register('__WinEm87Save', 6, () => 0, 5);
}
