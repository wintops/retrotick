import type { Emulator } from '../emulator';

const DS_OK = 0x00000000;

// IDirectSound8 vtable (11 methods):
// 0x00 QueryInterface, 0x04 AddRef, 0x08 Release
// 0x0C CreateSoundBuffer, 0x10 GetCaps, 0x14 DuplicateSoundBuffer
// 0x18 SetCooperativeLevel, 0x1C Compact
// 0x20 GetSpeakerConfig, 0x24 SetSpeakerConfig, 0x28 Initialize
const DS_VTABLE_SIZE = 11;

// IDirectSoundBuffer vtable (14 methods):
// 0x00 QueryInterface, 0x04 AddRef, 0x08 Release
// 0x0C GetCaps, 0x10 GetCurrentPosition, 0x14 GetFormat
// 0x18 GetVolume, 0x1C GetPan, 0x20 GetFrequency
// 0x24 GetStatus, 0x28 Initialize, 0x2C Lock
// 0x30 Play, 0x34 SetCurrentPosition, 0x38 SetFormat
// 0x3C SetVolume, 0x40 SetPan, 0x44 SetFrequency
// 0x48 Stop, 0x4C Unlock, 0x50 Restore
const DSB_VTABLE_SIZE = 21;

function allocComObject(emu: Emulator, prefix: string, methodCount: number,
  handlers: Record<number, () => number>,
  stackBytesMap: Record<number, number>): number {
  const vtableAddr = emu.allocHeap(methodCount * 4);
  const objAddr = emu.allocHeap(4);
  emu.memory.writeU32(objAddr, vtableAddr);

  for (let i = 0; i < methodCount; i++) {
    const thunkAddr = emu.dynamicThunkPtr;
    emu.dynamicThunkPtr += 4;
    emu.memory.writeU32(vtableAddr + i * 4, thunkAddr);

    const methodName = `${prefix}_Method${i}`;
    const handler = handlers[i];
    const sb = (stackBytesMap[i] ?? 1) * 4;

    if (handler) {
      emu.thunkToApi.set(thunkAddr, { dll: 'DSOUND.DLL', name: methodName, stackBytes: sb });
      emu.thunkPages.add(thunkAddr >>> 12);
      emu.apiDefs.set(`DSOUND.DLL:${methodName}`, { handler, stackBytes: sb });
    } else {
      emu.thunkToApi.set(thunkAddr, { dll: 'DSOUND.DLL', name: methodName, stackBytes: sb });
      emu.thunkPages.add(thunkAddr >>> 12);
      emu.apiDefs.set(`DSOUND.DLL:${methodName}`, { handler: () => {
        console.log(`Unimplemented COM: ${methodName} (vtable offset 0x${(i * 4).toString(16)})`);
        return DS_OK;
      }, stackBytes: sb });
    }
  }

  return objAddr;
}

function createSoundBuffer(emu: Emulator, bufferSize: number = 4096,
    sampleRate: number = 22050, channels: number = 1, bitsPerSample: number = 8): number {
  // Allocate the actual buffer memory once
  const bufferAddr = emu.allocHeap(bufferSize);
  const handlers: Record<number, () => number> = {};
  handlers[0] = () => DS_OK; // QI - return same object
  handlers[1] = () => 2;     // AddRef
  handlers[2] = () => 0;     // Release
  // GetCaps (3) - this, pDSBufferCaps
  handlers[3] = () => {
    const capsPtr = emu.readArg(1);
    if (capsPtr) {
      emu.memory.writeU32(capsPtr, 20); // dwSize
      emu.memory.writeU32(capsPtr + 4, 0); // dwFlags
      emu.memory.writeU32(capsPtr + 8, bufferSize); // dwBufferBytes
      emu.memory.writeU32(capsPtr + 12, 0); // dwUnlockTransferRate
      emu.memory.writeU32(capsPtr + 16, 0); // dwPlayCpuOverhead
    }
    return DS_OK;
  };
  // GetFormat (5) - this, pwfxFormat, dwSizeAllocated, pdwSizeWritten
  handlers[5] = () => {
    const fmtPtr = emu.readArg(1);
    const sizeAlloc = emu.readArg(2);
    const sizeWrittenPtr = emu.readArg(3);
    const blockAlign = channels * (bitsPerSample / 8);
    const avgBytes = sampleRate * blockAlign;
    if (fmtPtr && sizeAlloc >= 16) {
      emu.memory.writeU16(fmtPtr + 0, 1);           // wFormatTag = WAVE_FORMAT_PCM
      emu.memory.writeU16(fmtPtr + 2, channels);
      emu.memory.writeU32(fmtPtr + 4, sampleRate);
      emu.memory.writeU32(fmtPtr + 8, avgBytes);    // nAvgBytesPerSec
      emu.memory.writeU16(fmtPtr + 12, blockAlign);
      emu.memory.writeU16(fmtPtr + 14, bitsPerSample);
      if (sizeAlloc >= 18) emu.memory.writeU16(fmtPtr + 16, 0); // cbSize
    }
    if (sizeWrittenPtr) emu.memory.writeU32(sizeWrittenPtr, 18);
    return DS_OK;
  };
  // Lock (11) - this, offset, bytes, ptr1, size1, ptr2, size2, flags
  handlers[11] = () => {
    const offset = emu.readArg(1);
    const bytes = emu.readArg(2);
    const audioPtr1 = emu.readArg(3);
    const audioSize1 = emu.readArg(4);
    const audioPtr2 = emu.readArg(5);
    const audioSize2 = emu.readArg(6);
    const flags = emu.readArg(7);
    const DSBLOCK_ENTIREBUFFER = 2;
    const lockSize = (flags & DSBLOCK_ENTIREBUFFER) ? bufferSize : Math.min(bytes, bufferSize);
    const lockOffset = offset % bufferSize;
    const size1 = Math.min(lockSize, bufferSize - lockOffset);
    const size2 = lockSize - size1;
    if (audioPtr1) emu.memory.writeU32(audioPtr1, bufferAddr + lockOffset);
    if (audioSize1) emu.memory.writeU32(audioSize1, size1);
    if (audioPtr2) emu.memory.writeU32(audioPtr2, size2 > 0 ? bufferAddr : 0);
    if (audioSize2) emu.memory.writeU32(audioSize2, size2);
    return DS_OK;
  };
  handlers[12] = () => DS_OK; // Play
  handlers[13] = () => DS_OK; // SetCurrentPosition
  handlers[14] = () => DS_OK; // SetFormat
  handlers[15] = () => DS_OK; // SetVolume
  handlers[16] = () => DS_OK; // SetPan
  handlers[17] = () => DS_OK; // SetFrequency
  handlers[18] = () => DS_OK; // Stop
  handlers[19] = () => DS_OK; // Unlock
  handlers[20] = () => DS_OK; // Restore
  // GetStatus (7) - this, status
  handlers[7] = () => {
    const statusPtr = emu.readArg(1);
    if (statusPtr) emu.memory.writeU32(statusPtr, 0); // not playing
    return DS_OK;
  };
  // GetCurrentPosition (4) - this, playCursor, writeCursor
  handlers[4] = () => {
    const playPtr = emu.readArg(1);
    const writePtr = emu.readArg(2);
    if (playPtr) emu.memory.writeU32(playPtr, 0);
    if (writePtr) emu.memory.writeU32(writePtr, 0);
    return DS_OK;
  };

  const stackBytesMap: Record<number, number> = {
    0: 3, 1: 1, 2: 1,       // QI, AddRef, Release
    3: 2,                     // GetCaps(this, caps)
    4: 3,                     // GetCurrentPosition(this, play, write)
    5: 4,                     // GetFormat(this, fmt, size, written)
    6: 2, 7: 2, 8: 2,       // GetVolume, GetPan/GetStatus(renamed), GetFrequency
    9: 3,                     // Initialize(this, ds, desc) -- actually GetStatus is 7
    10: 3,                    // Initialize(this, ds, desc)
    11: 8,                    // Lock(this, off, bytes, p1, s1, p2, s2, flags)
    12: 4,                    // Play(this, res1, res2, flags)
    13: 2,                    // SetCurrentPosition(this, pos)
    14: 2,                    // SetFormat(this, fmt)
    15: 2,                    // SetVolume(this, vol)
    16: 2,                    // SetPan(this, pan)
    17: 2,                    // SetFrequency(this, freq)
    18: 1,                    // Stop(this)
    19: 5,                    // Unlock(this, p1, s1, p2, s2)
    20: 1,                    // Restore(this)
  };

  return allocComObject(emu, 'DSB', DSB_VTABLE_SIZE, handlers, stackBytesMap);
}

export function registerDsound(emu: Emulator): void {
  const dsound = emu.registerDll('DSOUND.DLL');

  // DirectSoundCreate(lpGuid, ppDS, pUnkOuter) → HRESULT
  dsound.register('DirectSoundCreate', 3, () => {
    const _lpGuid = emu.readArg(0);
    const ppDS = emu.readArg(1);

    const handlers: Record<number, () => number> = {};
    handlers[0] = () => DS_OK; // QI
    handlers[1] = () => 2;     // AddRef
    handlers[2] = () => 0;     // Release
    // CreateSoundBuffer (3) - this, desc, outBuffer, outer
    handlers[3] = () => {
      const descPtr = emu.readArg(1);
      const outPtr = emu.readArg(2);
      // DSBUFFERDESC: dwSize(4), dwFlags(4), dwBufferBytes(4), dwReserved(4), lpwfxFormat(4)
      let bufBytes = 4096;
      let sr = 22050, ch = 1, bps = 8;
      if (descPtr) {
        bufBytes = emu.memory.readU32(descPtr + 8) || 4096; // dwBufferBytes
        const fmtPtr = emu.memory.readU32(descPtr + 16); // lpwfxFormat
        if (fmtPtr) {
          ch = emu.memory.readU16(fmtPtr + 2) || 1;
          sr = emu.memory.readU32(fmtPtr + 4) || 22050;
          bps = emu.memory.readU16(fmtPtr + 14) || 8;
        }
      }
      console.log(`[DSOUND] CreateSoundBuffer size=${bufBytes} ${sr}Hz ${ch}ch ${bps}bit`);
      const buf = createSoundBuffer(emu, bufBytes, sr, ch, bps);
      if (outPtr) emu.memory.writeU32(outPtr, buf);
      return DS_OK;
    };
    // GetCaps (4)
    handlers[4] = () => DS_OK;
    // DuplicateSoundBuffer (5) - this, srcBuffer, outBuffer
    handlers[5] = () => {
      const outPtr = emu.readArg(2);
      const buf = createSoundBuffer(emu);
      return DS_OK;
    };
    // SetCooperativeLevel (6) - this, hwnd, level
    handlers[6] = () => DS_OK;
    // Compact (7)
    handlers[7] = () => DS_OK;
    // GetSpeakerConfig (8) - this, pdwSpeakerConfig
    handlers[8] = () => {
      const outPtr = emu.readArg(1);
      if (outPtr) emu.memory.writeU32(outPtr, 0x00000200); // DSSPEAKER_STEREO
      return DS_OK;
    };
    // SetSpeakerConfig (9) - this, dwSpeakerConfig
    handlers[9] = () => DS_OK;
    // Initialize (10) - this, pcGuidDevice
    handlers[10] = () => DS_OK;

    const stackBytesMap: Record<number, number> = {
      0: 3, 1: 1, 2: 1,
      3: 4, // CreateSoundBuffer(this, desc, out, outer)
      4: 2, // GetCaps(this, caps)
      5: 3, // DuplicateSoundBuffer(this, src, out)
      6: 3, // SetCooperativeLevel(this, hwnd, level)
      7: 1, // Compact(this)
      8: 2, // GetSpeakerConfig(this, out)
      9: 2, // SetSpeakerConfig(this, config)
      10: 2, // Initialize(this, guid)
    };

    const dsObj = allocComObject(emu, 'DS', DS_VTABLE_SIZE, handlers, stackBytesMap);
    if (ppDS) emu.memory.writeU32(ppDS, dsObj);

    console.log(`[DSOUND] Created IDirectSound at 0x${dsObj.toString(16)}`);
    return DS_OK;
  });
}
