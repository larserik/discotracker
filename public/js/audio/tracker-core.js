// Replayer host shared by the AudioWorklet and the ScriptProcessor fallback.
import { Replayer } from './replayer.js';

// Linear up to 0.8, then a smooth knee towards 1.0 instead of hard clipping.
function softClip(x) {
  const a = x < 0 ? -x : x;
  if (a <= 0.8) return x;
  const y = 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2);
  return x < 0 ? -y : y;
}

export class TrackerCore {
  constructor(sampleRate, post) {
    this.rp = new Replayer(sampleRate);
    this.post = post;
    this.levelFrames = 0;
  }

  onMessage(m) {
    const rp = this.rp;
    const song = rp.song;
    switch (m.type) {
      case 'song': {
        const vol = rp.masterVolume;
        const mutes = rp.channels.map((c) => c.muted);
        rp.setSong(m.song);
        rp.masterVolume = vol;
        rp.channels.forEach((c, i) => { c.muted = !!mutes[i]; });
        break;
      }
      case 'play': rp.play(m.mode, m.order, m.row, m.pattern); break;
      case 'stop': rp.stop(); break;
      case 'cell': {
        const p = song?.patterns[m.pattern];
        if (p) p.data.set(m.cell, (m.row * song.channels + m.ch) * 5);
        break;
      }
      case 'pattern': if (song) song.patterns[m.index] = m.pattern; break;
      case 'patterns': if (song) song.patterns = m.patterns; break;
      case 'orders':
        if (song) {
          song.orders = m.orders;
          song.restart = m.restart;
          if (rp.order >= song.orders.length) rp.order = 0;
        }
        break;
      case 'instrument':
        if (song) {
          song.instruments[m.index] = m.instrument;
          for (const c of rp.channels) if (c.insNum === m.index + 1) c.ins = m.instrument;
        }
        break;
      case 'instruments': if (song) song.instruments = m.instruments; break;
      case 'params':
        if (song) {
          for (const k of ['speed', 'bpm', 'linear', 'globalVolume', 'title', 'format']) if (k in m) song[k] = m[k];
          if ('speed' in m) rp.speed = m.speed;
          if ('bpm' in m) rp.bpm = m.bpm;
        }
        break;
      case 'jam': rp.jamNote(m.ch, m.note, m.inst, m.volume ?? null); break;
      case 'jamOff': rp.jamOff(m.ch); break;
      case 'mute': if (rp.channels[m.ch]) rp.channels[m.ch].muted = m.muted; break;
      case 'volume': rp.masterVolume = m.value; break;
      case 'seek': if (rp.playing) { rp.order = m.order; rp.row = m.row; rp.tick = 0; } break;
    }
  }

  /** Render one block into L/R (Float32Arrays of equal length). */
  process(L, R) {
    const rp = this.rp;
    rp.render(L, R, L.length);
    for (let i = 0; i < L.length; i++) {
      L[i] = softClip(L[i]);
      if (R !== L) R[i] = softClip(R[i]);
    }
    if (rp.rowEvent) {
      this.post({ type: 'row', ...rp.rowEvent, speed: rp.speed, bpm: rp.bpm });
      rp.rowEvent = null;
    }
    this.levelFrames += L.length;
    if (this.levelFrames >= 1024) {
      this.levelFrames = 0;
      this.post({ type: 'levels', peaks: rp.takePeaks() });
    }
  }
}
