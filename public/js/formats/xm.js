// FastTracker 2 .XM loader and writer.
import {
  CELL, createSong, createPattern, createSample, createInstrument, createEnvelope,
  LOOP_NONE, LOOP_FORWARD, LOOP_PINGPONG,
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

export function isXm(u8) {
  return u8.length > 60 && ascii(u8, 0, 17) === 'Extended Module:';
}

function readEnvelope(u8, dv, off, count, sus, ls, le, type) {
  const points = [];
  for (let i = 0; i < Math.min(12, count); i++) {
    points.push([dv.getUint16(off + i * 4, true), dv.getUint16(off + i * 4 + 2, true)]);
  }
  const env = createEnvelope(points.length ? points : [[0, 64]]);
  env.on = !!(type & 1) && points.length > 0;
  env.sustain = !!(type & 2);
  env.loop = !!(type & 4);
  env.sustainPoint = sus;
  env.loopStart = ls;
  env.loopEnd = le;
  return env;
}

export function loadXm(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (!isXm(u8)) throw new Error('Not an XM file');

  const headerSize = dv.getUint32(60, true);
  const songLen = dv.getUint16(64, true);
  const restart = dv.getUint16(66, true);
  const channels = dv.getUint16(68, true);
  const numPatterns = dv.getUint16(70, true);
  const numInstruments = dv.getUint16(72, true);
  const flags = dv.getUint16(74, true);

  const song = createSong(Math.max(1, Math.min(32, channels)));
  song.format = 'xm';
  song.title = ascii(u8, 17, 20) || 'untitled';
  song.linear = !!(flags & 1);
  song.speed = dv.getUint16(76, true) || 6;
  song.bpm = dv.getUint16(78, true) || 125;
  song.orders = Array.from(u8.subarray(80, 80 + Math.max(1, Math.min(256, songLen))));
  song.restart = restart < song.orders.length ? restart : 0;
  const realChannels = channels;

  let off = 60 + headerSize;
  song.patterns = [];
  for (let p = 0; p < numPatterns; p++) {
    const phLen = dv.getUint32(off, true);
    const rows = dv.getUint16(off + 5, true) || 64;
    const packed = dv.getUint16(off + 7, true);
    off += phLen;
    const pat = createPattern(rows, song.channels);
    let i = off;
    const end = off + packed;
    for (let r = 0; r < rows && packed; r++) {
      for (let c = 0; c < realChannels; c++) {
        if (i >= end) break;
        let note = 0, ins = 0, vol = 0, fx = 0, param = 0;
        const b = u8[i++];
        if (b & 0x80) {
          if (b & 1) note = u8[i++];
          if (b & 2) ins = u8[i++];
          if (b & 4) vol = u8[i++];
          if (b & 8) fx = u8[i++];
          if (b & 16) param = u8[i++];
        } else {
          note = b; ins = u8[i++]; vol = u8[i++]; fx = u8[i++]; param = u8[i++];
        }
        if (c >= song.channels) continue;
        const d = (r * song.channels + c) * CELL;
        pat.data[d] = note > 97 ? 0 : note;
        pat.data[d + 1] = ins;
        pat.data[d + 2] = vol < 0x10 ? 0 : vol;
        pat.data[d + 3] = fx > 35 ? 0 : fx;
        pat.data[d + 4] = param;
      }
    }
    off += packed;
    song.patterns.push(pat);
  }
  if (!song.patterns.length) song.patterns.push(createPattern(64, song.channels));
  // Order entries pointing past the last pattern get an empty pattern.
  const maxOrd = Math.max(...song.orders);
  while (song.patterns.length <= maxOrd) song.patterns.push(createPattern(64, song.channels));

  song.instruments = [];
  for (let n = 0; n < numInstruments && off + 29 <= u8.length; n++) {
    const start = off;
    const ihSize = dv.getUint32(off, true);
    const name = ascii(u8, off + 4, 22);
    const numSamples = dv.getUint16(off + 27, true);
    const ins = createInstrument({ name });
    let sampleHeaderSize = 40;
    if (numSamples > 0) {
      sampleHeaderSize = dv.getUint32(off + 29, true) || 40;
      ins.sampleMap = new Uint8Array(u8.subarray(off + 33, off + 33 + 96));
      ins.volEnv = readEnvelope(u8, dv, off + 129, u8[off + 225], u8[off + 227], u8[off + 228], u8[off + 229], u8[off + 233]);
      ins.panEnv = readEnvelope(u8, dv, off + 177, u8[off + 226], u8[off + 230], u8[off + 231], u8[off + 232], u8[off + 234]);
      ins.vibType = u8[off + 235];
      ins.vibSweep = u8[off + 236];
      ins.vibDepth = u8[off + 237];
      ins.vibRate = u8[off + 238];
      ins.fadeout = dv.getUint16(off + 239, true);
    }
    off = start + ihSize;
    const headers = [];
    for (let s = 0; s < numSamples; s++) {
      const h = off;
      const type = u8[h + 14];
      headers.push({
        length: dv.getUint32(h, true),
        loopStart: dv.getUint32(h + 4, true),
        loopLength: dv.getUint32(h + 8, true),
        volume: Math.min(64, u8[h + 12]),
        finetune: dv.getInt8(h + 13),
        loopType: type & 3,
        is16: !!(type & 16),
        panning: u8[h + 15],
        relativeNote: dv.getInt8(h + 16),
        name: ascii(u8, h + 18, 22),
      });
      off += sampleHeaderSize;
    }
    for (const h of headers) {
      const bytes = Math.min(h.length, Math.max(0, u8.length - off));
      let data;
      if (h.is16) {
        const n16 = bytes >> 1;
        data = new Float32Array(n16);
        let acc = 0;
        for (let j = 0; j < n16; j++) {
          acc = (acc + dv.getInt16(off + j * 2, true)) << 16 >> 16;
          data[j] = acc / 32768;
        }
      } else {
        data = new Float32Array(bytes);
        let acc = 0;
        for (let j = 0; j < bytes; j++) {
          acc = (acc + u8[off + j]) << 24 >> 24;
          data[j] = acc / 128;
        }
      }
      off += h.length;
      const div = h.is16 ? 2 : 1;
      let loopStart = Math.floor(h.loopStart / div);
      let loopLength = Math.floor(h.loopLength / div);
      let loopType = h.loopType === 3 ? LOOP_PINGPONG : h.loopType;
      if (loopType !== LOOP_NONE) {
        if (loopStart >= data.length || loopLength < 1) { loopType = LOOP_NONE; loopStart = 0; loopLength = 0; }
        else if (loopStart + loopLength > data.length) loopLength = data.length - loopStart;
      }
      ins.samples.push(createSample({
        name: h.name, data, loopStart, loopLength, loopType,
        volume: h.volume, finetune: h.finetune, panning: h.panning, relativeNote: h.relativeNote,
        bits: h.is16 ? 16 : 8,
      }));
    }
    song.instruments.push(ins);
  }
  return song;
}

// ---------------------------------------------------------------------------
// Writer

class Writer {
  constructor(size = 1 << 20) { this.buf = new Uint8Array(size); this.dv = new DataView(this.buf.buffer); this.pos = 0; }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf);
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  u8(v) { this.ensure(1); this.buf[this.pos++] = v & 0xff; }
  u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  str(s, len, pad = 0) { this.ensure(len); for (let i = 0; i < len; i++) this.buf[this.pos++] = i < s.length ? s.charCodeAt(i) & 0x7f : pad; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  skip(n) { this.ensure(n); this.pos += n; }
  result() { return this.buf.slice(0, this.pos); }
}

function writeEnvelope(w, env) {
  for (let i = 0; i < 12; i++) {
    const p = env.points[i];
    w.u16(p ? p[0] : 0);
    w.u16(p ? p[1] : 0);
  }
}
const envType = (e) => (e.on ? 1 : 0) | (e.sustain ? 2 : 0) | (e.loop ? 4 : 0);

export function saveXm(song) {
  const warnings = [];
  const w = new Writer();
  w.str('Extended Module: ', 17);
  w.str(song.title || '', 20);
  w.u8(0x1a);
  w.str('DiscoTracker', 20);
  w.u16(0x0104);
  w.u32(276);
  const orders = song.orders.slice(0, 256);
  w.u16(orders.length);
  w.u16(song.restart || 0);
  w.u16(song.channels);
  w.u16(song.patterns.length);
  w.u16(Math.min(128, song.instruments.length));
  w.u16(song.linear ? 1 : 0);
  w.u16(song.speed);
  w.u16(song.bpm);
  for (let i = 0; i < 256; i++) w.u8(orders[i] ?? 0);

  for (const pat of song.patterns) {
    const packed = new Writer(pat.rows * song.channels * 5 + 16);
    let empty = true;
    for (let i = 0; i < pat.data.length; i += CELL) {
      const note = pat.data[i], ins = pat.data[i + 1], vol = pat.data[i + 2], fx = pat.data[i + 3], param = pat.data[i + 4];
      if (note || ins || vol || fx || param) empty = false;
      let mask = 0x80;
      if (note) mask |= 1;
      if (ins) mask |= 2;
      if (vol) mask |= 4;
      if (fx) mask |= 8;
      if (param) mask |= 16;
      if (mask === 0x9f) { packed.u8(note); packed.u8(ins); packed.u8(vol); packed.u8(fx); packed.u8(param); continue; }
      packed.u8(mask);
      if (note) packed.u8(note);
      if (ins) packed.u8(ins);
      if (vol) packed.u8(vol);
      if (fx) packed.u8(fx);
      if (param) packed.u8(param);
    }
    const data = empty ? new Uint8Array(0) : packed.result();
    w.u32(9);
    w.u8(0);
    w.u16(pat.rows);
    w.u16(data.length);
    w.bytes(data);
  }

  if (song.instruments.length > 128) warnings.push('XM supports 128 instruments; the rest were dropped.');
  for (const ins of song.instruments.slice(0, 128)) {
    const samples = ins.samples.slice(0, 16);
    const start = w.pos;
    const size = samples.length ? 263 : 29;
    w.u32(size);
    w.str(ins.name || '', 22);
    w.u8(0);
    w.u16(samples.length);
    if (samples.length) {
      w.u32(40);
      w.bytes(ins.sampleMap.map((v) => (v < samples.length ? v : 0)));
      writeEnvelope(w, ins.volEnv);
      writeEnvelope(w, ins.panEnv);
      w.u8(Math.min(12, ins.volEnv.points.length));
      w.u8(Math.min(12, ins.panEnv.points.length));
      w.u8(ins.volEnv.sustainPoint); w.u8(ins.volEnv.loopStart); w.u8(ins.volEnv.loopEnd);
      w.u8(ins.panEnv.sustainPoint); w.u8(ins.panEnv.loopStart); w.u8(ins.panEnv.loopEnd);
      w.u8(envType(ins.volEnv)); w.u8(envType(ins.panEnv));
      w.u8(ins.vibType); w.u8(ins.vibSweep); w.u8(ins.vibDepth); w.u8(ins.vibRate);
      w.u16(ins.fadeout);
      w.u16(0);
    }
    w.skip(start + size - w.pos);

    const encoded = samples.map((s) => {
      const is16 = s.bits !== 8;
      const n = s.data.length;
      const out = new Uint8Array(is16 ? n * 2 : n);
      const odv = new DataView(out.buffer);
      let prev = 0;
      for (let j = 0; j < n; j++) {
        if (is16) {
          const v = Math.max(-32768, Math.min(32767, Math.round(s.data[j] * 32768)));
          odv.setInt16(j * 2, (v - prev) << 16 >> 16, true);
          prev = v;
        } else {
          const v = Math.max(-128, Math.min(127, Math.round(s.data[j] * 128)));
          out[j] = (v - prev) & 0xff;
          prev = v;
        }
      }
      return { s, is16, out };
    });
    for (const { s, is16, out } of encoded) {
      const m = is16 ? 2 : 1;
      const hasLoop = s.loopType !== LOOP_NONE && s.loopLength > 0;
      w.u32(out.length);
      w.u32(hasLoop ? s.loopStart * m : 0);
      w.u32(hasLoop ? s.loopLength * m : 0);
      w.u8(s.volume);
      w.u8(s.finetune & 0xff);
      w.u8((hasLoop ? s.loopType : 0) | (is16 ? 16 : 0));
      w.u8(s.panning);
      w.u8(s.relativeNote & 0xff);
      w.u8(0);
      w.str(s.name || '', 22);
    }
    for (const { out } of encoded) w.bytes(out);
  }
  if (song.instruments.some((i) => i.samples.length > 16)) warnings.push('XM instruments can hold 16 samples; extra samples were dropped.');
  return { data: w.result(), warnings };
}
