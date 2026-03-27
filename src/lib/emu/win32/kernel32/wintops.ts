import type { Emulator } from '../../emulator';
import { GL1Context } from '../gl-context';
 

export function registerWinTops(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');
  const user32 = emu.registerDll('USER32.DLL');
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

  opengl32.register('glColor4f', 1, () => {
    const ptr = emu.readArg(0);
    const v = readFloatPtr(emu, ptr, 4);
    getGL(emu)?.color4f(v[0], v[1], v[2], v[3]);
    return 0;
  });
}
 