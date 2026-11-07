// Internal song model. It is a superset that both MOD and XM map onto
// (and later S3M/STM/IT). Everything is plain data + typed arrays so it can
// be posted to the AudioWorklet with structured clone.
//
// Pattern cell = 5 bytes: note, instrument, volume column, effect, param
//   note: 0 = empty, 1..96 = C-0..B-7, 97 = key off
//   instrument: 0 = none, 1..128
//   volume column: 0 = empty, else XM volume-column byte (0x10..0xFF)
//   effect: 0..35 (0-9, A-Z), param 0..255. effect 0 + param 0 = nothing

export const CELL = 5;
export const NOTE_OFF = 97;
export const MAX_CHANNELS = 32;
export const MAX_INSTRUMENTS = 128;
export const MAX_PATTERNS = 256;

export const LOOP_NONE = 0;
export const LOOP_FORWARD = 1;
export const LOOP_PINGPONG = 2;

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

export function noteName(n) {
  if (!n) return '---';
  if (n === NOTE_OFF) return '===';
  const i = n - 1;
  return NOTE_NAMES[i % 12] + Math.floor(i / 12);
}

export const FX_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function createPattern(rows = 64, channels = 8) {
  return { rows, data: new Uint8Array(rows * channels * CELL) };
}

export function createSample(props = {}) {
  return {
    name: '',
    data: new Float32Array(0),
    loopStart: 0,
    loopLength: 0,
    loopType: LOOP_NONE,
    volume: 64,
    finetune: 0, // -128..127 (1/128 semitone)
    panning: 128,
    relativeNote: 0,
    bits: 16,
    ...props,
  };
}

export function createEnvelope(points = [[0, 64]]) {
  return { points, on: false, sustain: false, sustainPoint: 0, loop: false, loopStart: 0, loopEnd: 0 };
}

export function createInstrument(props = {}) {
  return {
    name: '',
    samples: [],
    sampleMap: new Uint8Array(96), // note -> sample index
    volEnv: createEnvelope([[0, 64]]),
    panEnv: createEnvelope([[0, 32]]),
    fadeout: 0,
    vibType: 0,
    vibSweep: 0,
    vibDepth: 0,
    vibRate: 0,
    ...props,
  };
}

export function createSong(channels = 8) {
  return {
    title: 'untitled',
    format: 'xm',
    channels,
    linear: true,
    restart: 0,
    speed: 6,
    bpm: 125,
    globalVolume: 64,
    orders: [0],
    patterns: [createPattern(64, channels)],
    instruments: [],
    channelPan: null, // optional initial panning per channel (MOD uses LRRL)
  };
}

export function getCell(song, pat, row, ch) {
  const p = song.patterns[pat];
  const o = (row * song.channels + ch) * CELL;
  const d = p.data;
  return { note: d[o], inst: d[o + 1], vol: d[o + 2], fx: d[o + 3], param: d[o + 4] };
}

export function setCell(song, pat, row, ch, cell) {
  const p = song.patterns[pat];
  const o = (row * song.channels + ch) * CELL;
  const d = p.data;
  if (cell.note !== undefined) d[o] = cell.note;
  if (cell.inst !== undefined) d[o + 1] = cell.inst;
  if (cell.vol !== undefined) d[o + 2] = cell.vol;
  if (cell.fx !== undefined) d[o + 3] = cell.fx;
  if (cell.param !== undefined) d[o + 4] = cell.param;
}

/** Ensure a pattern index exists (creating empty patterns up to it). */
export function ensurePattern(song, idx) {
  while (song.patterns.length <= idx) song.patterns.push(createPattern(64, song.channels));
  return song.patterns[idx];
}

export function resizePattern(song, idx, rows) {
  const p = song.patterns[idx];
  const n = new Uint8Array(rows * song.channels * CELL);
  n.set(p.data.subarray(0, Math.min(p.data.length, n.length)));
  song.patterns[idx] = { rows, data: n };
}

/** Change the number of channels for all patterns. */
export function setChannelCount(song, channels) {
  const old = song.channels;
  if (channels === old) return;
  for (let i = 0; i < song.patterns.length; i++) {
    const p = song.patterns[i];
    const n = new Uint8Array(p.rows * channels * CELL);
    const keep = Math.min(old, channels) * CELL;
    for (let r = 0; r < p.rows; r++) {
      n.set(p.data.subarray(r * old * CELL, r * old * CELL + keep), r * channels * CELL);
    }
    song.patterns[i] = { rows: p.rows, data: n };
  }
  song.channels = channels;
  if (song.channelPan) {
    const cp = [];
    for (let c = 0; c < channels; c++) cp.push(song.channelPan[c] ?? (((c & 3) === 0 || (c & 3) === 3) ? 64 : 192));
    song.channelPan = cp;
  }
}

/** Instrument that holds exactly one sample mapped to all notes (MOD style). */
export function instrumentFromSample(sample, name = sample.name) {
  return createInstrument({ name, samples: [sample] });
}

/** Number of semitones + finetune needed so a sample at `rate` Hz plays at its own pitch on C-4. */
export function tuningForRate(rate) {
  const semis = 12 * Math.log2(rate / 8363);
  let rel = Math.floor(semis);
  let fine = Math.round((semis - rel) * 128);
  if (fine > 127) { rel += 1; fine -= 128; }
  return { relativeNote: rel, finetune: fine };
}

export function cloneSong(song) {
  return structuredClone(song);
}
