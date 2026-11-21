// Customisable keyboard shortcuts.
//
// A combo is "Mod+Alt+Shift+<KeyboardEvent.code>", modifiers in that order. "Mod" is Ctrl on
// Windows/Linux and Cmd (or Ctrl) on Mac. Codes are physical key positions, like the piano
// keys, so the layout is the same on every keyboard. Changes are kept in this browser.
import { local } from './storage.js';

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const STORE = 'dt.keymap';

export const GROUPS = ['Playback', 'Editing', 'Moving around', 'Selection & clipboard', 'Song & file'];

export const ACTIONS = [
  { id: 'playSong', group: 'Playback', label: 'Play song from the current order position', keys: ['Enter', 'NumpadEnter'] },
  { id: 'playFromRow', group: 'Playback', label: 'Play song from the cursor row', keys: ['Shift+Enter', 'Shift+NumpadEnter'] },
  { id: 'playPattern', group: 'Playback', label: 'Play (loop) the current pattern', keys: ['Mod+Enter', 'Mod+NumpadEnter'] },
  { id: 'stopOrEdit', group: 'Playback', label: 'Stop, or turn edit mode on/off when stopped', keys: ['Space'] },
  { id: 'stop', group: 'Playback', label: 'Stop / clear the selection', keys: ['Escape'] },

  { id: 'clearField', group: 'Editing', label: 'Clear the note or value at the cursor', keys: ['Delete', 'Backspace'] },
  { id: 'clearCell', group: 'Editing', label: 'Clear note, instrument, volume and effect', keys: ['Shift+Delete', 'Shift+Backspace'] },
  { id: 'insertSpace', group: 'Editing', label: 'Insert an empty row in this channel (push down)', keys: ['Insert'] },
  { id: 'deleteAbove', group: 'Editing', label: 'Delete the row above in this channel (pull up)', keys: ['Mod+Backspace'] },
  { id: 'transposeUp', group: 'Editing', label: 'Transpose note/selection up', keys: ['Alt+ArrowUp'] },
  { id: 'transposeDown', group: 'Editing', label: 'Transpose note/selection down', keys: ['Alt+ArrowDown'] },
  { id: 'octaveUp', group: 'Editing', label: 'Transpose note/selection an octave up', keys: ['Alt+Shift+ArrowUp'] },
  { id: 'octaveDown', group: 'Editing', label: 'Transpose note/selection an octave down', keys: ['Alt+Shift+ArrowDown'] },
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((o) => ({ id: `octave${o}`, group: 'Editing', label: `Octave ${o}`, keys: [`F${o + 1}`] })),
  { id: 'undo', group: 'Editing', label: 'Undo', keys: ['Mod+KeyZ'] },
  { id: 'redo', group: 'Editing', label: 'Redo', keys: ['Mod+Shift+KeyZ', 'Mod+KeyY'] },

  { id: 'up', group: 'Moving around', label: 'Up one row', keys: ['ArrowUp'] },
  { id: 'down', group: 'Moving around', label: 'Down one row', keys: ['ArrowDown'] },
  { id: 'left', group: 'Moving around', label: 'Left one column', keys: ['ArrowLeft'] },
  { id: 'right', group: 'Moving around', label: 'Right one column', keys: ['ArrowRight'] },
  { id: 'nextChannel', group: 'Moving around', label: 'Next channel', keys: ['Tab'] },
  { id: 'prevChannel', group: 'Moving around', label: 'Previous channel', keys: ['Shift+Tab'] },
  { id: 'pageUp', group: 'Moving around', label: 'Up 16 rows', keys: ['PageUp'] },
  { id: 'pageDown', group: 'Moving around', label: 'Down 16 rows', keys: ['PageDown'] },
  { id: 'top', group: 'Moving around', label: 'First row', keys: ['Home'] },
  { id: 'bottom', group: 'Moving around', label: 'Last row', keys: ['End'] },
  { id: 'prevOrder', group: 'Moving around', label: 'Previous order position', keys: ['Mod+ArrowLeft'] },
  { id: 'nextOrder', group: 'Moving around', label: 'Next order position', keys: ['Mod+ArrowRight'] },
  { id: 'prevInstrument', group: 'Moving around', label: 'Previous instrument', keys: ['Mod+ArrowUp'] },
  { id: 'nextInstrument', group: 'Moving around', label: 'Next instrument', keys: ['Mod+ArrowDown'] },

  { id: 'selUp', group: 'Selection & clipboard', label: 'Extend selection up', keys: ['Shift+ArrowUp'] },
  { id: 'selDown', group: 'Selection & clipboard', label: 'Extend selection down', keys: ['Shift+ArrowDown'] },
  { id: 'selLeft', group: 'Selection & clipboard', label: 'Extend selection left', keys: ['Shift+ArrowLeft'] },
  { id: 'selRight', group: 'Selection & clipboard', label: 'Extend selection right', keys: ['Shift+ArrowRight'] },
  { id: 'selPageUp', group: 'Selection & clipboard', label: 'Extend selection 16 rows up', keys: ['Shift+PageUp'] },
  { id: 'selPageDown', group: 'Selection & clipboard', label: 'Extend selection 16 rows down', keys: ['Shift+PageDown'] },
  { id: 'selectAll', group: 'Selection & clipboard', label: 'Select the whole pattern', keys: ['Mod+KeyA'] },
  { id: 'copy', group: 'Selection & clipboard', label: 'Copy', keys: ['Mod+KeyC'] },
  { id: 'cut', group: 'Selection & clipboard', label: 'Cut', keys: ['Mod+KeyX'] },
  { id: 'paste', group: 'Selection & clipboard', label: 'Paste', keys: ['Mod+KeyV'] },

  { id: 'save', group: 'Song & file', label: 'Save (to your account, or download XM)', keys: ['Mod+KeyS'] },
  { id: 'open', group: 'Song & file', label: 'Open a song file', keys: ['Mod+KeyO'] },
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'Fn']);

let overrides = {};
try { overrides = JSON.parse(local.get(STORE) || '{}') || {}; } catch { overrides = {}; }
let index = null; // combo -> action id

function rebuild() {
  index = new Map();
  for (const a of ACTIONS) for (const c of keysFor(a.id)) if (!index.has(c)) index.set(c, a.id);
}

export const keysFor = (id) => overrides[id] ?? BY_ID.get(id)?.keys ?? [];
export const isDefault = (id) => !(id in overrides);

function save() {
  local.set(STORE, JSON.stringify(overrides));
  rebuild();
  listeners.forEach((f) => f());
}
const listeners = [];
export const onKeymapChange = (f) => listeners.push(f);

/** Set an action's keys. Returns the actions the combos were taken away from. */
export function setKeys(id, combos) {
  const taken = [];
  for (const a of ACTIONS) {
    if (a.id === id) continue;
    const cur = keysFor(a.id);
    const left = cur.filter((c) => !combos.includes(c));
    if (left.length !== cur.length) { overrides[a.id] = left; taken.push(a); }
  }
  overrides[id] = [...new Set(combos)];
  for (const a of ACTIONS) if (overrides[a.id] && sameList(overrides[a.id], a.keys)) delete overrides[a.id];
  save();
  return taken;
}
const sameList = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

export function resetKeys(id) { delete overrides[id]; save(); }
export function resetAllKeys() { overrides = {}; save(); }

/** "Mod+Shift+KeyZ" for a keydown event, or null for a lone modifier key. */
export function comboFromEvent(e, code = e.code) {
  if (!code || MODIFIER_CODES.has(code)) return null;
  return (e.ctrlKey || e.metaKey ? 'Mod+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + code;
}

/** The action bound to this keydown, if any. */
export function actionFor(e) {
  if (!index) rebuild();
  const hit = index.get(comboFromEvent(e));
  if (hit) return hit;
  // Shortcuts like Cmd+Z follow the letter on non-QWERTY layouts (AZERTY, Dvorak…) too.
  if ((e.ctrlKey || e.metaKey) && /^[a-z]$/i.test(e.key)) return index.get(comboFromEvent(e, `Key${e.key.toUpperCase()}`)) || null;
  return null;
}

const KEY_NAMES = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Delete: IS_MAC ? 'Del (fn+⌫)' : 'Del',
  Backspace: IS_MAC ? '⌫ Backspace' : 'Backspace', Insert: 'Ins', PageUp: 'PgUp', PageDown: 'PgDn', NumpadEnter: 'Num Enter',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', IntlBackslash: '<',
};

export function formatCombo(combo) {
  const parts = combo.split('+');
  const code = parts.pop();
  const key = KEY_NAMES[code] ?? code.replace(/^Key|^Digit/, '').replace(/^Numpad/, 'Num ');
  const mods = parts.map((m) => (m === 'Mod' ? (IS_MAC ? 'Cmd' : 'Ctrl') : m === 'Alt' ? (IS_MAC ? 'Option' : 'Alt') : m));
  return [...mods, key].join('+');
}
