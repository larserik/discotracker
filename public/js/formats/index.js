import { loadMod, saveMod, isMod } from './mod.js';
import { loadXm, saveXm, isXm } from './xm.js';

export const SONG_EXTENSIONS = ['mod', 'xm'];
// Formats planned next: s3m, stm, it

export function loadSongFile(buf, filename = '') {
  const u8 = new Uint8Array(buf);
  const ext = filename.toLowerCase().split('.').pop();
  if (isXm(u8)) return loadXm(buf);
  if (ext === 'mod' || ext === 'nst' || filename.toLowerCase().startsWith('mod.') || isMod(u8)) return loadMod(buf);
  throw new Error('Unsupported file format. Supported: ' + SONG_EXTENSIONS.map((e) => '.' + e.toUpperCase()).join(', '));
}

export function saveSongFile(song, format) {
  if (format === 'mod') return saveMod(song);
  if (format === 'xm') return saveXm(song);
  throw new Error(`Saving as ${format} is not supported yet`);
}
