import type { Emulator } from '../emulator';
import { rvaToFileOffset } from '../../pe/read';

// PlaySound flags
const SND_NODEFAULT   = 0x0002;
const SND_MEMORY      = 0x0004;
const SND_LOOP        = 0x0008;
const SND_PURGE       = 0x0040;
const SND_RESOURCE_ID = 0x00040000;

const RT_RCDATA = 10;

/**
 * Parse a RIFF WAV from a Uint8Array and return an AudioBuffer.
 * Returns null if the data is not valid WAV.
 */
function parseWav(data: Uint8Array, audioCtx: AudioContext): AudioBuffer | null {
  if (data.length < 44) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // RIFF header
  const riff = view.getUint32(0, false); // 'RIFF' big-endian
  if (riff !== 0x52494646) return null;
  const wave = view.getUint32(8, false); // 'WAVE'
  if (wave !== 0x57415645) return null;

  // Find 'fmt ' and 'data' chunks
  let fmtOffset = -1, dataOffset = -1, dataSize = 0;
  let pos = 12;
  while (pos + 8 <= data.length) {
    const chunkId = view.getUint32(pos, false);
    const chunkSize = view.getUint32(pos + 4, true);
    if (chunkId === 0x666D7420) { // 'fmt '
      fmtOffset = pos + 8;
    } else if (chunkId === 0x64617461) { // 'data'
      dataOffset = pos + 8;
      dataSize = chunkSize;
    }
    pos += 8 + ((chunkSize + 1) & ~1); // pad to word boundary
  }

  if (fmtOffset < 0 || dataOffset < 0) return null;

  const formatTag = view.getUint16(fmtOffset, true);
  if (formatTag !== WAVE_FORMAT_PCM) return null;

  const channels = view.getUint16(fmtOffset + 2, true);
  const sampleRate = view.getUint32(fmtOffset + 4, true);
  const bitsPerSample = view.getUint16(fmtOffset + 14, true);
  const bytesPerSample = bitsPerSample >> 3;
  const numSamples = Math.floor(dataSize / (bytesPerSample * channels));
  if (numSamples === 0) return null;

  const audioBuffer = audioCtx.createBuffer(channels, numSamples, sampleRate);
  const pcm = new DataView(data.buffer, data.byteOffset + dataOffset, dataSize);

  for (let ch = 0; ch < channels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < numSamples; i++) {
      const byteOff = (i * channels + ch) * bytesPerSample;
      if (byteOff + bytesPerSample > dataSize) break;
      if (bitsPerSample === 8) {
        channelData[i] = (pcm.getUint8(byteOff) - 128) / 128;
      } else {
        channelData[i] = pcm.getInt16(byteOff, true) / 32768;
      }
    }
  }

  return audioBuffer;
}

/**
 * Search resource directory for entries matching a string type name (e.g. "WAVE").
 * The standard findResourceEntry only handles numeric type IDs.
 */
function findResourceByTypeName(emu: Emulator, typeName: string, nameId: number | string): { dataRva: number; dataSize: number } | null {
  const resRva = emu.pe.resourceRva;
  if (!resRva) return null;
  const base = emu.pe.imageBase + resRva;
  const typeUpper = typeName.toUpperCase();

  const numNamed1 = emu.memory.readU16(base + 12);
  const numId1 = emu.memory.readU16(base + 14);
  let offset1 = base + 16;

  for (let i = 0; i < numNamed1 + numId1; i++) {
    const id = emu.memory.readU32(offset1);
    const off = emu.memory.readU32(offset1 + 4);
    offset1 += 8;

    // Check if this type entry is a named type matching our string
    if (!(id & 0x80000000)) continue; // skip numeric types
    const strAddr = base + (id & 0x7FFFFFFF);
    const strLen = emu.memory.readU16(strAddr);
    let s = '';
    for (let k = 0; k < strLen; k++) {
      s += String.fromCharCode(emu.memory.readU16(strAddr + 2 + k * 2));
    }
    if (s.toUpperCase() !== typeUpper) continue;
    if (!(off & 0x80000000)) continue;

    // Level 2: find the name/id
    const dir2 = base + (off & 0x7FFFFFFF);
    const numNamed2 = emu.memory.readU16(dir2 + 12);
    const numId2 = emu.memory.readU16(dir2 + 14);
    let offset2 = dir2 + 16;
    const nameIsString = typeof nameId === 'string';
    const nameUpper = nameIsString ? (nameId as string).toUpperCase() : '';

    for (let j = 0; j < numNamed2 + numId2; j++) {
      const id2 = emu.memory.readU32(offset2);
      const off2 = emu.memory.readU32(offset2 + 4);
      offset2 += 8;

      let match = false;
      if (nameIsString) {
        if (id2 & 0x80000000) {
          const addr = base + (id2 & 0x7FFFFFFF);
          const len = emu.memory.readU16(addr);
          let ns = '';
          for (let k = 0; k < len; k++) ns += String.fromCharCode(emu.memory.readU16(addr + 2 + k * 2));
          match = ns.toUpperCase() === nameUpper;
        }
      } else {
        if (!(id2 & 0x80000000) && id2 === nameId) match = true;
      }
      if (!match) continue;

      // Level 3: language — take first
      if (!(off2 & 0x80000000)) {
        const dataEntry = base + off2;
        return { dataRva: emu.memory.readU32(dataEntry), dataSize: emu.memory.readU32(dataEntry + 4) };
      }
      const dir3 = base + (off2 & 0x7FFFFFFF);
      const n3 = emu.memory.readU16(dir3 + 12) + emu.memory.readU16(dir3 + 14);
      if (n3 > 0) {
        const off3 = emu.memory.readU32(dir3 + 16 + 4);
        if (!(off3 & 0x80000000)) {
          const dataEntry = base + off3;
          return { dataRva: emu.memory.readU32(dataEntry), dataSize: emu.memory.readU32(dataEntry + 4) };
        }
      }
    }
  }
  return null;
}

function entryToUint8Array(emu: Emulator, entry: { dataRva: number; dataSize: number }): Uint8Array | null {
  try {
    let fileOffset: number;
    try {
      fileOffset = rvaToFileOffset(entry.dataRva, emu.peInfo.sections);
    } catch {
      fileOffset = entry.dataRva;
    }
    return new Uint8Array(emu.arrayBuffer, fileOffset, entry.dataSize);
  } catch {
    return null;
  }
}

/**
 * Try to find WAV resource data by name/id.
 * PlaySound with SND_RESOURCE looks up resource type "WAVE" first, then RT_RCDATA.
 */
function findWavResource(emu: Emulator, nameId: number | string): Uint8Array | null {
  // Try string type "WAVE" (most common for WAV resources)
  const entry = findResourceByTypeName(emu, 'WAVE', nameId);
  if (entry) {
    const data = entryToUint8Array(emu, entry);
    if (data) return data;
  }

  // Fall back to RT_RCDATA
  const rcEntry = emu.findResourceEntry(RT_RCDATA, nameId);
  if (rcEntry) {
    const data = entryToUint8Array(emu, rcEntry);
    if (data) return data;
  }

  return null;
}

interface WaveFormat {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

interface WaveOutDevice {
  format: WaveFormat;
  callback: number;
  callbackFlags: number;
  paused: boolean;
  scheduledTime: number;
  nodes: AudioBufferSourceNode[];
  startTime: number;
}

interface WaveInDevice {
  format: WaveFormat;
  callback: number;
  callbackFlags: number;
  buffers: number[];  // queued WAVEHDR pointers
  recording: boolean;
  startTime: number;
  mediaStream: MediaStream | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  processorNode: ScriptProcessorNode | null;
  // Accumulated PCM samples from microphone (Float32, mono-mixed)
  pendingSamples: Float32Array[];
  pendingSampleCount: number;
}

const WAVE_FORMAT_PCM = 1;
const WHDR_DONE = 0x00000001;
const WHDR_PREPARED = 0x00000002;
const CALLBACK_WINDOW   = 0x00010000;
const CALLBACK_FUNCTION = 0x00030000;
const CALLBACK_TYPEMASK = 0x00070000;
const MM_WOM_DONE = 0x3BD;
const MM_WIM_DATA = 0x3C0;
const MM_WOM_OPEN = 0x3BB;
const MM_WIM_OPEN = 0x3BE;

function stopWaveInRecording(device: WaveInDevice): void {
  device.recording = false;
  if (device.processorNode) {
    device.processorNode.disconnect();
    device.processorNode = null;
  }
  if (device.sourceNode) {
    device.sourceNode.disconnect();
    device.sourceNode = null;
  }
  if (device.mediaStream) {
    device.mediaStream.getTracks().forEach(t => t.stop());
    device.mediaStream = null;
  }
  device.pendingSamples = [];
  device.pendingSampleCount = 0;
}

function fillWaveInBuffers(emu: Emulator, hwi: number, device: WaveInDevice): void {
  while (device.buffers.length > 0 && device.pendingSampleCount > 0) {
    const hdr = device.buffers[0];
    const lpData = emu.memory.readU32(hdr);
    const dwBufferLength = emu.memory.readU32(hdr + 4);
    const { bitsPerSample, channels } = device.format;
    const bytesPerSample = bitsPerSample >> 3;
    const samplesNeeded = Math.floor(dwBufferLength / (bytesPerSample * channels));

    if (device.pendingSampleCount < samplesNeeded) break;

    device.buffers.shift();

    // Consume samples from pending queue
    const samples = new Float32Array(samplesNeeded);
    let written = 0;
    while (written < samplesNeeded) {
      const chunk = device.pendingSamples[0];
      const available = chunk.length;
      const need = samplesNeeded - written;
      if (available <= need) {
        samples.set(chunk, written);
        written += available;
        device.pendingSamples.shift();
        device.pendingSampleCount -= available;
      } else {
        samples.set(chunk.subarray(0, need), written);
        device.pendingSamples[0] = chunk.subarray(need);
        device.pendingSampleCount -= need;
        written += need;
      }
    }

    // Convert Float32 to PCM and write into emulator memory
    let off = lpData;
    for (let i = 0; i < samplesNeeded; i++) {
      const s = samples[i];
      for (let ch = 0; ch < channels; ch++) {
        if (bitsPerSample === 8) {
          emu.memory.writeU8(off, Math.max(0, Math.min(255, Math.round(s * 128 + 128))));
          off += 1;
        } else {
          const v = Math.max(-32768, Math.min(32767, Math.round(s * 32768)));
          emu.memory.writeU8(off, v & 0xFF);
          emu.memory.writeU8(off + 1, (v >> 8) & 0xFF);
          off += 2;
        }
      }
    }

    const bytesWritten = samplesNeeded * bytesPerSample * channels;
    emu.memory.writeU32(hdr + 8, bytesWritten); // dwBytesRecorded
    const flags = emu.memory.readU32(hdr + 16);
    emu.memory.writeU32(hdr + 16, flags | WHDR_DONE);

    const cbType = device.callbackFlags & CALLBACK_TYPEMASK;
    if (cbType === CALLBACK_WINDOW && device.callback) {
      emu.postMessage(device.callback, MM_WIM_DATA, hwi, hdr);
    } else if (cbType === CALLBACK_FUNCTION && device.callback) {
      // Post as window message; DispatchMessage will call the function
      emu.postMessage(0, MM_WIM_DATA, hwi, hdr);
    }
  }
}

export function registerWinmm(emu: Emulator): void {
  const winmm = emu.registerDll('WINMM.DLL');

  // Currently playing looping sound source — stop when a new sound plays
  let loopingSource: AudioBufferSourceNode | null = null;

  function stopLooping() {
    if (loopingSource) {
      try { loopingSource.stop(); } catch { /* already stopped */ }
      loopingSource = null;
    }
  }

  function ensureAudioContext(): AudioContext | null {
    if (typeof AudioContext === 'undefined') return null;
    if (!emu.audioContext) return null;
    if (emu.audioContext.state === 'suspended') {
      emu.audioContext.resume();
    }
    return emu.audioContext;
  }

  /**
   * Resolve WAV data from the arguments and flags.
   * Returns a Uint8Array of the WAV file, or null.
   */
  function resolveWavData(pszSound: number, fdwSound: number, isWide: boolean): Uint8Array | null {
    if (!pszSound) return null;

    if (fdwSound & SND_MEMORY) {
      // pszSound points to in-memory WAV data
      // We need to parse the RIFF header to determine size
      if (pszSound === 0) return null;
      const riffSig = emu.memory.readU32(pszSound);
      if (riffSig !== 0x46464952) return null; // 'RIFF' little-endian
      const fileSize = emu.memory.readU32(pszSound + 4) + 8;
      const wavData = new Uint8Array(fileSize);
      for (let i = 0; i < fileSize; i++) {
        wavData[i] = emu.memory.readU8(pszSound + i);
      }
      return wavData;
    }

    if (fdwSound & SND_RESOURCE_ID) {
      // pszSound is a resource name/id
      // If SND_RESOURCE_ID is set without SND_MEMORY, pszSound is a resource identifier
      const nameId = pszSound; // numeric resource ID
      return findWavResource(emu, nameId);
    }

    // Otherwise pszSound is a filename string — we can try to find it as a resource by name
    const name = isWide ? emu.memory.readUTF16String(pszSound) : emu.memory.readCString(pszSound);
    if (!name) return null;

    // Try as numeric resource ID (if the string is a number)
    const numId = parseInt(name, 10);
    if (!isNaN(numId)) {
      const data = findWavResource(emu, numId);
      if (data) return data;
    }

    // Try as string resource name
    const data = findWavResource(emu, name);
    if (data) return data;

    // Could be a filename — we don't have a filesystem, return null
    console.log(`[WINMM] PlaySound: cannot find sound "${name}"`);
    return null;
  }

  function playSoundImpl(pszSound: number, fdwSound: number, isWide: boolean): number {
    // SND_PURGE: stop currently playing sound
    if (fdwSound & SND_PURGE || pszSound === 0) {
      stopLooping();
      return 1;
    }

    const wavData = resolveWavData(pszSound, fdwSound, isWide);
    if (!wavData) {
      return (fdwSound & SND_NODEFAULT) ? 0 : 1;
    }

    const ctx = ensureAudioContext();
    if (!ctx) return (fdwSound & SND_NODEFAULT) ? 0 : 1;
    const audioBuffer = parseWav(wavData, ctx);
    if (!audioBuffer) {
      console.warn('[WINMM] PlaySound: failed to parse WAV data');
      return 0;
    }

    // Stop any currently looping sound
    stopLooping();

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    if (fdwSound & SND_LOOP) {
      source.loop = true;
      loopingSource = source;
    }

    source.start(0);
    return 1;
  }

  winmm.register('PlaySoundA', 3, () => {
    const pszSound = emu.readArg(0);
    const _hmod = emu.readArg(1);
    const fdwSound = emu.readArg(2);
    return playSoundImpl(pszSound, fdwSound, false);
  });

  winmm.register('PlaySoundW', 3, () => {
    const pszSound = emu.readArg(0);
    const _hmod = emu.readArg(1);
    const fdwSound = emu.readArg(2);
    return playSoundImpl(pszSound, fdwSound, true);
  });

  // sndPlaySoundA(pszSound, fuSound) — simplified version, 2 args
  winmm.register('sndPlaySoundA', 2, () => {
    const pszSound = emu.readArg(0);
    const fuSound = emu.readArg(1);
    return playSoundImpl(pszSound, fuSound, false);
  });
  winmm.register('timeGetTime', 0, () => (Date.now() & 0xFFFFFFFF) >>> 0);

  // timeGetDevCaps(lpTimeCaps, uSize) → MMRESULT
  // TIMECAPS: wPeriodMin(4), wPeriodMax(4) = 8 bytes
  winmm.register('timeGetDevCaps', 2, () => {
    const lpTimeCaps = emu.readArg(0);
    const uSize = emu.readArg(1);
    if (lpTimeCaps && uSize >= 8) {
      emu.memory.writeU32(lpTimeCaps, 1);      // wPeriodMin = 1ms
      emu.memory.writeU32(lpTimeCaps + 4, 1000000); // wPeriodMax
    }
    return 0; // TIMERR_NOERROR
  });

  // timeBeginPeriod(uPeriod) → MMRESULT
  winmm.register('timeBeginPeriod', 1, () => 0);

  // timeEndPeriod(uPeriod) → MMRESULT
  winmm.register('timeEndPeriod', 1, () => 0);

  // timeSetEvent(uDelay, uResolution, lpTimeProc, dwUser, fuEvent) → timerID
  const TIME_ONESHOT = 0x0000;
  const TIME_PERIODIC = 0x0001;
  let nextTimerId = 1;
  winmm.register('timeSetEvent', 5, () => {
    const uDelay = emu.readArg(0);
    const _uResolution = emu.readArg(1);
    const lpTimeProc = emu.readArg(2);
    const dwUser = emu.readArg(3);
    const fuEvent = emu.readArg(4);
    const id = nextTimerId++;
    const periodic = (fuEvent & TIME_PERIODIC) !== 0;
    emu._mmTimers.set(id, {
      callback: lpTimeProc,
      dwUser,
      delay: Math.max(uDelay, 1),
      periodic,
      nextFire: Date.now() + uDelay,
    });
    console.log(`[WINMM] timeSetEvent id=${id} delay=${uDelay} periodic=${periodic} callback=0x${lpTimeProc.toString(16)}`);
    return id;
  });

  // timeKillEvent(uTimerID) → MMRESULT
  winmm.register('timeKillEvent', 1, () => {
    const id = emu.readArg(0);
    emu._mmTimers.delete(id);
    return 0;
  });

  // MCI — stub: return 0 (success, no-op)
  winmm.register('mciSendCommandA', 4, () => 0);
  winmm.register('mciSendCommandW', 4, () => 0);
  winmm.register('mciSendStringA', 4, () => 0);
  winmm.register('mciSendStringW', 4, () => 0);

  // MIDI — stub: no devices
  winmm.register('midiOutGetNumDevs', 0, () => 0);
  winmm.register('midiOutGetDevCapsA', 3, () => 2); // MMSYSERR_BADDEVICEID

  // waveOut implementation
  winmm.register('waveOutGetNumDevs', 0, () => 1);

  // waveOutGetDevCapsA(uDeviceID, pwoc, cbwoc) -> MMRESULT
  // Fills WAVEOUTCAPSA struct (52 bytes):
  //   wMid(2), wPid(2), vDriverVersion(4), szPname(32), dwFormats(4), wChannels(2), wReserved1(2), dwSupport(4)
  const WAVE_FORMAT_1M08 = 0x00000001; // 11.025 kHz, mono,   8-bit
  const WAVE_FORMAT_1S08 = 0x00000002; // 11.025 kHz, stereo, 8-bit
  const WAVE_FORMAT_1M16 = 0x00000004; // 11.025 kHz, mono,   16-bit
  const WAVE_FORMAT_1S16 = 0x00000008; // 11.025 kHz, stereo, 16-bit
  const WAVE_FORMAT_2M08 = 0x00000010; // 22.05  kHz, mono,   8-bit
  const WAVE_FORMAT_2S08 = 0x00000020; // 22.05  kHz, stereo, 8-bit
  const WAVE_FORMAT_2M16 = 0x00000040; // 22.05  kHz, mono,   16-bit
  const WAVE_FORMAT_2S16 = 0x00000080; // 22.05  kHz, stereo, 16-bit
  const WAVE_FORMAT_4M08 = 0x00000100; // 44.1   kHz, mono,   8-bit
  const WAVE_FORMAT_4S08 = 0x00000200; // 44.1   kHz, stereo, 8-bit
  const WAVE_FORMAT_4M16 = 0x00000400; // 44.1   kHz, mono,   16-bit
  const WAVE_FORMAT_4S16 = 0x00000800; // 44.1   kHz, stereo, 16-bit
  const WAVECAPS_VOLUME  = 0x0001;     // supports volume control
  const MMSYSERR_NOERROR = 0;
  const MMSYSERR_BADDEVICEID = 2;
  winmm.register('waveOutGetDevCapsA', 3, () => {
    const uDeviceID = emu.readArg(0);
    const pwoc      = emu.readArg(1);
    const cbwoc     = emu.readArg(2);
    // only device 0 (WAVE_MAPPER = 0xFFFFFFFF is also accepted)
    if (uDeviceID !== 0 && uDeviceID !== 0xFFFFFFFF) return MMSYSERR_BADDEVICEID;
    if (pwoc === 0 || cbwoc < 52) return MMSYSERR_BADDEVICEID;
    emu.memory.writeU16(pwoc + 0,  0x00FF); // wMid: MM_MICROSOFT
    emu.memory.writeU16(pwoc + 2,  0x0001); // wPid: MM_MSFT_GENERIC_WAVEOUT
    emu.memory.writeU32(pwoc + 4,  0x0100); // vDriverVersion: 1.0
    // szPname: "Wave Audio" (null-terminated, 32 bytes)
    const name = 'Wave Audio';
    for (let i = 0; i < 32; i++) {
      emu.memory.writeU8(pwoc + 8 + i, i < name.length ? name.charCodeAt(i) : 0);
    }
    const dwFormats = WAVE_FORMAT_1M08 | WAVE_FORMAT_1S08 | WAVE_FORMAT_1M16 | WAVE_FORMAT_1S16 |
                      WAVE_FORMAT_2M08 | WAVE_FORMAT_2S08 | WAVE_FORMAT_2M16 | WAVE_FORMAT_2S16 |
                      WAVE_FORMAT_4M08 | WAVE_FORMAT_4S08 | WAVE_FORMAT_4M16 | WAVE_FORMAT_4S16;
    emu.memory.writeU32(pwoc + 40, dwFormats);
    emu.memory.writeU16(pwoc + 44, 2);  // wChannels: stereo
    emu.memory.writeU16(pwoc + 46, 0);  // wReserved1
    emu.memory.writeU32(pwoc + 48, WAVECAPS_VOLUME); // dwSupport
    return MMSYSERR_NOERROR;
  });

  winmm.register('waveOutOpen', 6, () => {
    const phwo = emu.readArg(0);
    const _uDeviceID = emu.readArg(1);
    const lpFormat = emu.readArg(2);
    const dwCallback = emu.readArg(3);
    const _dwInstance = emu.readArg(4);
    const fdwOpen = emu.readArg(5);

    const wFormatTag = emu.memory.readU16(lpFormat);
    if (wFormatTag !== WAVE_FORMAT_PCM) return 32; // WAVERR_BADFORMAT

    const channels = emu.memory.readU16(lpFormat + 2);
    const sampleRate = emu.memory.readU32(lpFormat + 4);
    const bitsPerSample = emu.memory.readU16(lpFormat + 14);

    if (emu.audioContext?.state === 'suspended') {
      emu.audioContext.resume();
    }

    const device: WaveOutDevice = {
      format: { channels, sampleRate, bitsPerSample },
      callback: dwCallback,
      callbackFlags: fdwOpen,
      paused: false,
      scheduledTime: 0,
      nodes: [],
      startTime: 0,
    };

    const handle = emu.handles.alloc('waveout', device);
    emu.memory.writeU32(phwo, handle);
    return 0;
  });

  winmm.register('waveOutPrepareHeader', 3, () => {
    const _hwo = emu.readArg(0);
    const lpWaveHdr = emu.readArg(1);
    // Set WHDR_PREPARED flag at dwFlags (offset 16)
    const flags = emu.memory.readU32(lpWaveHdr + 16);
    emu.memory.writeU32(lpWaveHdr + 16, flags | WHDR_PREPARED);
    return 0;
  });

  winmm.register('waveOutUnprepareHeader', 3, () => {
    const _hwo = emu.readArg(0);
    const lpWaveHdr = emu.readArg(1);
    const flags = emu.memory.readU32(lpWaveHdr + 16);
    emu.memory.writeU32(lpWaveHdr + 16, flags & ~WHDR_PREPARED);
    return 0;
  });

  winmm.register('waveOutWrite', 3, () => {
    const hwo = emu.readArg(0);
    const lpWaveHdr = emu.readArg(1);

    const device = emu.handles.get(hwo) as WaveOutDevice | null;
    if (!device) return 5; // MMSYSERR_INVALHANDLE
    // No AudioContext (e.g. Node.js) — mark buffer done immediately and return
    if (!emu.audioContext) {
      const flags = emu.memory.readU32(lpWaveHdr + 16);
      emu.memory.writeU32(lpWaveHdr + 16, flags | WHDR_DONE);
      const cbType = device.callbackFlags & CALLBACK_TYPEMASK;
      if (cbType === CALLBACK_WINDOW && device.callback) {
        emu.postMessage(device.callback, MM_WOM_DONE, hwo, lpWaveHdr);
      }
      return 0;
    }

    const lpData = emu.memory.readU32(lpWaveHdr);
    const dwBufferLength = emu.memory.readU32(lpWaveHdr + 4);
    const { channels, sampleRate, bitsPerSample } = device.format;
    const bytesPerSample = bitsPerSample >> 3;
    const numSamples = Math.floor(dwBufferLength / (bytesPerSample * channels));
    if (numSamples === 0) return 0;

    const ctx = emu.audioContext;
    const audioBuffer = ctx.createBuffer(channels, numSamples, sampleRate);

    for (let ch = 0; ch < channels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < numSamples; i++) {
        const byteOff = lpData + (i * channels + ch) * bytesPerSample;
        if (bitsPerSample === 8) {
          channelData[i] = (emu.memory.readU8(byteOff) - 128) / 128;
        } else {
          // 16-bit signed little-endian
          const lo = emu.memory.readU8(byteOff);
          const hi = emu.memory.readU8(byteOff + 1);
          const sample = (hi << 8) | lo;
          channelData[i] = ((sample << 16) >> 16) / 32768;
        }
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (device.scheduledTime < now) {
      device.scheduledTime = now;
      device.startTime = now;
    }
    source.start(device.scheduledTime);
    device.scheduledTime += audioBuffer.duration;
    device.nodes.push(source);

    // Post MM_WOM_DONE only after buffer finishes playing
    const cbType = device.callbackFlags & CALLBACK_TYPEMASK;
    source.onended = () => {
      const idx = device.nodes.indexOf(source);
      if (idx >= 0) device.nodes.splice(idx, 1);

      // Set WHDR_DONE flag
      const flags = emu.memory.readU32(lpWaveHdr + 16);
      emu.memory.writeU32(lpWaveHdr + 16, flags | WHDR_DONE);

      if (cbType === CALLBACK_WINDOW && device.callback) {
        emu.postMessage(device.callback, MM_WOM_DONE, hwo, lpWaveHdr);
      } else if (cbType === CALLBACK_FUNCTION && device.callback) {
        emu.postMessage(0, MM_WOM_DONE, hwo, lpWaveHdr);
      }
    };

    return 0;
  });

  winmm.register('waveOutPause', 1, () => {
    const hwo = emu.readArg(0);
    const device = emu.handles.get(hwo) as WaveOutDevice | null;
    if (!device) return 5;
    device.paused = true;
    emu.audioContext?.suspend();
    return 0;
  });

  winmm.register('waveOutRestart', 1, () => {
    const hwo = emu.readArg(0);
    const device = emu.handles.get(hwo) as WaveOutDevice | null;
    if (!device) return 5;
    device.paused = false;
    emu.audioContext?.resume();
    return 0;
  });

  winmm.register('waveOutReset', 1, () => {
    const hwo = emu.readArg(0);
    const device = emu.handles.get(hwo) as WaveOutDevice | null;
    if (!device) return 5;
    for (const node of device.nodes) {
      try { node.stop(); } catch (_) { /* already stopped */ }
    }
    device.nodes.length = 0;
    device.scheduledTime = 0;
    return 0;
  });

  winmm.register('waveOutClose', 1, () => {
    const hwo = emu.readArg(0);
    const device = emu.handles.get(hwo) as WaveOutDevice | null;
    if (!device) return 5;
    for (const node of device.nodes) {
      try { node.stop(); } catch (_) { /* already stopped */ }
    }
    device.nodes.length = 0;
    emu.handles.free(hwo);
    return 0;
  });

  winmm.register('waveOutGetPosition', 3, () => {
    const hwo = emu.readArg(0);
    const lpInfo = emu.readArg(1);
    const device = emu.handles.get(hwo) as WaveOutDevice | null;
    if (!device || !emu.audioContext) return 5;

    const elapsed = emu.audioContext.currentTime - device.startTime;
    const { sampleRate, bitsPerSample, channels } = device.format;
    const bytesPerSec = sampleRate * channels * (bitsPerSample >> 3);
    const bytePos = Math.max(0, Math.floor(elapsed * bytesPerSec)) >>> 0;

    // MMTIME structure: wType(4) + union(4)
    // Write as TIME_BYTES (wType=4)
    emu.memory.writeU32(lpInfo, 4); // wType = TIME_BYTES
    emu.memory.writeU32(lpInfo + 4, bytePos);
    return 0;
  });

  // Wave in implementation (real microphone via getUserMedia)
  winmm.register('waveInGetNumDevs', 0, () => 1);

  winmm.register('waveInOpen', 6, () => {
    const phwi = emu.readArg(0);
    const _uDeviceID = emu.readArg(1);
    const lpFormat = emu.readArg(2);
    const dwCallback = emu.readArg(3);
    const _dwInstance = emu.readArg(4);
    const fdwOpen = emu.readArg(5);

    const wFormatTag = emu.memory.readU16(lpFormat);
    if (wFormatTag !== WAVE_FORMAT_PCM) return 32;

    const channels = emu.memory.readU16(lpFormat + 2);
    const sampleRate = emu.memory.readU32(lpFormat + 4);
    const bitsPerSample = emu.memory.readU16(lpFormat + 14);

    const device: WaveInDevice = {
      format: { channels, sampleRate, bitsPerSample },
      callback: dwCallback,
      callbackFlags: fdwOpen,
      buffers: [],
      recording: false,
      startTime: 0,
      mediaStream: null,
      sourceNode: null,
      processorNode: null,
      pendingSamples: [],
      pendingSampleCount: 0,
    };

    const handle = emu.handles.alloc('wavein', device);
    emu.memory.writeU32(phwi, handle);
    return 0;
  });

  winmm.register('waveInPrepareHeader', 3, () => {
    const lpWaveHdr = emu.readArg(1);
    const flags = emu.memory.readU32(lpWaveHdr + 16);
    emu.memory.writeU32(lpWaveHdr + 16, flags | WHDR_PREPARED);
    return 0;
  });

  winmm.register('waveInUnprepareHeader', 3, () => {
    const lpWaveHdr = emu.readArg(1);
    const flags = emu.memory.readU32(lpWaveHdr + 16);
    emu.memory.writeU32(lpWaveHdr + 16, flags & ~WHDR_PREPARED);
    return 0;
  });

  winmm.register('waveInAddBuffer', 3, () => {
    const hwi = emu.readArg(0);
    const lpWaveHdr = emu.readArg(1);
    const device = emu.handles.get(hwi) as WaveInDevice | null;
    if (!device) return 5;
    device.buffers.push(lpWaveHdr);
    // If recording and we have pending samples, try to fill immediately
    if (device.recording) fillWaveInBuffers(emu, hwi, device);
    return 0;
  });

  winmm.register('waveInStart', 1, () => {
    const hwi = emu.readArg(0);
    const device = emu.handles.get(hwi) as WaveInDevice | null;
    if (!device) return 5;
    if (device.recording) return 0;
    device.recording = true;
    device.startTime = Date.now();

    if (!emu.audioContext) {
      device.recording = false;
      return 0;
    }
    const ctx = emu.audioContext;

    // Request microphone access
    navigator.mediaDevices.getUserMedia({ audio: { sampleRate: { ideal: device.format.sampleRate }, channelCount: { ideal: device.format.channels } } }).then(stream => {
      if (!device.recording) { stream.getTracks().forEach(t => t.stop()); return; }
      device.mediaStream = stream;
      device.sourceNode = ctx.createMediaStreamSource(stream);

      // Boost microphone signal — browser mic levels are typically very low
      const gainNode = ctx.createGain();
      gainNode.gain.value = 20;

      // Use ScriptProcessorNode to capture raw PCM
      const bufSize = 4096;
      device.processorNode = ctx.createScriptProcessor(bufSize, device.format.channels, device.format.channels);
      device.processorNode.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!device.recording) return;
        const input = e.inputBuffer.getChannelData(0);
        device.pendingSamples.push(new Float32Array(input));
        device.pendingSampleCount += input.length;
        fillWaveInBuffers(emu, hwi, device);
      };
      device.sourceNode.connect(gainNode);
      gainNode.connect(device.processorNode);
      device.processorNode.connect(ctx.destination); // required for processing to run
    }).catch(() => {
      // Mic permission denied — fall back to silence
      device.recording = false;
    });

    return 0;
  });

  winmm.register('waveInReset', 1, () => {
    const hwi = emu.readArg(0);
    const device = emu.handles.get(hwi) as WaveInDevice | null;
    if (!device) return 5;
    stopWaveInRecording(device);
    // Return all queued buffers with WHDR_DONE
    while (device.buffers.length > 0) {
      const hdr = device.buffers.shift()!;
      emu.memory.writeU32(hdr + 8, 0); // dwBytesRecorded
      const flags = emu.memory.readU32(hdr + 16);
      emu.memory.writeU32(hdr + 16, flags | WHDR_DONE);
    }
    return 0;
  });

  winmm.register('waveInClose', 1, () => {
    const hwi = emu.readArg(0);
    const device = emu.handles.get(hwi) as WaveInDevice | null;
    if (!device) return 5;
    stopWaveInRecording(device);
    device.buffers.length = 0;
    emu.handles.free(hwi);
    return 0;
  });

  winmm.register('waveInGetPosition', 3, () => {
    const hwi = emu.readArg(0);
    const lpInfo = emu.readArg(1);
    const device = emu.handles.get(hwi) as WaveInDevice | null;
    if (!device) return 5;
    const elapsed = (Date.now() - device.startTime) / 1000;
    const { sampleRate, bitsPerSample, channels } = device.format;
    const bytesPerSec = sampleRate * channels * (bitsPerSample >> 3);
    const bytePos = Math.max(0, Math.floor(elapsed * bytesPerSec)) >>> 0;
    emu.memory.writeU32(lpInfo, 4); // TIME_BYTES
    emu.memory.writeU32(lpInfo + 4, bytePos);
    return 0;
  });

  // MMIO — in-memory file I/O for WAV recording/playback
  interface MmioFile {
    data: Uint8Array;
    pos: number;
    size: number;       // logical size (bytes written)
    capacity: number;   // allocated capacity
  }
  const mmioFiles = new Map<number, MmioFile>();
  let nextMmioHandle = 0x5000;

  const mmioOpenImpl = () => {
    // Ignore file name — always create in-memory file
    const initialCap = 1024 * 1024; // 1MB initial
    const handle = nextMmioHandle++;
    mmioFiles.set(handle, {
      data: new Uint8Array(initialCap),
      pos: 0,
      size: 0,
      capacity: initialCap,
    });
    return handle;
  };
  winmm.register('mmioOpenA', 3, mmioOpenImpl);
  winmm.register('mmioOpenW', 3, mmioOpenImpl);

  winmm.register('mmioClose', 2, () => {
    const hmmio = emu.readArg(0);
    mmioFiles.delete(hmmio);
    return 0;
  });

  winmm.register('mmioRead', 3, () => {
    const hmmio = emu.readArg(0);
    const pch = emu.readArg(1);
    const cch = emu.readArg(2);
    const f = mmioFiles.get(hmmio);
    if (!f) return -1;
    const toRead = Math.min(cch, f.size - f.pos);
    if (toRead <= 0) return 0;
    for (let i = 0; i < toRead; i++) {
      emu.memory.writeU8(pch + i, f.data[f.pos + i]);
    }
    f.pos += toRead;
    return toRead;
  });

  winmm.register('mmioWrite', 3, () => {
    const hmmio = emu.readArg(0);
    const pch = emu.readArg(1);
    const cch = emu.readArg(2);
    const f = mmioFiles.get(hmmio);
    if (!f) return -1;
    // Grow buffer if needed
    const needed = f.pos + cch;
    if (needed > f.capacity) {
      const newCap = Math.max(f.capacity * 2, needed);
      const newData = new Uint8Array(newCap);
      newData.set(f.data.subarray(0, f.size));
      f.data = newData;
      f.capacity = newCap;
    }
    for (let i = 0; i < cch; i++) {
      f.data[f.pos + i] = emu.memory.readU8(pch + i);
    }
    f.pos += cch;
    if (f.pos > f.size) f.size = f.pos;
    return cch;
  });

  winmm.register('mmioSeek', 3, () => {
    const hmmio = emu.readArg(0);
    const lOffset = emu.readArg(1) | 0; // signed
    const iOrigin = emu.readArg(2);
    const f = mmioFiles.get(hmmio);
    if (!f) return -1;
    let newPos: number;
    if (iOrigin === 0) newPos = lOffset;           // SEEK_SET
    else if (iOrigin === 1) newPos = f.pos + lOffset; // SEEK_CUR
    else newPos = f.size + lOffset;                    // SEEK_END
    f.pos = Math.max(0, newPos);
    return f.pos;
  });

  // MMCKINFO struct: ckid(4), cksize(4), fccType(4), dwDataOffset(4), dwFlags(4) = 20 bytes
  winmm.register('mmioDescend', 4, () => {
    const hmmio = emu.readArg(0);
    const lpck = emu.readArg(1);
    const lpckParent = emu.readArg(2);
    const fuDescend = emu.readArg(3);
    const f = mmioFiles.get(hmmio);
    if (!f) return -1;
    const MMIO_FINDCHUNK = 0x0010;
    const MMIO_FINDRIFF = 0x0020;

    if (fuDescend & (MMIO_FINDCHUNK | MMIO_FINDRIFF)) {
      // Search for chunk — read from current pos
      const searchId = emu.memory.readU32(lpck); // ckid or fccType to find
      const limit = lpckParent ? emu.memory.readU32(lpckParent + 12) + emu.memory.readU32(lpckParent + 4) + 8 : f.size;
      while (f.pos + 8 <= limit) {
        const ckid = (f.data[f.pos]) | (f.data[f.pos+1]<<8) | (f.data[f.pos+2]<<16) | (f.data[f.pos+3]<<24);
        const cksize = (f.data[f.pos+4]) | (f.data[f.pos+5]<<8) | (f.data[f.pos+6]<<16) | (f.data[f.pos+7]<<24);
        if (fuDescend & MMIO_FINDRIFF) {
          // RIFF/LIST: check fccType at pos+8
          if ((ckid === 0x46464952 || ckid === 0x5453494C) && f.pos + 12 <= limit) { // 'RIFF' or 'LIST'
            const fccType = (f.data[f.pos+8]) | (f.data[f.pos+9]<<8) | (f.data[f.pos+10]<<16) | (f.data[f.pos+11]<<24);
            if (fccType === searchId) {
              emu.memory.writeU32(lpck, ckid);
              emu.memory.writeU32(lpck + 4, cksize);
              emu.memory.writeU32(lpck + 8, fccType);
              emu.memory.writeU32(lpck + 12, f.pos + 12);
              emu.memory.writeU32(lpck + 16, 0);
              f.pos += 12;
              return 0;
            }
          }
        } else {
          if (ckid === searchId) {
            emu.memory.writeU32(lpck, ckid);
            emu.memory.writeU32(lpck + 4, cksize);
            emu.memory.writeU32(lpck + 8, 0);
            emu.memory.writeU32(lpck + 12, f.pos + 8);
            emu.memory.writeU32(lpck + 16, 0);
            f.pos += 8;
            return 0;
          }
        }
        f.pos += 8 + ((cksize + 1) & ~1);
      }
      return 257; // MMIOERR_CHUNKNOTFOUND
    }

    // No search flag — just read current chunk header
    if (f.pos + 8 > f.size) return 257;
    const ckid = (f.data[f.pos]) | (f.data[f.pos+1]<<8) | (f.data[f.pos+2]<<16) | (f.data[f.pos+3]<<24);
    const cksize = (f.data[f.pos+4]) | (f.data[f.pos+5]<<8) | (f.data[f.pos+6]<<16) | (f.data[f.pos+7]<<24);
    emu.memory.writeU32(lpck, ckid);
    emu.memory.writeU32(lpck + 4, cksize);
    if (ckid === 0x46464952 || ckid === 0x5453494C) { // RIFF or LIST
      const fccType = f.pos + 12 <= f.size
        ? (f.data[f.pos+8]) | (f.data[f.pos+9]<<8) | (f.data[f.pos+10]<<16) | (f.data[f.pos+11]<<24)
        : 0;
      emu.memory.writeU32(lpck + 8, fccType);
      emu.memory.writeU32(lpck + 12, f.pos + 12);
      f.pos += 12;
    } else {
      emu.memory.writeU32(lpck + 8, 0);
      emu.memory.writeU32(lpck + 12, f.pos + 8);
      f.pos += 8;
    }
    emu.memory.writeU32(lpck + 16, 0);
    return 0;
  });

  winmm.register('mmioAscend', 3, () => {
    const hmmio = emu.readArg(0);
    const lpck = emu.readArg(1);
    const f = mmioFiles.get(hmmio);
    if (!f) return -1;
    const ckid = emu.memory.readU32(lpck);
    const dataOffset = emu.memory.readU32(lpck + 12);
    const dataSize = f.pos - dataOffset;
    // Update chunk size in file
    const sizeOffset = dataOffset - ((ckid === 0x46464952 || ckid === 0x5453494C) ? 8 : 4);
    if (sizeOffset >= 0 && sizeOffset + 4 <= f.size) {
      f.data[sizeOffset] = dataSize & 0xFF;
      f.data[sizeOffset + 1] = (dataSize >> 8) & 0xFF;
      f.data[sizeOffset + 2] = (dataSize >> 16) & 0xFF;
      f.data[sizeOffset + 3] = (dataSize >> 24) & 0xFF;
    }
    // Also update MMCKINFO.cksize
    emu.memory.writeU32(lpck + 4, dataSize);
    // Pad to word boundary
    if (f.pos & 1) {
      if (f.pos < f.capacity) { f.data[f.pos] = 0; }
      f.pos++;
      if (f.pos > f.size) f.size = f.pos;
    }
    return 0;
  });

  winmm.register('mmioCreateChunk', 3, () => {
    const hmmio = emu.readArg(0);
    const lpck = emu.readArg(1);
    const fuCreate = emu.readArg(2);
    const f = mmioFiles.get(hmmio);
    if (!f) return -1;
    const MMIO_CREATERIFF = 0x0020;
    const MMIO_CREATELIST = 0x0040;
    const ckid = emu.memory.readU32(lpck);
    const fccType = emu.memory.readU32(lpck + 8);

    // Grow if needed
    const needed = f.pos + 12;
    if (needed > f.capacity) {
      const newCap = Math.max(f.capacity * 2, needed);
      const newData = new Uint8Array(newCap);
      newData.set(f.data.subarray(0, f.size));
      f.data = newData;
      f.capacity = newCap;
    }

    if (fuCreate & (MMIO_CREATERIFF | MMIO_CREATELIST)) {
      const id = (fuCreate & MMIO_CREATERIFF) ? 0x46464952 : 0x5453494C; // 'RIFF' or 'LIST'
      f.data[f.pos] = id & 0xFF; f.data[f.pos+1] = (id>>8)&0xFF; f.data[f.pos+2] = (id>>16)&0xFF; f.data[f.pos+3] = (id>>24)&0xFF;
      f.data[f.pos+4] = 0; f.data[f.pos+5] = 0; f.data[f.pos+6] = 0; f.data[f.pos+7] = 0; // size placeholder
      f.data[f.pos+8] = fccType&0xFF; f.data[f.pos+9] = (fccType>>8)&0xFF; f.data[f.pos+10] = (fccType>>16)&0xFF; f.data[f.pos+11] = (fccType>>24)&0xFF;
      emu.memory.writeU32(lpck, id);
      emu.memory.writeU32(lpck + 4, 0);
      emu.memory.writeU32(lpck + 12, f.pos + 12);
      f.pos += 12;
    } else {
      f.data[f.pos] = ckid&0xFF; f.data[f.pos+1] = (ckid>>8)&0xFF; f.data[f.pos+2] = (ckid>>16)&0xFF; f.data[f.pos+3] = (ckid>>24)&0xFF;
      f.data[f.pos+4] = 0; f.data[f.pos+5] = 0; f.data[f.pos+6] = 0; f.data[f.pos+7] = 0;
      emu.memory.writeU32(lpck + 4, 0);
      emu.memory.writeU32(lpck + 12, f.pos + 8);
      f.pos += 8;
    }
    if (f.pos > f.size) f.size = f.pos;
    emu.memory.writeU32(lpck + 16, 0);
    return 0;
  });

  winmm.register('mmioGetInfo', 3, () => 0);
  winmm.register('mmioSetInfo', 3, () => 0);
}
