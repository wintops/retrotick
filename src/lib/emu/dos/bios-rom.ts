import type { Memory } from '../memory';

// F0000-FFFFF = 64KB "system BIOS" ROM region on IBM-compatible PCs.
export const BIOS_SEG = 0xF000;
export const BIOS_BASE = BIOS_SEG * 16; // 0xF0000

// Well-known offsets inside the system BIOS used by IBM-compatible BIOSes
// (DOSBox uses the same layout). DOS extenders (EOS, DOS/4G, DOS/16M) read
// from these addresses during bootstrap to discover BIOS services and to
// verify they are running on a real PC.
export const BIOS_RESET_OFF           = 0xFFF0; // CPU reset entry (FAR JMP to POST)
export const BIOS_DATE_OFF            = 0xFFF5; // 8-byte "MM/DD/YY" date string
export const BIOS_MACHINE_ID_OFF      = 0xFFFE; // Machine ID byte (0xFC = PC/AT)
export const BIOS_COPYRIGHT_OFF       = 0xE000; // Copyright / vendor string
export const BIOS_POST_OFF            = 0xE05B; // POST entry (IBM-compatible)
export const BIOS_DEFAULT_HANDLER_OFF = 0xFF53; // Default IRET for unhooked INTs
export const BIOS_DEFAULT_IRQ0_OFF    = 0xFEA5; // Default IRQ0 handler
export const BIOS_DEFAULT_INT5_OFF    = 0xFF54; // INT 05h (Print Screen) IRET
export const BIOS_FLOPPY_PARAMS_OFF   = 0xEFC7; // INT 1Eh diskette parameter table
export const BIOS_VIDEO_PARAMS_OFF    = 0xF0A4; // INT 1Dh video parameter table

/**
 * Write minimal but standard content into the F0000-FFFFF "system BIOS" ROM
 * region: reset vector, POST entry, default handler/IRQ stubs, floppy param
 * table, BIOS date, machine ID, and copyright string.
 *
 * DOS extenders (EOS, DOS/4G, DOS/16M) scan the ROM during PM bootstrap,
 * chasing `IVT[x] + offset` pointers or looking for the machine/date signature
 * to validate a real PC environment. Without these values the extender may
 * read a zero page and derail into null selectors.
 *
 * The region is NOT blanket-filled: some programs (notably DOS/4GW-hosted
 * code) land at otherwise-unused offsets near the end of the ROM and rely on
 * the existing zero-initialized behavior to no-op through them. We only
 * overlay specific, well-known offsets.
 */
export function setupBiosRom(memory: Memory): void {
  memory.writeU8(BIOS_BASE + BIOS_DEFAULT_HANDLER_OFF, 0xCF); // IRET
  memory.writeU8(BIOS_BASE + BIOS_DEFAULT_INT5_OFF,    0xCF); // IRET
  memory.writeU8(BIOS_BASE + BIOS_POST_OFF,            0xCF); // IRET — we never actually boot via reset

  const irq0 = BIOS_BASE + BIOS_DEFAULT_IRQ0_OFF;
  memory.writeU8(irq0 + 0, 0x50);       // PUSH AX
  memory.writeU8(irq0 + 1, 0xB0);       // MOV AL, 20h
  memory.writeU8(irq0 + 2, 0x20);
  memory.writeU8(irq0 + 3, 0xE6);       // OUT 20h, AL (non-specific EOI)
  memory.writeU8(irq0 + 4, 0x20);
  memory.writeU8(irq0 + 5, 0x58);       // POP AX
  memory.writeU8(irq0 + 6, 0xCF);       // IRET

  memory.writeU8(BIOS_BASE + BIOS_RESET_OFF + 0, 0xEA); // FAR JMP
  memory.writeU16(BIOS_BASE + BIOS_RESET_OFF + 1, BIOS_POST_OFF);
  memory.writeU16(BIOS_BASE + BIOS_RESET_OFF + 3, BIOS_SEG);

  // 1.44MB floppy diskette parameter table (INT 1Eh target in real BIOSes).
  const fpt = BIOS_BASE + BIOS_FLOPPY_PARAMS_OFF;
  memory.writeU8(fpt + 0,  0xDF); // step rate / head unload
  memory.writeU8(fpt + 1,  0x02); // head load time / DMA
  memory.writeU8(fpt + 2,  0x25); // motor-off delay (ticks)
  memory.writeU8(fpt + 3,  0x02); // bytes per sector: 2 = 512
  memory.writeU8(fpt + 4,  18);   // sectors per track (1.44MB)
  memory.writeU8(fpt + 5,  0x1B); // gap length
  memory.writeU8(fpt + 6,  0xFF); // data length
  memory.writeU8(fpt + 7,  0x54); // format gap
  memory.writeU8(fpt + 8,  0xF6); // format filler
  memory.writeU8(fpt + 9,  15);   // head settle time (ms)
  memory.writeU8(fpt + 10, 8);    // motor start time

  const date = '04/21/26';
  for (let i = 0; i < date.length; i++) {
    memory.writeU8(BIOS_BASE + BIOS_DATE_OFF + i, date.charCodeAt(i));
  }

  memory.writeU8(BIOS_BASE + BIOS_MACHINE_ID_OFF, 0xFC);

  const copyright = 'RetroTick BIOS - IBM COMPATIBLE 486 BIOS';
  for (let i = 0; i < copyright.length; i++) {
    memory.writeU8(BIOS_BASE + BIOS_COPYRIGHT_OFF + i, copyright.charCodeAt(i));
  }
}
