import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSong } from '../public/js/demo.js';
import { saveXm, loadXm } from '../public/js/formats/xm.js';
import { saveMod, loadMod } from '../public/js/formats/mod.js';
import { loadSongFile } from '../public/js/formats/index.js';
import { Replayer } from '../public/js/audio/replayer.js';

function render(song, seconds = 4, sr = 44100) {
  const rp = new Replayer(sr);
  rp.setSong(song);
  rp.play('song', 0, 0);
  const L = new Float32Array(128), R = new Float32Array(128);
  let peak = 0, sum = 0, n = 0, rows = 0;
  for (let f = 0; f < seconds * sr; f += 128) {
    rp.render(L, R, 128);
    if (rp.rowEvent) { rows++; rp.rowEvent = null; }
    for (let i = 0; i < 128; i++) {
      assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), 'non-finite sample');
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      sum += L[i] * L[i]; n++;
    }
  }
  return { peak, rms: Math.sqrt(sum / n), rows, order: rp.order };
}

test('demo song renders audio', () => {
  const r = render(demoSong());
  assert.ok(r.rms > 0.01, `rms ${r.rms}`);
  // 4 s at 120 BPM speed 6 = 0.125 s/row -> 32 rows
  assert.ok(Math.abs(r.rows - 32) <= 1, `rows ${r.rows}`);
});

test('XM round trip keeps song data', () => {
  const song = demoSong();
  const { data } = saveXm(song);
  const back = loadSongFile(data.buffer, 'x.xm');
  assert.equal(back.channels, song.channels);
  assert.deepEqual(back.orders, song.orders);
  assert.equal(back.bpm, 120);
  assert.equal(back.instruments.length, song.instruments.length);
  for (let p = 0; p < song.patterns.length; p++) assert.deepEqual(back.patterns[p].data, song.patterns[p].data);
  const s0 = song.instruments[7].samples[0], b0 = back.instruments[7].samples[0];
  assert.equal(b0.loopType, s0.loopType);
  assert.equal(b0.loopLength, s0.loopLength);
  assert.ok(Math.abs(b0.data[100] - s0.data[100]) < 1e-4);
  assert.equal(back.instruments[7].volEnv.on, true);
  const a = render(song, 2), b = render(back, 2);
  assert.ok(Math.abs(a.rms - b.rms) < 0.002, `${a.rms} vs ${b.rms}`);
});

test('MOD export + import', () => {
  const song = demoSong();
  const { data, warnings } = saveMod(song);
  const back = loadSongFile(data.buffer, 'x.mod');
  assert.equal(back.format, 'mod');
  assert.equal(back.channels, 8);
  assert.deepEqual(back.orders, song.orders);
  assert.ok(back.instruments.length >= 17);
  const r = render(back, 3);
  assert.ok(r.rms > 0.01);
  console.log('mod warnings:', warnings);
});
