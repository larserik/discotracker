// ProTracker / NoiseTracker / SoundTracker .MOD loader and writer.
import {
  CELL, NOTE_OFF, createSong, createPattern, createSample, instrumentFromSample,
  LOOP_NONE, LOOP_FORWARD,
} from '../song.js';

const ascii = (u8, off, len) => {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = u8[off + i];
    if (!c) break;
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
  }
  return s.trimEnd();
};

function channelsFromSig(sig) {
  if (['M.K.', 'M!K!', 'M&K!', 'FLT4', '4CHN', 'N.T.', 'FEST'].includes(sig)) return 4;
  if (sig === 'FLT8' || sig === 'OCTA' || sig === 'CD81' || sig === 'OKTA') return 8;
  let m = /^(\d)CHN$/.exec(sig);
  if (m) return +m[1];
  m = /^(\d\d)C[HN]$/.exec(sig);
  if (m) return +m[1];
  m = /^TDZ(\d)$/.exec(sig);
  if (m) return +m[1];
  return 0;
}

export function isMod(u8) {
  if (u8.length >= 1084 && channelsFromSig(ascii(u8, 1080, 4)) > 0) return true;
  // 15-sample Soundtracker: no signature, check that the header looks sane.
  if (u8.length < 600) return false;
  const len = u8[470];
  if (len < 1 || len > 128) return false;
  for (let i = 0; i < 15; i++) {
    const o = 20 + i * 30;
    if (u8[o + 25] > 64) return false;
    for (let j = 0; j < 22; j++) { const c = u8[o + j]; if (c && (c < 32 || c > 126)) return false; }
  }
  for (let i = 0; i < 128; i++) if (u8[472 + i] > 63) return false;
  return true;
}

// Period (ProTracker units) -> XM-style note number (1 = C-0).
// ProTracker C-1 (856) == XM C-3, so 428 (PT C-2) == C-4 (realNote 48).
export function periodToNote(period) {
  if (!period) return 0;
  const n = Math.round(48 + 12 * Math.log2(428 / period));
  return Math.max(1, Math.min(96, n + 1));
}

// PT finetune-0 period table for XM notes, used when writing.
export function noteToPeriod(note) {
  const real = note - 1;
  return Math.round(428 * Math.pow(2, -(real - 48) / 12));
}

export function loadMod(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let sig = u8.length >= 1084 ? ascii(u8, 1080, 4) : '';
  let channels = channelsFromSig(sig);
  let numSamples = 31;
  let headerEnd = 1084;
  if (!channels) {
    // 15-sample Soundtracker module, no signature
    numSamples = 15;
    channels = 4;
    headerEnd = 600;
    sig = '';
  }

  const song = createSong(channels);
  song.format = 'mod';
  song.linear = false;
  song.title = ascii(u8, 0, 20) || 'untitled';
  song.channelPan = Array.from({ length: channels }, (_, c) => ((c & 3) === 0 || (c & 3) === 3 ? 64 : 192));

  const samples = [];
  for (let i = 0; i < numSamples; i++) {
    const o = 20 + i * 30;
    const length = dv.getUint16(o + 22) * 2;
    let ft = u8[o + 24] & 15;
    if (ft > 7) ft -= 16;
    let loopStart = dv.getUint16(o + 26) * 2;
    let loopLength = dv.getUint16(o + 28) * 2;
    if (numSamples === 15) loopStart /= 2; // Soundtracker stored loop start in bytes
    samples.push({ name: ascii(u8, o, 22), length, finetune: ft * 16, volume: Math.min(64, u8[o + 25]), loopStart, loopLength });
  }

  const posBase = 20 + numSamples * 30;
  const songLen = Math.max(1, Math.min(128, u8[posBase]));
  const restart = u8[posBase + 1];
  const orderTable = Array.from(u8.subarray(posBase + 2, posBase + 2 + 128));
  let numPatterns = 0;
  for (let i = 0; i < 128; i++) numPatterns = Math.max(numPatterns, orderTable[i] + 1);
  song.orders = orderTable.slice(0, songLen);
  song.restart = restart < songLen ? restart : 0;

  const isFLT8 = sig === 'FLT8';
  song.patterns = [];
  let off = headerEnd;
  const patBytes = 64 * channels * 4;
  for (let p = 0; p < numPatterns; p++) {
    const pat = createPattern(64, channels);
    for (let r = 0; r < 64; r++) {
      for (let c = 0; c < channels; c++) {
        let src;
        if (isFLT8) {
          // FLT8 stores 8 channels as two 4-channel patterns
          const half = c < 4 ? 0 : 1;
          src = off + half * 1024 + (r * 4 + (c & 3)) * 4;
        } else {
          src = off + (r * channels + c) * 4;
        }
        if (src + 4 > u8.length) continue;
        const b0 = u8[src], b1 = u8[src + 1], b2 = u8[src + 2], b3 = u8[src + 3];
        const inst = (b0 & 0xf0) | (b2 >> 4);
        const period = ((b0 & 15) << 8) | b1;
        let fx = b2 & 15;
        let param = b3;
        const d = (r * channels + c) * CELL;
        pat.data[d] = periodToNote(period);
        pat.data[d + 1] = inst <= numSamples ? inst : 0;
        // Arpeggio with 0 param is "no effect".
        if (fx === 0xc && param > 64) param = 64;
        if (fx === 0xe && (param >> 4) === 8) { fx = 8; param = (param & 15) * 17; } // E8x panning -> 8xx
        pat.data[d + 3] = fx;
        pat.data[d + 4] = param;
      }
    }
    song.patterns.push(pat);
    off += isFLT8 ? 2048 : patBytes;
  }
  if (isFLT8) {
    // FLT8 order entries count 4-channel patterns in steps of 2
    song.orders = song.orders.map((o) => o >> 1);
  }

  song.instruments = [];
  for (let i = 0; i < numSamples; i++) {
    const s = samples[i];
    const avail = Math.max(0, Math.min(s.length, u8.length - off));
    const data = new Float32Array(avail);
    for (let j = 0; j < avail; j++) {
      const v = u8[off + j];
      data[j] = (v < 128 ? v : v - 256) / 128;
    }
    off += s.length;
    let loopType = LOOP_NONE;
    let { loopStart, loopLength } = s;
    if (loopLength > 2 && loopStart < avail) {
      loopType = LOOP_FORWARD;
      if (loopStart + loopLength > avail) loopLength = avail - loopStart;
    } else {
      loopStart = 0;
      loopLength = 0;
    }
    const sample = createSample({ name: s.name, data, loopStart, loopLength, loopType, volume: s.volume, finetune: s.finetune, bits: 8 });
    song.instruments.push(instrumentFromSample(sample, s.name));
  }
  // Trim trailing empty instrument slots so the list is tidy (keep at least one).
  while (song.instruments.length > 1 && !song.instruments[song.instruments.length - 1].samples[0].data.length &&
         !song.instruments[song.instruments.length - 1].name) song.instruments.pop();
  return song;
}

// ---------------------------------------------------------------------------
// Writer

function resample(data, ratio) {
  // ratio > 1: output is shorter (data played faster in the source)
  const outLen = Math.max(1, Math.floor(data.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const p = i * ratio;
    const k = p | 0;
    const f = p - k;
    const a = data[k] ?? 0;
    const b = data[k + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

const PT_MIN = 36 + 1; // XM note of PT C-1
const PT_MAX = 71 + 1; // XM note of PT B-3

/**
 * Write a song as a ProTracker-compatible MOD.
 * Returns { data: Uint8Array, warnings: string[] }.
 */
export function saveMod(song) {
  const warnings = [];
  let channels = song.channels;
  if (channels % 2) { channels += 1; }
  if (channels > 32) { channels = 32; warnings.push('Only 32 channels can be stored in a MOD.'); }
  if (song.instruments.length > 31) warnings.push('MOD supports 31 instruments; the rest were dropped.');

  const usedNotes = Array.from({ length: 32 }, () => []);
  for (const p of song.patterns) {
    for (let i = 0; i < p.data.length; i += CELL) {
      const n = p.data[i], ins = p.data[i + 1];
      if (n && n !== NOTE_OFF && ins && ins <= 31) usedNotes[ins].push(n);
    }
  }

  // Convert each instrument to a single 8-bit sample (+ a per-instrument note transpose).
  const out = [];
  const transpose = new Int8Array(32);
  for (let i = 0; i < 31; i++) {
    const ins = song.instruments[i];
    const smp = ins?.samples[ins.sampleMap[48] ?? 0] ?? ins?.samples[0];
    if (!smp || !smp.data.length) { out.push(null); continue; }
    if (ins.samples.length > 1) warnings.push(`Instrument ${i + 1} has several samples; only one is kept.`);
    const shift = smp.relativeNote + smp.finetune / 128;
    const notes = usedNotes[i + 1];
    // Pick the octave transpose that keeps most notes inside the PT range,
    // preferring no resampling.
    let best = null;
    for (let k = -4; k <= 4; k++) {
      const t = 12 * k;
      const outside = notes.reduce((a, n) => a + (n + t < PT_MIN || n + t > PT_MAX ? 1 : 0), 0);
      const d = Math.abs(shift - t);
      const score = outside * 1000 + d;
      if (!best || score < best.score) best = { k, score };
    }
    const t = 12 * best.k;
    transpose[i + 1] = t;
    let d = shift - t; // remaining semitones to bake into the data
    let data = smp.data, loopStart = smp.loopStart, loopLength = smp.loopLength, finetune = 0;
    if (d >= -0.5 && d < 0.47) {
      finetune = Math.max(-8, Math.min(7, Math.round(d * 16)));
    } else {
      const ratio = Math.pow(2, d / 12);
      data = resample(data, ratio);
      loopStart = Math.floor(loopStart / ratio);
      loopLength = Math.floor(loopLength / ratio);
    }
    if (data.length > 131070) {
      warnings.push(`Sample ${i + 1} was truncated to 128 KB.`);
      data = data.subarray(0, 131070);
    }
    let len = data.length & ~1;
    if (smp.loopType === LOOP_NONE || loopLength < 2) { loopStart = 0; loopLength = 0; }
    else {
      loopStart &= ~1; loopLength &= ~1;
      if (loopStart + loopLength > len) loopLength = Math.max(0, (len - loopStart) & ~1);
      if (smp.loopType === 2) warnings.push(`Sample ${i + 1}: ping-pong loop changed to forward loop.`);
    }
    const s8 = new Int8Array(len);
    for (let j = 0; j < len; j++) s8[j] = Math.max(-128, Math.min(127, Math.round(data[j] * 128)));
    if (len >= 2 && !loopLength) { s8[0] = 0; s8[1] = 0; } // PT convention for one-shots
    out.push({ name: ins.name || smp.name, data: s8, volume: smp.volume, finetune, loopStart, loopLength });
  }

  // Patterns: MOD patterns are 64 rows.
  const numPatterns = Math.min(128, song.patterns.length);
  const orders = song.orders.slice(0, 128).map((o) => Math.min(o, numPatterns - 1));
  if (song.patterns.length > 128) warnings.push('MOD supports 128 patterns; the rest were dropped.');

  const sampleBytes = out.reduce((a, s) => a + (s ? s.data.length : 0), 0);
  const total = 1084 + numPatterns * 64 * channels * 4 + sampleBytes;
  const u8 = new Uint8Array(total);
  const dv = new DataView(u8.buffer);
  const putStr = (off, str, len) => { for (let i = 0; i < len; i++) u8[off + i] = i < str.length ? str.charCodeAt(i) & 0x7f : 0; };

  putStr(0, song.title || '', 20);
  for (let i = 0; i < 31; i++) {
    const o = 20 + i * 30;
    const s = out[i];
    if (!s) { dv.setUint16(o + 28, 1); continue; }
    putStr(o, s.name || '', 22);
    dv.setUint16(o + 22, s.data.length >> 1);
    u8[o + 24] = s.finetune & 15;
    u8[o + 25] = Math.min(64, s.volume);
    dv.setUint16(o + 26, s.loopStart >> 1);
    dv.setUint16(o + 28, s.loopLength ? s.loopLength >> 1 : 1);
  }
  u8[950] = orders.length;
  u8[951] = 127;
  orders.forEach((o, i) => { u8[952 + i] = o; });
  const sig = channels === 4 ? 'M.K.' : channels < 10 ? `${channels}CHN` : `${channels}CH`;
  putStr(1080, sig, 4);

  let lostFx = false, lostVol = false, rowsChanged = false;
  let off = 1084;
  for (let p = 0; p < numPatterns; p++) {
    const pat = song.patterns[p];
    if (pat.rows !== 64) rowsChanged = true;
    for (let r = 0; r < 64; r++) {
      for (let c = 0; c < channels; c++) {
        const o = off + (r * channels + c) * 4;
        if (r >= pat.rows || c >= song.channels) continue;
        const d = (r * song.channels + c) * CELL;
        let note = pat.data[d], ins = pat.data[d + 1], vol = pat.data[d + 2], fx = pat.data[d + 3], param = pat.data[d + 4];
        if (ins > 31) ins = 0;
        if (fx > 15) { if (fx || param) lostFx = true; fx = 0; param = 0; }
        if (fx === 8) { /* 8xx panning is kept */ }
        if (note === NOTE_OFF) { note = 0; if (!fx && !param) { fx = 0xc; param = 0; } }
        if (vol >= 0x10 && vol <= 0x50 && !fx && !param) { fx = 0xc; param = vol - 0x10; }
        else if (vol) lostVol = true;
        let period = 0;
        if (note) {
          const t = ins ? transpose[ins] : 0;
          let n = note + t;
          while (n < PT_MIN) n += 12;
          while (n > PT_MAX) n -= 12;
          period = noteToPeriod(n);
        }
        // Short pattern: terminate it with a pattern break on its last row
        if (pat.rows < 64 && r === pat.rows - 1 && c === 0 && !fx && !param) { fx = 0xd; param = 0; }
        u8[o] = (ins & 0xf0) | ((period >> 8) & 15);
        u8[o + 1] = period & 0xff;
        u8[o + 2] = ((ins & 15) << 4) | fx;
        u8[o + 3] = param;
      }
    }
    off += 64 * channels * 4;
  }
  for (const s of out) {
    if (!s) continue;
    u8.set(new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.length), off);
    off += s.data.length;
  }
  if (lostFx) warnings.push('XM-only effects (G-Z) were removed.');
  if (lostVol) warnings.push('Volume column commands other than "set volume" were removed.');
  if (rowsChanged) warnings.push('MOD patterns are always 64 rows; pattern lengths were adjusted.');
  if (song.instruments.some((i) => i.volEnv.on)) warnings.push('Instrument envelopes are not supported by MOD.');
  return { data: u8, warnings: [...new Set(warnings)] };
}
