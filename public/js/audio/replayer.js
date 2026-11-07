// Tick based module replayer + software mixer.
// Effect semantics follow FastTracker 2 (XM) with ProTracker quirks for MOD.
// No DOM / WebAudio dependencies: runs inside the AudioWorklet and in Node.

const CELL = 5;
const NOTE_OFF = 97;

// ProTracker vibrato sine table (half period)
const SINE = [0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24];

function waveValue(wave, pos) {
  const p = pos & 63;
  switch (wave & 3) {
    case 0: return p < 32 ? SINE[p] : -SINE[p & 31];
    case 1: return 255 - p * 8; // ramp down
    case 2: return p < 32 ? 255 : -255; // square
    default: return ((Math.random() * 511) | 0) - 255;
  }
}

function autoVibValue(type, pos) {
  const p = pos & 255;
  switch (type & 3) {
    case 0: return Math.round(64 * Math.sin((p / 256) * 2 * Math.PI));
    case 1: return p < 128 ? 64 : -64;
    case 2: return 64 - (p >> 1);
    default: return (p >> 1) - 64;
  }
}

const RETRIG_VOL = [
  (v) => v, (v) => v - 1, (v) => v - 2, (v) => v - 4, (v) => v - 8, (v) => v - 16, (v) => (v * 2) / 3, (v) => v / 2,
  (v) => v, (v) => v + 1, (v) => v + 2, (v) => v + 4, (v) => v + 8, (v) => v + 16, (v) => (v * 3) / 2, (v) => v * 2,
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function envelopeValue(env, pos) {
  const pts = env.points;
  if (!pts.length) return 64;
  if (pos <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (pos < x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (pos - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}

function advanceEnvelope(env, pos, keyOn) {
  const pts = env.points;
  if (!pts.length) return pos;
  if (env.sustain && keyOn && pts[env.sustainPoint] && pos === pts[env.sustainPoint][0]) return pos;
  pos++;
  if (env.loop && pts[env.loopEnd] && pts[env.loopStart] && pos >= pts[env.loopEnd][0]) {
    // While a sustain point inside the loop holds, FT2 still loops (if key is off it always loops)
    pos = pts[env.loopStart][0];
  }
  const last = pts[pts.length - 1][0];
  return pos > last ? last : pos;
}

function newChannel(index) {
  return {
    index,
    ins: null, insNum: 0, sample: null,
    active: false, pos: 0, dir: 1, step: 0,
    note: 0, realNote: 0, finetune: 0,
    period: 0, outPeriod: 0, target: 0,
    vol: 0, outVol: 0, pan: 128, defaultPan: 128,
    keyOn: false, fadeout: 32768, volEnvPos: 0, panEnvPos: 0,
    autoVibPos: 0, autoVibAmp: 0,
    // memories
    portaUp: 0, portaDown: 0, finePortaUp: 0, finePortaDown: 0, xFineUp: 0, xFineDown: 0,
    toneSpeed: 0, vibSpeed: 0, vibDepth: 0, vibPos: 0, vibWave: 0,
    tremSpeed: 0, tremDepth: 0, tremPos: 0, tremWave: 0,
    volSlide: 0, fineVolUp: 0, fineVolDown: 0, globalSlide: 0, panSlide: 0, offset: 0,
    retrigVol: 0, retrigSpeed: 0, retrigCount: 0, tremor: 0, tremorCount: 0, tremorOn: true,
    loopRow: 0, loopCount: 0,
    // current row
    fx: 0, param: 0, volCol: 0, delayCell: null, delayTick: -1, cutTick: -1, keyOffTick: -1,
    // mixer
    curL: 0, curR: 0, tgtL: 0, tgtR: 0, muted: false, peak: 0,
  };
}

export class Replayer {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.song = null;
    this.channels = [];
    this.ghosts = [];
    this.playing = false;
    this.mode = 'song';
    this.order = 0;
    this.row = 0;
    this.patternIndex = 0;
    this.tick = 0;
    this.speed = 6;
    this.bpm = 125;
    this.globalVol = 64;
    this.samplesToTick = 0;
    this.patDelay = 0;
    this.patDelayActive = false;
    this.jumpFlag = false;
    this.jumpOrder = 0;
    this.breakRow = 0;
    this.loopJump = -1;
    this.masterVolume = 0.8;
    this.rowEvent = null; // {order, pattern, row} set when a new row starts
    this.smooth = 1 - Math.exp(-1 / (0.0012 * sampleRate));
    this.ghostDecay = Math.exp(-1 / (0.0015 * sampleRate));
    this.songEnded = false;
  }

  setSong(song) {
    this.song = song;
    this.stop();
    this.channels = [];
    for (let i = 0; i < song.channels; i++) this.channels.push(newChannel(i));
    this.resetChannels();
    this.speed = song.speed;
    this.bpm = song.bpm;
  }

  setChannelCount(n) {
    this.song.channels = n;
    while (this.channels.length < n) {
      const c = newChannel(this.channels.length);
      c.pan = c.defaultPan = this.song.channelPan?.[c.index] ?? 128;
      this.channels.push(c);
    }
    this.channels.length = n;
  }

  resetChannels() {
    const song = this.song;
    for (const c of this.channels) {
      const muted = c.muted;
      Object.assign(c, newChannel(c.index));
      c.muted = muted;
      c.pan = c.defaultPan = song.channelPan?.[c.index] ?? 128;
    }
  }

  get isMod() { return this.song?.format === 'mod'; }

  // ---------------------------------------------------------------------
  // Transport

  play(mode = 'song', order = 0, row = 0, pattern = null) {
    if (!this.song) return;
    this.killVoices();
    this.resetChannels();
    this.mode = mode;
    this.order = clamp(order, 0, this.song.orders.length - 1);
    this.patternIndex = pattern ?? this.song.orders[this.order] ?? 0;
    this.row = row;
    this.tick = 0;
    this.speed = this.song.speed;
    this.bpm = this.song.bpm;
    this.globalVol = this.song.globalVolume ?? 64;
    this.patDelay = 0;
    this.patDelayActive = false;
    this.jumpFlag = false;
    this.loopJump = -1;
    this.samplesToTick = 0;
    this.songEnded = false;
    this.playing = true;
  }

  stop() {
    this.playing = false;
    this.killVoices();
  }

  killVoices() {
    for (const c of this.channels) {
      this.fadeOutVoice(c);
      c.active = false;
      c.keyOn = false;
    }
  }

  currentPattern() {
    const idx = this.mode === 'pattern' ? this.patternIndex : this.song.orders[this.order];
    return { idx, pat: this.song.patterns[idx] };
  }

  // ---------------------------------------------------------------------
  // Periods / frequencies

  periodOf(realNote, finetune) {
    if (this.song.linear) return 7680 - realNote * 64 - finetune / 2;
    return 1712 * Math.pow(2, -(realNote - 48 + finetune / 128) / 12);
  }

  freqOf(period) {
    if (period < 1) period = 1;
    if (this.song.linear) return 8363 * Math.pow(2, (4608 - period) / 768);
    return (8363 * 1712) / period;
  }

  clampPeriod(p) {
    return this.song.linear ? clamp(p, 1, 7680 + 64 * 16) : clamp(p, 28, 32000);
  }

  // ---------------------------------------------------------------------
  // Notes

  sampleFor(ins, note) {
    if (!ins || !ins.samples.length) return null;
    const s = ins.samples[ins.sampleMap[clamp(note - 1, 0, 95)]] ?? ins.samples[0];
    return s && s.data.length ? s : null;
  }

  fadeOutVoice(c) {
    if (!c.active || !c.sample || (c.curL < 1e-4 && c.curR < 1e-4)) return;
    if (this.ghosts.length > 64) this.ghosts.shift();
    const s = c.sample;
    this.ghosts.push({ sample: s, pos: c.pos, dir: c.dir, step: c.step, gL: c.curL, gR: c.curR });
  }

  triggerNote(c, note, offset = 0) {
    const s = this.sampleFor(c.ins, note);
    this.fadeOutVoice(c);
    c.curL = c.curR = 0;
    if (!s) { c.active = false; c.sample = null; return; }
    c.sample = s;
    c.note = note;
    c.realNote = clamp(note - 1 + s.relativeNote, 0, 118);
    c.finetune = s.finetune;
    c.period = c.outPeriod = this.periodOf(c.realNote, c.finetune);
    c.pos = offset;
    c.dir = 1;
    c.active = true;
    if (offset >= s.data.length) {
      if (s.loopType && s.loopLength > 0) c.pos = s.loopStart; else c.active = false;
    }
    if (c.vibWave < 4) c.vibPos = 0;
    if (c.tremWave < 4) c.tremPos = 0;
    c.retrigCount = 0;
    c.tremorCount = 0;
    c.tremorOn = true;
  }

  resetInstrumentState(c) {
    const s = c.sample ?? this.sampleFor(c.ins, c.note || 49);
    if (s) {
      c.vol = s.volume;
      if (!this.isMod) c.pan = s.panning;
    }
    c.keyOn = true;
    c.fadeout = 32768;
    c.volEnvPos = 0;
    c.panEnvPos = 0;
    c.autoVibPos = 0;
    c.autoVibAmp = 0;
  }

  keyOff(c) {
    c.keyOn = false;
    if (!c.ins || !c.ins.volEnv.on) c.vol = 0;
  }

  /** Process a pattern cell (tick 0 or delayed tick). */
  triggerCell(c, note, insNum, vol, fx, param) {
    const isPorta = fx === 3 || fx === 5 || (vol >> 4) === 0xf;
    if (insNum) {
      const ins = this.song.instruments[insNum - 1] || null;
      c.insNum = insNum;
      if (ins !== c.ins && !isPorta) c.ins = ins;
      else if (!c.ins) c.ins = ins;
    }
    if (note === NOTE_OFF) {
      this.keyOff(c);
    } else if (note) {
      if (isPorta && c.active && c.sample) {
        const real = clamp(note - 1 + c.sample.relativeNote, 0, 118);
        c.target = this.periodOf(real, c.finetune);
        c.note = note;
      } else {
        let offset = 0;
        if (fx === 9) {
          if (param) c.offset = param;
          offset = c.offset * 256;
        }
        this.triggerNote(c, note, offset);
        if (fx === 0xe && (param >> 4) === 5) {
          c.finetune = this.isMod ? (((param & 15) ^ 8) - 8) * 16 : (param & 15) * 16 - 128;
          c.period = c.outPeriod = this.periodOf(c.realNote, c.finetune);
        }
      }
    }
    if (insNum && note !== NOTE_OFF) this.resetInstrumentState(c);
  }

  // ---------------------------------------------------------------------
  // Row / tick processing

  processRow() {
    const song = this.song;
    const { idx, pat } = this.currentPattern();
    const n = song.channels;
    this.rowEvent = { order: this.order, pattern: idx, row: this.row };
    for (let ch = 0; ch < n; ch++) {
      const c = this.channels[ch];
      let note = 0, ins = 0, vol = 0, fx = 0, param = 0;
      if (pat && this.row < pat.rows) {
        const o = (this.row * n + ch) * CELL;
        const d = pat.data;
        note = d[o]; ins = d[o + 1]; vol = d[o + 2]; fx = d[o + 3]; param = d[o + 4];
      }
      c.fx = fx; c.param = param; c.volCol = vol;
      c.cutTick = -1; c.keyOffTick = -1; c.delayTick = -1;
      c.outPeriod = c.period;
      c.outVol = c.vol;
      if (fx === 0xe && (param >> 4) === 0xd && (param & 15)) {
        c.delayTick = param & 15;
        c.delayCell = [note, ins, vol, fx, param];
        continue;
      }
      if (this.patDelayActive) {
        // repeated row of a pattern delay: notes are not retriggered
      } else {
        this.triggerCell(c, note, ins, vol, fx, param);
      }
      this.tickZeroEffects(c, vol, fx, param);
    }
  }

  tickZeroEffects(c, vol, fx, param) {
    const hi = vol >> 4, lo = vol & 15;
    switch (hi) {
      case 1: case 2: case 3: case 4: c.vol = Math.min(64, vol - 0x10); break;
      case 5: if (vol <= 0x50) c.vol = 64; break;
      case 8: c.vol = Math.max(0, c.vol - lo); break;
      case 9: c.vol = Math.min(64, c.vol + lo); break;
      case 0xa: c.vibSpeed = lo * 4; break;
      case 0xb: if (lo) c.vibDepth = lo; break;
      case 0xc: c.pan = lo * 17; break;
      case 0xf: if (lo) c.toneSpeed = lo * 16; break;
    }
    const x = param >> 4, y = param & 15;
    const xm = !this.isMod;
    switch (fx) {
      case 1: if (param) c.portaUp = param; break;
      case 2: if (param) c.portaDown = param; break;
      case 3: if (param) c.toneSpeed = param; break;
      case 4: if (x) c.vibSpeed = x * 4; if (y) c.vibDepth = y; break;
      case 5: case 6: case 0xa: if (param || !xm) c.volSlide = param; break;
      case 7: if (x) c.tremSpeed = x * 4; if (y) c.tremDepth = y; break;
      case 8: c.pan = param; break;
      case 0xb:
        if (this.mode === 'song') {
          this.jumpOrder = param;
          if (!this.jumpFlag) this.breakRow = 0;
          this.jumpFlag = true;
        }
        break;
      case 0xc: c.vol = Math.min(64, param); break;
      case 0xd: {
        const r = x * 10 + y;
        this.breakRow = r > 255 ? 0 : r;
        if (!this.jumpFlag) this.jumpOrder = this.order + 1;
        this.jumpFlag = true;
        break;
      }
      case 0xe:
        switch (x) {
          case 1: if (y || !xm) c.finePortaUp = y; c.period = this.clampPeriod(c.period - c.finePortaUp * 4); break;
          case 2: if (y || !xm) c.finePortaDown = y; c.period = this.clampPeriod(c.period + c.finePortaDown * 4); break;
          case 4: c.vibWave = y; break;
          case 6:
            if (!y) c.loopRow = this.row;
            else if (!c.loopCount) { c.loopCount = y; this.loopJump = c.loopRow; }
            else if (--c.loopCount) this.loopJump = c.loopRow;
            break;
          case 7: c.tremWave = y; break;
          case 8: c.pan = y * 17; break;
          case 9: c.retrigSpeed = y; break;
          case 0xa: if (y || !xm) c.fineVolUp = y; c.vol = Math.min(64, c.vol + c.fineVolUp); break;
          case 0xb: if (y || !xm) c.fineVolDown = y; c.vol = Math.max(0, c.vol - c.fineVolDown); break;
          case 0xc: c.cutTick = y; if (!y) c.vol = 0; break;
          case 0xe: if (!this.patDelayActive && !this.patDelay) this.patDelay = y; break;
        }
        break;
      case 0xf:
        if (param) {
          if (param < 32) this.speed = param;
          else this.bpm = param;
        }
        break;
      case 16: this.globalVol = Math.min(64, param); break; // G
      case 17: if (param) c.globalSlide = param; break; // H
      case 20: if (param) c.keyOffTick = param; else this.keyOff(c); break; // K
      case 21: c.volEnvPos = param; c.panEnvPos = param; break; // L
      case 25: if (param) c.panSlide = param; break; // P
      case 27: // R
        if (x) c.retrigVol = x;
        if (y) c.retrigSpeed = y;
        break;
      case 29: if (param) c.tremor = param; break; // T
      case 33: // X
        if (x === 1) { if (y) c.xFineUp = y; c.period = this.clampPeriod(c.period - c.xFineUp); }
        else if (x === 2) { if (y) c.xFineDown = y; c.period = this.clampPeriod(c.period + c.xFineDown); }
        break;
    }
    c.outPeriod = c.period;
    c.outVol = c.vol;
    if (fx === 0 && param) this.arpeggio(c, param);
    if (fx === 27) this.multiRetrig(c);
  }

  volumeSlide(c, p) {
    const x = p >> 4, y = p & 15;
    if (x) c.vol = Math.min(64, c.vol + x);
    else if (y) c.vol = Math.max(0, c.vol - y);
  }

  tonePorta(c) {
    if (!c.target || !c.toneSpeed) return;
    const sp = c.toneSpeed * 4;
    if (c.period < c.target) c.period = Math.min(c.target, c.period + sp);
    else if (c.period > c.target) c.period = Math.max(c.target, c.period - sp);
  }

  vibrato(c) {
    const delta = (waveValue(c.vibWave, c.vibPos) * c.vibDepth) >> 5;
    c.outPeriod = c.period + delta;
    c.vibPos = (c.vibPos + (c.vibSpeed >> 2)) & 63;
  }

  arpeggio(c, p) {
    const t = this.tick % 3;
    if (!t || !c.sample) return;
    const add = t === 1 ? p >> 4 : p & 15;
    c.outPeriod = this.periodOf(clamp(c.realNote + add, 0, 118), c.finetune) + (c.period - this.periodOf(c.realNote, c.finetune));
  }

  multiRetrig(c) {
    c.retrigCount++;
    if (c.retrigSpeed && c.retrigCount >= c.retrigSpeed) {
      c.retrigCount = 0;
      c.vol = clamp(Math.round(RETRIG_VOL[c.retrigVol & 15](c.vol)), 0, 64);
      c.outVol = c.vol;
      this.retrigger(c);
    }
  }

  retrigger(c) {
    if (!c.sample) return;
    this.fadeOutVoice(c);
    c.curL = c.curR = 0;
    c.pos = 0;
    c.dir = 1;
    c.active = true;
  }

  tickEffects(c) {
    const vol = c.volCol, hi = vol >> 4, lo = vol & 15;
    const fx = c.fx, param = c.param, x = param >> 4, y = param & 15;
    c.outPeriod = c.period;

    if (c.delayTick === this.tick && c.delayCell) {
      const [n, i, v, f, p] = c.delayCell;
      this.triggerCell(c, n, i, v, f, p);
      this.tickZeroEffects(c, v, 0, 0);
      c.delayCell = null;
    }

    switch (hi) {
      case 6: c.vol = Math.max(0, c.vol - lo); break;
      case 7: c.vol = Math.min(64, c.vol + lo); break;
      case 0xb: this.vibrato(c); break;
      case 0xd: c.pan = Math.max(0, c.pan - lo); break;
      case 0xe: c.pan = Math.min(255, c.pan + lo); break;
      case 0xf: this.tonePorta(c); c.outPeriod = c.period; break;
    }

    switch (fx) {
      case 0: if (param) this.arpeggio(c, param); break;
      case 1: c.period = this.clampPeriod(c.period - (this.isMod ? param : c.portaUp) * 4); c.outPeriod = c.period; break;
      case 2: c.period = this.clampPeriod(c.period + (this.isMod ? param : c.portaDown) * 4); c.outPeriod = c.period; break;
      case 3: this.tonePorta(c); c.outPeriod = c.period; break;
      case 4: this.vibrato(c); break;
      case 5: this.tonePorta(c); c.outPeriod = c.period; this.volumeSlide(c, c.volSlide); break;
      case 6: this.vibrato(c); this.volumeSlide(c, c.volSlide); break;
      case 7: break; // handled in output stage
      case 0xa: this.volumeSlide(c, c.volSlide); break;
      case 0xe:
        if (x === 9 && y && this.tick % y === 0) this.retrigger(c);
        if (x === 0xc && this.tick === y) c.vol = 0;
        break;
      case 17: { // H global volume slide
        const gx = c.globalSlide >> 4, gy = c.globalSlide & 15;
        if (gx) this.globalVol = Math.min(64, this.globalVol + gx);
        else if (gy) this.globalVol = Math.max(0, this.globalVol - gy);
        break;
      }
      case 20: if (this.tick === c.keyOffTick) this.keyOff(c); break;
      case 25: { // P
        const px = c.panSlide >> 4, py = c.panSlide & 15;
        if (px) c.pan = Math.min(255, c.pan + px);
        else if (py) c.pan = Math.max(0, c.pan - py);
        break;
      }
      case 27: this.multiRetrig(c); break;
    }
    c.outVol = c.vol;
  }

  updateOutput(c) {
    if (!c.active || !c.sample) { c.tgtL = c.tgtR = 0; return; }
    const ins = c.ins;
    let vol = c.vol;

    // tremolo
    if (c.fx === 7 && this.playing) {
      vol = clamp(vol + ((waveValue(c.tremWave, c.tremPos) * c.tremDepth) >> 6), 0, 64);
      if (this.tick) c.tremPos = (c.tremPos + (c.tremSpeed >> 2)) & 63;
    }
    // tremor
    if (c.fx === 29 && this.playing) {
      const on = (c.tremor >> 4) + 1, off = (c.tremor & 15) + 1;
      if (c.tremorCount % (on + off) >= on) vol = 0;
      c.tremorCount++;
    }

    let envVol = 64, envPan = 32;
    if (ins) {
      if (ins.volEnv.on) {
        envVol = envelopeValue(ins.volEnv, c.volEnvPos);
        c.volEnvPos = advanceEnvelope(ins.volEnv, c.volEnvPos, c.keyOn);
      }
      if (ins.panEnv.on) {
        envPan = envelopeValue(ins.panEnv, c.panEnvPos);
        c.panEnvPos = advanceEnvelope(ins.panEnv, c.panEnvPos, c.keyOn);
      }
      if (!c.keyOn && ins.volEnv.on) {
        c.fadeout -= ins.fadeout;
        if (c.fadeout <= 0) { c.fadeout = 0; c.active = false; }
      }
    }

    // auto vibrato (instrument)
    let period = c.outPeriod;
    if (ins && ins.vibDepth && ins.vibRate) {
      const full = ins.vibDepth << 8;
      if (ins.vibSweep) c.autoVibAmp = Math.min(full, c.autoVibAmp + full / ins.vibSweep);
      else c.autoVibAmp = full;
      period += (autoVibValue(ins.vibType, c.autoVibPos) * c.autoVibAmp) / (64 * 256);
      c.autoVibPos = (c.autoVibPos + ins.vibRate) & 255;
    }

    c.step = this.freqOf(this.clampPeriod(period)) / this.sampleRate;

    const final = (vol / 64) * (envVol / 64) * (c.fadeout / 32768) * (this.globalVol / 64);
    let pan = c.pan + ((envPan - 32) * (128 - Math.abs(c.pan - 128))) / 32;
    pan = clamp(pan, 0, 255) / 255;
    const g = c.muted ? 0 : final * this.masterVolume * 0.6; // headroom: 4 full channels ~ 0 dBFS
    c.tgtL = g * Math.cos(pan * Math.PI / 2);
    c.tgtR = g * Math.sin(pan * Math.PI / 2);
  }

  nextRow() {
    const song = this.song;
    if (this.patDelay) {
      this.patDelay--;
      this.patDelayActive = true;
      return;
    }
    this.patDelayActive = false;
    const { pat } = this.currentPattern();
    const rows = pat ? pat.rows : 64;
    if (this.loopJump >= 0) {
      this.row = this.loopJump;
      this.loopJump = -1;
      this.jumpFlag = false;
      return;
    }
    if (this.mode === 'pattern') {
      if (this.jumpFlag) { this.row = 0; this.jumpFlag = false; return; }
      this.row++;
      if (this.row >= rows) this.row = 0;
      return;
    }
    const prevOrder = this.order;
    if (this.jumpFlag) {
      if (this.jumpOrder <= this.order) this.songEnded = true;
      this.order = this.jumpOrder;
      this.row = this.breakRow;
      this.jumpFlag = false;
    } else {
      this.row++;
      if (this.row >= rows) { this.row = 0; this.order++; }
    }
    if (this.order >= song.orders.length) {
      this.order = song.restart < song.orders.length ? song.restart : 0;
      this.songEnded = true;
    }
    const np = song.patterns[song.orders[this.order]];
    if (np && this.row >= np.rows) this.row = 0;
    if (this.order !== prevOrder) for (const c of this.channels) { c.loopRow = 0; c.loopCount = 0; }
  }

  doTick() {
    if (this.playing) {
      if (this.tick === 0) this.processRow();
      else for (const c of this.channels) this.tickEffects(c);
    }
    for (const c of this.channels) this.updateOutput(c);
    if (this.playing) {
      this.tick++;
      if (this.tick >= this.speed) {
        this.tick = 0;
        this.nextRow();
      }
    }
  }

  // ---------------------------------------------------------------------
  // Live playing (jam)

  jamNote(ch, note, insNum, volume = null) {
    const c = this.channels[ch];
    if (!c) return;
    if (note === NOTE_OFF) { this.keyOff(c); this.updateOutput(c); return; }
    const ins = this.song.instruments[insNum - 1] || null;
    c.ins = ins;
    c.insNum = insNum;
    this.triggerNote(c, note);
    this.resetInstrumentState(c);
    if (volume !== null) c.vol = volume;
    c.fx = 0; c.param = 0; c.volCol = 0;
    c.outPeriod = c.period;
    this.updateOutput(c);
  }

  jamOff(ch) {
    const c = this.channels[ch];
    if (c) this.keyOff(c);
  }

  // ---------------------------------------------------------------------
  // Mixer

  render(outL, outR, frames) {
    outL.fill(0, 0, frames);
    outR.fill(0, 0, frames);
    if (!this.song) return;
    let off = 0;
    while (off < frames) {
      if (this.samplesToTick <= 0) {
        this.doTick();
        this.samplesToTick += (this.sampleRate * 2.5) / this.bpm;
      }
      const n = Math.min(frames - off, Math.ceil(this.samplesToTick));
      for (const c of this.channels) this.mixChannel(c, outL, outR, off, n);
      this.mixGhosts(outL, outR, off, n);
      this.samplesToTick -= n;
      off += n;
    }
  }

  mixChannel(c, L, R, start, n) {
    const s = c.sample;
    if (!c.active || !s) {
      c.curL = c.curR = 0;
      return;
    }
    const data = s.data;
    const len = data.length;
    const looping = s.loopType !== 0 && s.loopLength > 0;
    const ls = s.loopStart;
    const le = Math.min(len, s.loopStart + s.loopLength);
    const pingpong = s.loopType === 2;
    const k = this.smooth;
    let pos = c.pos, dir = c.dir, curL = c.curL, curR = c.curR;
    const tgtL = c.tgtL, tgtR = c.tgtR, step = c.step;
    let peak = c.peak;
    const end = looping ? le : len;
    if (!(pos < end) || pos < 0) {
      if (looping && end > ls) pos = ls; else { c.active = false; return; }
    }
    for (let i = start, e = start + n; i < e; i++) {
      const idx = pos | 0;
      const frac = pos - idx;
      const a = data[idx];
      let b;
      if (idx + 1 < end) b = data[idx + 1];
      else b = looping ? (pingpong ? a : data[ls]) : 0;
      const v = a + (b - a) * frac;
      curL += (tgtL - curL) * k;
      curR += (tgtR - curR) * k;
      const l = v * curL, r = v * curR;
      L[i] += l;
      R[i] += r;
      const m = l > 0 ? l : -l;
      if (m > peak) peak = m;
      if (dir > 0) {
        pos += step;
        if (pos >= end) {
          if (!looping) { c.active = false; break; }
          if (pingpong) {
            pos = end - (pos - end) - 1e-6;
            if (pos < ls) pos = ls;
            dir = -1;
          } else {
            pos = ls + ((pos - end) % (le - ls));
          }
        }
      } else {
        pos -= step;
        if (pos < ls) {
          pos = ls + (ls - pos);
          if (pos >= end) pos = end - 1e-6;
          dir = 1;
        }
      }
    }
    c.pos = pos; c.dir = dir; c.curL = curL; c.curR = curR; c.peak = peak;
  }

  mixGhosts(L, R, start, n) {
    const decay = this.ghostDecay;
    for (let gi = this.ghosts.length - 1; gi >= 0; gi--) {
      const g = this.ghosts[gi];
      const s = g.sample, data = s.data, len = data.length;
      const looping = s.loopType !== 0 && s.loopLength > 0;
      const ls = s.loopStart, le = Math.min(len, s.loopStart + s.loopLength);
      const end = looping ? le : len;
      let pos = g.pos, gL = g.gL, gR = g.gR, dead = false;
      for (let i = start, e = start + n; i < e; i++) {
        const idx = pos | 0;
        const v = data[idx] ?? 0;
        L[i] += v * gL;
        R[i] += v * gR;
        gL *= decay; gR *= decay;
        pos += g.step * g.dir;
        if (g.dir > 0 && pos >= end) {
          if (!looping) { dead = true; break; }
          if (s.loopType === 2) { pos = end - 1e-6; g.dir = -1; } else pos = ls + ((pos - end) % (le - ls));
        } else if (g.dir < 0 && pos < ls) { pos = ls; g.dir = 1; }
      }
      g.pos = pos; g.gL = gL; g.gR = gR;
      if (dead || (gL < 1e-4 && gR < 1e-4)) this.ghosts.splice(gi, 1);
    }
  }

  /** Per-channel peak levels since last call (0..1). */
  takePeaks() {
    const out = new Float32Array(this.channels.length);
    for (let i = 0; i < this.channels.length; i++) {
      out[i] = this.channels[i].peak;
      this.channels[i].peak = 0;
    }
    return out;
  }
}
