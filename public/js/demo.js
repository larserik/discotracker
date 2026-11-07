import { createSong, createPattern, setCell, NOTE_OFF } from './song.js';
import { makePreset, DEFAULT_KIT } from './instruments/presets.js';

const NAMES = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
/** 'A-3' / 'C#4' -> XM note number */
export function n(s) {
  const name = s.slice(0, 2).replace('-', '');
  return Number(s[2]) * 12 + NAMES[name] + 1;
}

const ins = (id) => DEFAULT_KIT.indexOf(id) + 1;

/** New, empty song with the default instrument kit loaded. */
export function newSong() {
  const song = createSong(8);
  song.instruments = DEFAULT_KIT.map((id) => makePreset(id));
  return song;
}

export function demoSong() {
  const song = newSong();
  song.title = 'DiscoTracker demo';
  song.bpm = 120;
  song.speed = 6;
  song.patterns = [createPattern(64, 8), createPattern(64, 8)];
  song.orders = [0, 0, 1, 1];

  const chords = [
    ['A-3', 'C-4', 'E-4'],
    ['F-3', 'A-3', 'C-4'],
    ['C-4', 'E-4', 'G-4'],
    ['G-3', 'B-3', 'D-4'],
  ];
  const roots = ['A-1', 'F-1', 'C-2', 'G-1'];
  const melody = [
    // row, note
    [0, 'E-5'], [6, 'D-5'], [8, 'C-5'], [12, 'A-4'],
    [16, 'C-5'], [22, 'A-4'], [24, 'F-4'], [28, 'A-4'],
    [32, 'G-4'], [36, 'C-5'], [40, 'E-5'], [44, 'G-5'],
    [48, 'F-5'], [52, 'D-5'], [56, 'B-4'], [60, 'D-5'],
  ];

  for (let p = 0; p < 2; p++) {
    const S = (row, ch, cell) => setCell(song, p, row, ch, cell);
    for (let r = 0; r < 64; r++) {
      const bar = r >> 4;
      if (r % 4 === 0) S(r, 0, { note: n('C-4'), inst: ins('kick') });
      if (r % 4 === 2) S(r, 1, { note: n('C-4'), inst: ins('openhat'), vol: 0x10 + 36 });
      else S(r, 1, { note: n('C-4'), inst: ins('hihat'), vol: 0x10 + (r % 4 === 0 ? 40 : 24) });
      if (r % 8 === 4) S(r, 2, { note: n('C-4'), inst: ins('clap') });
      if (r % 2 === 0) {
        const root = n(roots[bar]);
        S(r, 3, { note: r % 4 === 0 ? root : root + 12, inst: ins('discobass') });
      }
      if (r % 16 === 0) {
        chords[bar].forEach((c, i) => S(r, 4 + i, { note: n(c), inst: ins('strings'), vol: 0x10 + 28 }));
      }
      if (r % 16 === 14) for (let i = 0; i < 3; i++) S(r, 4 + i, { note: NOTE_OFF });
    }
    if (p === 1) {
      for (const [row, note] of melody) S(row, 7, { note: n(note), inst: ins('square'), vol: 0x10 + 40 });
      S(63, 7, { note: NOTE_OFF });
      S(0, 2, { note: n('C-4'), inst: ins('crash') });
    } else {
      // cowbell fill at the end of the first pattern
      [56, 58, 60, 61, 62, 63].forEach((r) => S(r, 7, { note: n('C-4'), inst: ins('cowbell'), vol: 0x10 + 40 }));
    }
  }
  return song;
}
