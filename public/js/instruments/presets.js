// Built-in instruments synthesized in the browser.
//
// All tonal samples are rendered at 33452 Hz (= 8363 * 4) with relativeNote +24,
// so one waveform cycle is exactly 128 samples and C-4 plays at ~261.3 Hz.
// That makes single-cycle loops click-free. This module is also the place
// where future instrument generators (synth editors etc.) plug in.

import { createInstrument, createSample, createEnvelope, LOOP_FORWARD, LOOP_NONE } from '../song.js';

export const RATE = 33452;
const PERIOD = 128;
const F0 = RATE / PERIOD; // 261.34 Hz
const TAU = Math.PI * 2;

// deterministic noise so presets are identical every time
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

function normalize(d, peak = 0.95) {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
  return d;
}

function fadeTail(d, ms = 10) {
  const n = Math.min(d.length, Math.floor((RATE * ms) / 1000));
  for (let i = 0; i < n; i++) d[d.length - 1 - i] *= i / n;
  return d;
}

const secs = (s) => Math.floor(s * RATE);

function sample(name, data, extra = {}) {
  return createSample({ name, data, relativeNote: 24, finetune: 0, bits: 16, ...extra });
}

function envelope(points, sustainPoint = -1) {
  const e = createEnvelope(points);
  e.on = true;
  if (sustainPoint >= 0) { e.sustain = true; e.sustainPoint = sustainPoint; }
  return e;
}

// Band-limited additive cycle with `harmonics` = [[k, amp, phase?], ...]
function cycle(harmonics, cycles = 1) {
  const n = PERIOD * cycles;
  const d = new Float32Array(n);
  for (const [k, a, ph = 0] of harmonics) {
    for (let i = 0; i < n; i++) d[i] += a * Math.sin((TAU * k * i) / PERIOD + ph);
  }
  return normalize(d, 0.9);
}

// ---------------------------------------------------------------------------
// Tonal

function piano() {
  const n = secs(2.2);
  const d = new Float32Array(n);
  const B = 0.00035;
  for (let k = 1; k <= 14; k++) {
    const f = k * F0 * Math.sqrt(1 + B * k * k);
    const a = 1 / Math.pow(k, 1.3) * (k === 1 ? 1 : 0.9);
    const decay = 1.6 + k * 0.55;
    const w = (TAU * f) / RATE;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      d[i] += a * Math.sin(w * i) * Math.exp(-t * decay) * (k > 1 ? 1 + 0.3 * Math.exp(-t * 20) : 1);
    }
  }
  // hammer
  const r = rng(7);
  let lp = 0;
  for (let i = 0; i < secs(0.02); i++) { lp += (r() - lp) * 0.3; d[i] += lp * 0.25 * (1 - i / secs(0.02)); }
  for (let i = 0; i < 40; i++) d[i] *= i / 40;
  return sample('Piano', fadeTail(normalize(d)));
}

function electricPiano() {
  const n = secs(2.2);
  const d = new Float32Array(n);
  const w = (TAU * F0) / RATE;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const index = 0.2 + 1.8 * Math.exp(-t * 4);
    d[i] = Math.sin(w * i + index * Math.sin(w * i)) * Math.exp(-t * 1.1)
      + 0.15 * Math.sin(w * 14 * i) * Math.exp(-t * 18);
  }
  for (let i = 0; i < 30; i++) d[i] *= i / 30;
  return sample('E-Piano', fadeTail(normalize(d)));
}

function karplus(seconds, damping, brightness, seed) {
  const n = secs(seconds);
  const d = new Float32Array(n);
  const r = rng(seed);
  let lp = 0;
  for (let i = 0; i < PERIOD; i++) { lp += (r() - lp) * brightness; d[i] = lp; }
  // remove DC from the excitation
  let mean = 0;
  for (let i = 0; i < PERIOD; i++) mean += d[i];
  mean /= PERIOD;
  for (let i = 0; i < PERIOD; i++) d[i] -= mean;
  for (let i = PERIOD; i < n; i++) {
    d[i] = damping * 0.5 * (d[i - PERIOD] + d[i - PERIOD + 1]);
  }
  return fadeTail(normalize(d));
}

function guitar() {
  return sample('Guitar', karplus(2.2, 0.9965, 0.7, 3));
}

function pickedBass() {
  const d = karplus(1.8, 0.998, 0.25, 11);
  return sample('Picked Bass', d);
}

function discoBass() {
  const n = secs(1.0);
  const d = new Float32Array(n);
  let lp1 = 0, lp2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const ph = (i % PERIOD) / PERIOD;
    const saw = 2 * ph - 1;
    const sq = ph < 0.5 ? 1 : -1;
    const x = saw * 0.7 + sq * 0.3;
    const cut = 0.04 + 0.5 * Math.exp(-t * 9);
    lp1 += (x - lp1) * cut;
    lp2 += (lp1 - lp2) * cut;
    d[i] = lp2 * Math.exp(-t * 2.5);
  }
  for (let i = 0; i < 20; i++) d[i] *= i / 20;
  return sample('Disco Bass', fadeTail(normalize(d)));
}

function organ() {
  const data = cycle([[0.5, 0.6], [1, 1], [2, 0.7], [3, 0.45], [4, 0.4], [6, 0.25], [8, 0.2]], 2);
  return sample('Organ', data, { loopType: LOOP_FORWARD, loopStart: 0, loopLength: data.length });
}

function strings() {
  const cycles = 200; // loop of 200 base cycles, voices detuned by whole cycles
  const n = PERIOD * cycles;
  const d = new Float32Array(n);
  for (const [c, ph] of [[cycles, 0], [cycles + 1, 1.3], [cycles - 1, 2.1]]) {
    for (let k = 1; k <= 24; k++) {
      const a = 1 / k * Math.exp(-k * 0.08);
      const w = (TAU * c * k) / n;
      for (let i = 0; i < n; i++) d[i] += a * Math.sin(w * i + ph * k);
    }
  }
  normalize(d, 0.9);
  return sample('Strings', d, { loopType: LOOP_FORWARD, loopStart: 0, loopLength: n });
}

function squareLead() {
  const h = [];
  for (let k = 1; k <= 31; k += 2) h.push([k, 1 / k]);
  const data = cycle(h, 1);
  return sample('Square Lead', data, { loopType: LOOP_FORWARD, loopStart: 0, loopLength: data.length });
}

function sawLead() {
  const cycles = 100;
  const n = PERIOD * cycles;
  const d = new Float32Array(n);
  for (const c of [cycles, cycles + 1]) {
    for (let k = 1; k <= 40; k++) {
      const w = (TAU * c * k) / n;
      for (let i = 0; i < n; i++) d[i] += (1 / k) * Math.sin(w * i);
    }
  }
  normalize(d, 0.9);
  return sample('Saw Lead', d, { loopType: LOOP_FORWARD, loopStart: 0, loopLength: n });
}

// ---------------------------------------------------------------------------
// Drums

function kick() {
  const n = secs(0.5);
  const d = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const f = 44 + 120 * Math.exp(-t * 28);
    ph += (TAU * f) / RATE;
    d[i] = Math.sin(ph) * Math.exp(-t * 6.5) + (i < 60 ? (1 - i / 60) * 0.5 : 0);
  }
  return sample('Kick', fadeTail(normalize(d, 0.98)));
}

function snare() {
  const n = secs(0.35);
  const d = new Float32Array(n);
  const r = rng(5);
  let hp = 0, prev = 0, ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const x = r();
    hp = 0.7 * (hp + x - prev);
    prev = x;
    ph += (TAU * (185 + 40 * Math.exp(-t * 40))) / RATE;
    d[i] = hp * Math.exp(-t * 13) * 0.8 + Math.sin(ph) * Math.exp(-t * 28) * 0.7;
  }
  return sample('Snare', fadeTail(normalize(d)));
}

function clap() {
  const n = secs(0.35);
  const d = new Float32Array(n);
  const r = rng(9);
  let lp = 0, hp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let env;
    if (t < 0.03) env = Math.exp(-((t * 1000) % 10) * 0.35);
    else env = Math.exp(-(t - 0.03) * 18);
    const x = r();
    lp += (x - lp) * 0.5;
    hp = 0.8 * (hp + lp - prev);
    prev = lp;
    d[i] = hp * env;
  }
  return sample('Clap', fadeTail(normalize(d)));
}

function metal(n, decay, seed) {
  const d = new Float32Array(n);
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 1.7);
  const r = rng(seed);
  let hp1 = 0, hp2 = 0, p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let x = 0;
    for (const f of freqs) x += ((f * t) % 1) < 0.5 ? 1 : -1;
    x = x / 6 * 0.6 + r() * 0.5;
    hp1 = 0.75 * (hp1 + x - p1); p1 = x;
    hp2 = 0.75 * (hp2 + hp1 - p2); p2 = hp1;
    d[i] = hp2 * Math.exp(-t * decay);
  }
  return d;
}

const closedHat = () => sample('Closed Hi-hat', fadeTail(normalize(metal(secs(0.12), 45, 2), 0.9)), { volume: 48 });
const openHat = () => sample('Open Hi-hat', fadeTail(normalize(metal(secs(0.7), 6, 4), 0.9)), { volume: 44 });
const crash = () => sample('Crash', fadeTail(normalize(metal(secs(2.0), 2.2, 8), 0.9), 50), { volume: 48 });

function tom() {
  const n = secs(0.6);
  const d = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    ph += (TAU * (100 + 70 * Math.exp(-t * 12))) / RATE;
    d[i] = Math.sin(ph) * Math.exp(-t * 6);
  }
  return sample('Tom', fadeTail(normalize(d)));
}

function cowbell() {
  const n = secs(0.45);
  const d = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const x = (((540 * t) % 1) < 0.5 ? 1 : -1) + (((800 * t) % 1) < 0.5 ? 1 : -1);
    lp += (x - lp) * 0.35;
    d[i] = (x - lp) * (t < 0.02 ? 1 : 0.6 * Math.exp(-(t - 0.02) * 10) + 0.4 * Math.exp(-t * 40));
  }
  return sample('Cowbell', fadeTail(normalize(d)), { volume: 44 });
}

// ---------------------------------------------------------------------------

const sustained = (fadeout, attack = 1) => ({
  volEnv: envelope([[0, 0], [attack, 64], [attack + 1, 64]], 2),
  fadeout,
});

export const PRESETS = [
  { id: 'piano', name: 'Piano', group: 'Keys', make: () => ({ samples: [piano()] }) },
  { id: 'epiano', name: 'E-Piano', group: 'Keys', make: () => ({ samples: [electricPiano()] }) },
  { id: 'organ', name: 'Organ', group: 'Keys', make: () => ({ samples: [organ()], ...sustained(1600) }) },
  { id: 'guitar', name: 'Guitar', group: 'Strings', make: () => ({ samples: [guitar()] }) },
  { id: 'strings', name: 'Strings', group: 'Strings', make: () => ({ samples: [strings()], ...sustained(500, 24) }) },
  { id: 'discobass', name: 'Disco Bass', group: 'Bass', make: () => ({ samples: [discoBass()] }) },
  { id: 'pickedbass', name: 'Picked Bass', group: 'Bass', make: () => ({ samples: [pickedBass()] }) },
  { id: 'square', name: 'Square Lead', group: 'Synth', make: () => ({ samples: [squareLead()], ...sustained(2400), vibType: 0, vibSweep: 40, vibDepth: 6, vibRate: 14 }) },
  { id: 'saw', name: 'Saw Lead', group: 'Synth', make: () => ({ samples: [sawLead()], ...sustained(1800) }) },
  { id: 'kick', name: 'Kick', group: 'Drums', make: () => ({ samples: [kick()] }) },
  { id: 'snare', name: 'Snare', group: 'Drums', make: () => ({ samples: [snare()] }) },
  { id: 'clap', name: 'Clap', group: 'Drums', make: () => ({ samples: [clap()] }) },
  { id: 'hihat', name: 'Closed Hi-hat', group: 'Drums', make: () => ({ samples: [closedHat()] }) },
  { id: 'openhat', name: 'Open Hi-hat', group: 'Drums', make: () => ({ samples: [openHat()] }) },
  { id: 'tom', name: 'Tom', group: 'Drums', make: () => ({ samples: [tom()] }) },
  { id: 'crash', name: 'Crash', group: 'Drums', make: () => ({ samples: [crash()] }) },
  { id: 'cowbell', name: 'Cowbell', group: 'Drums', make: () => ({ samples: [cowbell()] }) },
];

const cache = new Map();

/** Build a fresh instrument from a preset id. */
export function makePreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown preset ${id}`);
  if (!cache.has(id)) cache.set(id, p.make());
  const parts = structuredClone(cache.get(id));
  return createInstrument({ name: p.name, ...parts });
}

/** The default instrument set loaded into a new song. */
export const DEFAULT_KIT = ['piano', 'discobass', 'kick', 'snare', 'hihat', 'openhat', 'clap', 'strings',
  'epiano', 'guitar', 'organ', 'square', 'saw', 'pickedbass', 'tom', 'crash', 'cowbell'];

export { LOOP_NONE };
