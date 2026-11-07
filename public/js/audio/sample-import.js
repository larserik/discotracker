// Decode audio files (WAV, MP3, OGG, FLAC, AIFF... whatever the browser supports)
// or raw 8-bit signed data into a tracker sample.
import { createSample, tuningForRate } from '../song.js';

const MAX_SECONDS = 30;

export async function importSampleFile(file) {
  const buf = await file.arrayBuffer();
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 22);
  const ext = file.name.toLowerCase().split('.').pop();
  if (['raw', 'sam'].includes(ext)) return rawSample(buf, name);

  // Decode at the file's own rate when possible (OfflineAudioContext resamples to its rate,
  // so peek at WAV headers first, fall back to 44100).
  const rate = wavRate(buf) || 44100;
  const ctx = new OfflineAudioContext(1, 1, rate);
  let audio;
  try {
    audio = await ctx.decodeAudioData(buf.slice(0));
  } catch {
    throw new Error(`Could not decode "${file.name}". Try WAV, MP3, OGG or FLAC.`);
  }
  const frames = Math.min(audio.length, Math.floor(audio.sampleRate * MAX_SECONDS));
  const data = new Float32Array(frames);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < frames; i++) data[i] += ch[i] / audio.numberOfChannels;
  }
  const { relativeNote, finetune } = tuningForRate(audio.sampleRate);
  const loop = wavLoop(buf);
  return createSample({
    name, data, relativeNote, finetune, bits: 16,
    ...(loop && loop.end <= frames ? { loopType: 1, loopStart: loop.start, loopLength: loop.end - loop.start } : {}),
  });
}

function rawSample(buf, name) {
  const u8 = new Uint8Array(buf);
  const data = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i++) data[i] = (u8[i] < 128 ? u8[i] : u8[i] - 256) / 128;
  // classic raw samples are usually ~16.7 kHz (Amiga C-3)
  return createSample({ name, data, ...tuningForRate(16726), bits: 8 });
}

function riffChunks(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 12 || dv.getUint32(0) !== 0x52494646 || dv.getUint32(8) !== 0x57415645) return null;
  const out = {};
  let o = 12;
  while (o + 8 <= buf.byteLength) {
    const id = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    const size = dv.getUint32(o + 4, true);
    out[id] = { offset: o + 8, size };
    o += 8 + size + (size & 1);
  }
  return { dv, chunks: out };
}

function wavRate(buf) {
  const r = riffChunks(buf);
  if (!r || !r.chunks['fmt ']) return 0;
  return r.dv.getUint32(r.chunks['fmt '].offset + 4, true);
}

function wavLoop(buf) {
  const r = riffChunks(buf);
  const smpl = r?.chunks.smpl;
  if (!smpl || smpl.size < 60) return null;
  const n = r.dv.getUint32(smpl.offset + 28, true);
  if (!n) return null;
  const start = r.dv.getUint32(smpl.offset + 36 + 8, true);
  const end = r.dv.getUint32(smpl.offset + 36 + 12, true) + 1;
  return end > start ? { start, end } : null;
}
