import type { Emulator } from '../../emulator';
import { registerModule } from './module';
import { registerProcess } from './process';
import { registerHeap } from './heap';
import { registerString } from './string';
import { registerSync } from './sync';
import { registerTls } from './tls';
import { registerFile } from './file';
import { registerLocale } from './locale';
import { registerSysinfo } from './sysinfo';
import { registerEnv } from './env';
import { registerResource } from './resource';
import { registerProfile } from './profile';
import { registerAtom } from './atom';
import { registerConsole } from './console';
import { registerWinTops } from './wintops';

export function registerKernel32(emu: Emulator): void {
  registerModule(emu);
  registerProcess(emu);
  registerHeap(emu);
  registerString(emu);
  registerSync(emu);
  registerTls(emu);
  registerFile(emu);
  registerLocale(emu);
  registerSysinfo(emu);
  registerEnv(emu);
  registerResource(emu);
  registerProfile(emu);
  registerAtom(emu);
  registerConsole(emu);
   registerWinTops(emu);
}
