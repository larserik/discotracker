import {
  CELL, NOTE_OFF, MAX_INSTRUMENTS, createInstrument, createPattern, ensurePattern, resizePattern,
  setChannelCount,
} from './song.js';
import { loadSongFile, saveSongFile } from './formats/index.js';
import { AudioEngine } from './audio/engine.js';
import { importSampleFile } from './audio/sample-import.js';
import { PRESETS, makePreset } from './instruments/presets.js';
import { demoSong, newSong } from './demo.js';
import { PatternEditor } from './ui/pattern-editor.js';
import { initAuth } from './ui/auth.js';
import { initSongsDialog } from './ui/songs-dialog.js';
import { initPlaylists } from './ui/playlists.js';
import { idbGet, idbSet, local, newDraftId, putDraft, deleteDraft } from './storage.js';
import { api } from './api.js';

const $ = (sel) => document.querySelector(sel);
const HEX = '0123456789ABCDEF';
const hex2 = (v) => HEX[v >> 4] + HEX[v & 15];

// FT2 style piano keyboard, by physical key position (works on any layout)
const NOTE_KEYS = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20,
  KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
  BracketLeft: 29, Equal: 30, BracketRight: 31,
};
const KEYOFF_KEYS = new Set(['Backquote', 'IntlBackslash']);
const VOL_CMD_KEYS = { Minus: 6, Equal: 7, KeyD: 8, KeyU: 9, KeyS: 10, KeyV: 11, KeyP: 12, KeyL: 13, KeyR: 14, KeyM: 15 };

function hexFromCode(code) {
  let m = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (m) return +m[1];
  m = /^Key([A-F])$/.exec(code);
  if (m) return 10 + m[1].charCodeAt(0) - 65;
  return -1;
}
function fxFromCode(code) {
  let m = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (m) return +m[1];
  m = /^Key([A-Z])$/.exec(code);
  if (m) return 10 + m[1].charCodeAt(0) - 65;
  return -1;
}

class App {
  constructor() {
    this.engine = new AudioEngine();
    this.song = null;
    this.state = {
      order: 0, pattern: 0, row: 0, ch: 0, col: 0,
      octave: 4, step: 1, edit: false, follow: true, followActive: false,
      instrument: 1, sample: 0, selection: null,
    };
    this.mutes = [];
    this.playPos = null;
    this.undo = [];
    this.redo = [];
    this.clipboard = null;
    this.held = new Map(); // key code -> channel (jamming)
    this.serverSong = null; // { id, name } when the song came from / was saved to My songs
    this.draftId = null; // id of this song in "My songs → On this device" once it has been changed
    this.dirty = false; // changed since it was last saved to the account / loaded
    this.user = null;
    this.onUserChange = []; // callbacks(user)
    this.saveTimer = null;
  }

  async init() {
    this.editor = new PatternEditor($('#pattern'), this);
    this.bindEngine();
    this.bindUi();
    this.bindKeyboard();
    this.bindDragDrop();
    this.buildPresetSelect();

    this.auth = initAuth({
      onUser: (user) => this.setUser(user),
      toast: (m, t) => this.toast(m, t),
    });
    this.songsDialog = initSongsDialog(this);
    this.playlists = initPlaylists(this);

    const saved = await idbGet('autosave');
    let restored = false;
    if (saved?.data) {
      try {
        const song = loadSongFile(saved.data.buffer ?? saved.data, 'autosave.xm');
        if (saved.format === 'mod') { song.format = 'mod'; song.linear = false; }
        if (saved.channelPan) song.channelPan = saved.channelPan;
        this.setSong(song, { serverSong: saved.serverSong || null, draftId: saved.draftId || null, dirty: !!saved.dirty });
        restored = true;
        this.status('Restored your last session.');
      } catch (e) {
        console.warn('autosave restore failed', e);
      }
    }
    if (!restored) {
      this.setSong(demoSong());
      this.status('Welcome! Press Enter to play the demo, or Space to start editing. Press Help for keys.');
    }
    // Start audio on the first gesture (browser autoplay rules)
    const unlock = () => { this.engine.start().catch(() => {}); };
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
    window.addEventListener('keydown', unlock, { once: true, capture: true });
  }

  // ------------------------------------------------------------------
  // Song

  /** Low-level: show `song` in the editor. Use switchSong() for user actions. */
  setSong(song, { serverSong = null, draftId = null, dirty = false } = {}) {
    this.song = song;
    this.serverSong = serverSong;
    this.draftId = draftId;
    this.dirty = dirty;
    const st = this.state;
    st.order = 0;
    st.pattern = song.orders[0] ?? 0;
    ensurePattern(song, st.pattern);
    st.row = 0; st.ch = 0; st.col = 0; st.selection = null;
    st.instrument = 1; st.sample = 0;
    this.mutes = new Array(song.channels).fill(false);
    this.undo = []; this.redo = [];
    this.playPos = null;
    this.engine.stop();
    this.engine.loadSong(song);
    for (let i = 0; i < song.channels; i++) this.engine.mute(i, false);
    this.refreshAll();
  }

  refreshAll() {
    this.refreshSongPanel();
    this.renderOrders();
    this.renderInstList();
    this.renderInstrument();
    this.updatePosition();
    this.editor.invalidate();
  }

  /**
   * Replace the song in the editor. The current song is never lost: if it has
   * changes it is (already) kept in "My songs → On this device".
   * `edited`: the new song counts as the user's own work in progress right away.
   */
  async switchSong(song, { serverSong = null, draftId = null, dirty = false, edited = false } = {}) {
    await this.flushAutosave();
    const prev = this.song && this.dirty && this.draftId ? this.song.title || 'untitled' : null;
    this.setSong(song, { serverSong, draftId, dirty });
    if (edited) this.changed();
    else this.scheduleAutosave();
    if (prev) this.toast(`"${prev}" is kept in My songs (on this device).`);
  }

  /** The user changed the song. */
  changed() {
    if (this.listening) return;
    this.dirty = true;
    if (!this.draftId) this.draftId = newDraftId();
    this.scheduleAutosave();
  }

  scheduleAutosave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.autosave(), 1500);
  }

  async flushAutosave() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.autosave();
  }

  async autosave() {
    this.saveTimer = null;
    if (this.listening) return; // a playlist song is shown, not the user's work
    try {
      const { data } = saveSongFile(this.song, 'xm');
      const meta = { format: this.song.format, channelPan: this.song.channelPan, serverSong: this.serverSong };
      await idbSet('autosave', { data, ...meta, draftId: this.draftId, dirty: this.dirty, savedAt: Date.now() });
      if (this.dirty && this.draftId) {
        await putDraft({ id: this.draftId, title: this.song.title || 'untitled', data, ...meta, updatedAt: Date.now() });
      }
    } catch (e) { console.warn(e); }
  }

  // ------------------------------------------------------------------
  // UI helpers

  status(msg) { $('#status').textContent = msg; }

  toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').append(el);
    setTimeout(() => el.classList.add('hide'), type === 'error' ? 6000 : 3500);
    setTimeout(() => el.remove(), type === 'error' ? 6600 : 4100);
  }

  setUser(user) {
    this.user = user;
    document.body.classList.toggle('signed-in', !!user);
    for (const fn of this.onUserChange) fn(user);
  }

  updatePosition() {
    const st = this.state, s = this.song;
    const pp = this.engine.playing && this.playPos ? this.playPos : null;
    const pos = pp ? `▶ ${hex2(pp.order)} · ` : '';
    $('#position').textContent =
      `${pos}Pos ${hex2(st.order)}/${hex2(s.orders.length - 1)}  Pat ${hex2(st.pattern)}  Row ${String(st.row).padStart(2, '0')}  ` +
      `Ch ${st.ch + 1}  Oct ${st.octave}  Ins ${hex2(st.instrument)}  ${pp ? `BPM ${pp.bpm} Spd ${pp.speed}` : ''}`;
    $('#edit-btn').classList.toggle('active', st.edit);
    document.body.classList.toggle('editing', st.edit);
  }

  refreshSongPanel() {
    const s = this.song, st = this.state;
    $('#song-title').value = s.title;
    $('#song-bpm').value = s.bpm;
    $('#song-speed').value = s.speed;
    $('#song-channels').value = s.channels;
    $('#pattern-rows').value = s.patterns[st.pattern]?.rows ?? 64;
    $('#edit-octave').value = st.octave;
    $('#edit-step').value = st.step;
    $('#format-badge').textContent = s.format === 'mod'
      ? `MOD · ${s.channels} channels · Amiga periods`
      : `XM · ${s.channels} channels · ${s.linear ? 'linear' : 'Amiga'} frequencies`;
  }

  renderOrders() {
    const box = $('#orders');
    const s = this.song, st = this.state;
    box.innerHTML = '';
    s.orders.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'order' + (i === st.order ? ' current' : '') + (this.playPos && this.engine.playing && this.playPos.order === i ? ' playing' : '');
      el.dataset.index = i;
      el.innerHTML = `<span class="pos">${hex2(i)}</span><span class="pat">${hex2(p)}</span>${i === s.restart ? '<span class="restart" title="Restart position">↺</span>' : ''}`;
      box.append(el);
    });
    const cur = box.children[st.order];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    $('#order-info').textContent = `${s.orders.length} pos · ${s.patterns.length} pat`;
  }

  // ------------------------------------------------------------------
  // Instruments

  maxInstruments() { return this.song.format === 'mod' ? 31 : MAX_INSTRUMENTS; }
  currentInstrument() { return this.song.instruments[this.state.instrument - 1] || null; }

  ensureInstrument(n) {
    const list = this.song.instruments;
    while (list.length < n) list.push(createInstrument());
    return list[n - 1];
  }

  renderInstList() {
    const box = $('#inst-list');
    box.innerHTML = '';
    const max = this.maxInstruments();
    for (let i = 1; i <= max; i++) {
      const ins = this.song.instruments[i - 1];
      const el = document.createElement('div');
      const has = ins && ins.samples.some((s) => s.data.length);
      el.className = 'inst' + (i === this.state.instrument ? ' current' : '') + (has ? ' has' : '');
      el.dataset.index = i;
      el.setAttribute('role', 'option');
      el.innerHTML = `<span class="num">${hex2(i)}</span><span class="name"></span>`;
      el.querySelector('.name').textContent = ins?.name || '';
      box.append(el);
    }
    box.children[this.state.instrument - 1]?.scrollIntoView({ block: 'nearest' });
  }

  selectInstrument(n) {
    n = Math.max(1, Math.min(this.maxInstruments(), n));
    this.state.instrument = n;
    this.state.sample = 0;
    const box = $('#inst-list');
    box.querySelector('.current')?.classList.remove('current');
    box.children[n - 1]?.classList.add('current');
    box.children[n - 1]?.scrollIntoView({ block: 'nearest' });
    this.renderInstrument();
    this.updatePosition();
  }

  renderInstrument() {
    const ins = this.currentInstrument();
    $('#inst-name').value = ins?.name || '';
    const sel = $('#sample-select');
    sel.innerHTML = '';
    const samples = ins?.samples || [];
    samples.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = `${hex2(i)} ${s.name || ''}`;
      sel.append(o);
    });
    sel.hidden = samples.length < 2;
    if (this.state.sample >= samples.length) this.state.sample = 0;
    sel.value = this.state.sample;
    const smp = samples[this.state.sample];
    const dis = !smp;
    for (const id of ['smp-volume', 'smp-panning', 'smp-finetune', 'smp-relnote', 'smp-looptype', 'smp-loopstart', 'smp-looplen']) $('#' + id).disabled = dis;
    $('#smp-volume').value = smp?.volume ?? '';
    $('#smp-panning').value = smp?.panning ?? '';
    $('#smp-finetune').value = smp?.finetune ?? '';
    $('#smp-relnote').value = smp?.relativeNote ?? '';
    $('#smp-looptype').value = smp?.loopType ?? 0;
    $('#smp-loopstart').value = smp?.loopStart ?? '';
    $('#smp-looplen').value = smp?.loopLength ?? '';
    $('#inst-fadeout').value = ins?.fadeout ?? 0;
    $('#inst-fadeout').disabled = !ins;
    $('#inst-volenv').checked = !!ins?.volEnv.on;
    $('#inst-volenv').disabled = !ins;
    $('#sample-info').textContent = smp
      ? `${smp.data.length.toLocaleString()} samples · ${smp.bits}-bit · C-4 = ${Math.round(8363 * 2 ** ((smp.relativeNote + smp.finetune / 128) / 12))} Hz`
      : 'Empty – load a sample or pick a built-in instrument.';
    this.drawWaveform();
  }

  drawWaveform() {
    const c = $('#waveform');
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 260, h = c.clientHeight || 90;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    ctx.fillStyle = css.getPropertyValue('--pe-bg').trim() || '#0d1124';
    ctx.fillRect(0, 0, w, h);
    const smp = this.currentInstrument()?.samples[this.state.sample];
    ctx.fillStyle = css.getPropertyValue('--pe-sep').trim();
    ctx.fillRect(0, h / 2, w, 1);
    if (!smp || !smp.data.length) return;
    const d = smp.data, n = d.length;
    if (smp.loopType && smp.loopLength) {
      ctx.fillStyle = css.getPropertyValue('--pe-sel').trim();
      ctx.fillRect((smp.loopStart / n) * w, 0, Math.max(1, (smp.loopLength / n) * w), h);
    }
    ctx.fillStyle = css.getPropertyValue('--pe-vol').trim();
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * n), b = Math.max(a + 1, Math.floor(((x + 1) / w) * n));
      let mn = 1, mx = -1;
      for (let i = a; i < b; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      ctx.fillRect(x, h / 2 - mx * h / 2, 1, Math.max(1, (mx - mn) * h / 2));
    }
  }

  instrumentChanged(index = this.state.instrument - 1) {
    const ins = this.song.instruments[index];
    if (ins) this.engine.setInstrument(index, ins);
    this.changed();
  }

  buildPresetSelect() {
    const sel = $('#preset-select');
    const groups = {};
    for (const p of PRESETS) (groups[p.group] ||= []).push(p);
    for (const [g, list] of Object.entries(groups)) {
      const og = document.createElement('optgroup');
      og.label = g;
      for (const p of list) {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.name;
        og.append(o);
      }
      sel.append(og);
    }
    sel.addEventListener('change', () => {
      const id = sel.value;
      sel.value = '';
      if (!id) return;
      const cur = this.currentInstrument();
      if (cur && cur.samples.some((s) => s.data.length) && !confirm(`Replace instrument ${hex2(this.state.instrument)} "${cur.name}"?`)) return;
      this.ensureInstrument(this.state.instrument);
      this.song.instruments[this.state.instrument - 1] = makePreset(id);
      this.instrumentChanged();
      this.renderInstList();
      this.renderInstrument();
      this.preview();
      $('#pattern').focus();
    });
  }

  async loadSampleFile(file) {
    try {
      const smp = await importSampleFile(file);
      const ins = this.ensureInstrument(this.state.instrument);
      if (ins.samples.length) ins.samples[this.state.sample] = smp;
      else ins.samples = [smp];
      if (!ins.name) ins.name = smp.name;
      this.instrumentChanged();
      this.renderInstList();
      this.renderInstrument();
      this.toast(`Loaded "${file.name}" into instrument ${hex2(this.state.instrument)}`);
    } catch (e) {
      this.toast(e.message, 'error');
    }
  }

  preview() {
    this.engine.start().then(() => {
      const ch = this.state.ch;
      this.engine.jam(ch, this.state.octave * 12 + 1, this.state.instrument);
    });
  }

  // ------------------------------------------------------------------
  // Cursor

  get pat() { return this.song.patterns[this.state.pattern]; }

  setCursor({ row, ch, col }) {
    const st = this.state;
    if (row !== undefined) st.row = Math.max(0, Math.min(this.pat.rows - 1, row));
    if (ch !== undefined) st.ch = Math.max(0, Math.min(this.song.channels - 1, ch));
    if (col !== undefined) st.col = col;
    this.editor.invalidate();
    this.updatePosition();
  }

  moveRow(d, wrap = true) {
    const rows = this.pat.rows;
    let r = this.state.row + d;
    if (wrap) r = ((r % rows) + rows) % rows;
    this.setCursor({ row: r });
  }

  moveChannel(d) {
    const n = this.song.channels;
    this.setCursor({ ch: (this.state.ch + d + n) % n, col: 0 });
  }

  moveCol(d) {
    const st = this.state;
    let col = st.col + d, ch = st.ch;
    if (col > 7) { col = 0; ch = (ch + 1) % this.song.channels; }
    if (col < 0) { col = 7; ch = (ch - 1 + this.song.channels) % this.song.channels; }
    this.setCursor({ ch, col });
  }

  gotoOrder(i) {
    const s = this.song, st = this.state;
    st.order = Math.max(0, Math.min(s.orders.length - 1, i));
    st.pattern = s.orders[st.order];
    ensurePattern(s, st.pattern);
    st.row = Math.min(st.row, this.pat.rows - 1);
    st.selection = null;
    this.renderOrders();
    this.refreshSongPanel();
    this.updatePosition();
    this.editor.invalidate();
  }

  // ------------------------------------------------------------------
  // Pattern editing

  pushUndo(patIdx = this.state.pattern) {
    const p = this.song.patterns[patIdx];
    this.undo.push({ pattern: patIdx, rows: p.rows, data: p.data.slice() });
    if (this.undo.length > 200) this.undo.shift();
    this.redo = [];
  }

  applyHistory(from, to) {
    const e = from.pop();
    if (!e) return;
    const s = this.song;
    if (!s.patterns[e.pattern]) return;
    const cur = s.patterns[e.pattern];
    to.push({ pattern: e.pattern, rows: cur.rows, data: cur.data.slice() });
    s.patterns[e.pattern] = { rows: e.rows, data: e.data };
    this.engine.setPattern(e.pattern, s.patterns[e.pattern]);
    if (this.state.pattern === e.pattern) this.setCursor({ row: this.state.row });
    this.refreshSongPanel();
    this.editor.invalidate();
    this.changed();
  }

  cellOffset(row, ch) { return (row * this.song.channels + ch) * CELL; }

  writeCell(row, ch, values, { undo = true } = {}) {
    if (undo) this.pushUndo();
    const d = this.pat.data;
    const o = this.cellOffset(row, ch);
    values.forEach((v, i) => { if (v !== undefined && v !== null) d[o + i] = v; });
    this.engine.setCell(this.state.pattern, row, ch, d.slice(o, o + CELL));
    this.editor.invalidate();
    this.changed();
  }

  patternChanged() {
    this.engine.setPattern(this.state.pattern, this.pat);
    this.editor.invalidate();
    this.changed();
  }

  editRow() {
    // While recording during playback the note lands on the playing row.
    return this.state.row;
  }

  advance() {
    if (this.engine.playing && this.state.followActive) return;
    if (this.state.step) this.moveRow(this.state.step, true);
  }

  enterNote(note) {
    const st = this.state;
    const row = this.editRow();
    const inst = note === NOTE_OFF ? undefined : st.instrument;
    this.writeCell(row, st.ch, [note, note === NOTE_OFF ? 0 : inst]);
    this.advance();
  }

  enterHex(value, code) {
    const st = this.state;
    const row = this.editRow();
    const d = this.pat.data;
    const o = this.cellOffset(row, st.ch);
    const col = st.col;
    let ins = d[o + 1], vol = d[o + 2], fx = d[o + 3], par = d[o + 4];
    if (col === 1 || col === 2) {
      if (value < 0) return false;
      if (col === 1) ins = (value << 4) | (ins & 15); else ins = (ins & 0xf0) | value;
      ins = Math.min(this.maxInstruments(), ins);
      this.writeCell(row, st.ch, [undefined, ins]);
    } else if (col === 3) {
      let hi;
      const digit = /^(?:Digit|Numpad)([0-4])$/.exec(code);
      if (digit) hi = +digit[1] + 1; // 1..5 => 0x10..0x50
      else if (code in VOL_CMD_KEYS) hi = VOL_CMD_KEYS[code];
      else return false;
      let lo = vol ? vol & 15 : 0;
      if (hi === 5) lo = 0;
      this.writeCell(row, st.ch, [undefined, undefined, (hi << 4) | lo]);
    } else if (col === 4) {
      if (value < 0) return false;
      let hi = vol ? vol >> 4 : 1;
      if (hi === 5 && value) hi = 4;
      this.writeCell(row, st.ch, [undefined, undefined, (hi << 4) | value]);
    } else if (col === 5) {
      const f = fxFromCode(code);
      if (f < 0) return false;
      if (this.song.format === 'mod' && f > 15) { this.toast('MOD supports effects 0–F only'); return true; }
      this.writeCell(row, st.ch, [undefined, undefined, undefined, f]);
    } else if (col === 6 || col === 7) {
      if (value < 0) return false;
      par = col === 6 ? (value << 4) | (par & 15) : (par & 0xf0) | value;
      this.writeCell(row, st.ch, [undefined, undefined, undefined, fx, par]);
    } else return false;
    this.advance();
    return true;
  }

  clearField(all = false) {
    const st = this.state;
    if (st.selection) return this.clearSelection();
    const col = st.col;
    if (all) this.writeCell(st.row, st.ch, [0, 0, 0, 0, 0]);
    else if (col === 0) this.writeCell(st.row, st.ch, [0, 0]);
    else if (col <= 2) this.writeCell(st.row, st.ch, [undefined, 0]);
    else if (col <= 4) this.writeCell(st.row, st.ch, [undefined, undefined, 0]);
    else this.writeCell(st.row, st.ch, [undefined, undefined, undefined, 0, 0]);
    this.advance();
  }

  insertRow(remove = false) {
    const st = this.state, p = this.pat;
    this.pushUndo();
    const d = p.data;
    if (remove) {
      if (st.row === 0) return;
      for (let r = st.row - 1; r < p.rows - 1; r++) d.copyWithin(this.cellOffset(r, st.ch), this.cellOffset(r + 1, st.ch), this.cellOffset(r + 1, st.ch) + CELL);
      d.fill(0, this.cellOffset(p.rows - 1, st.ch), this.cellOffset(p.rows - 1, st.ch) + CELL);
      st.row--;
    } else {
      for (let r = p.rows - 1; r > st.row; r--) d.copyWithin(this.cellOffset(r, st.ch), this.cellOffset(r - 1, st.ch), this.cellOffset(r - 1, st.ch) + CELL);
      d.fill(0, this.cellOffset(st.row, st.ch), this.cellOffset(st.row, st.ch) + CELL);
    }
    this.patternChanged();
    this.updatePosition();
  }

  selectionRect() {
    const s = this.state.selection;
    if (!s || s.pattern !== this.state.pattern) return null;
    return {
      r0: Math.min(s.r0, s.r1), r1: Math.max(s.r0, s.r1),
      c0: Math.min(s.c0, s.c1), c1: Math.max(s.c0, s.c1),
    };
  }

  extendSelection(dRow, dCh) {
    const st = this.state;
    if (!st.selection || st.selection.pattern !== st.pattern) {
      st.selection = { pattern: st.pattern, r0: st.row, c0: st.ch, r1: st.row, c1: st.ch };
    }
    this.setCursor({ row: Math.max(0, Math.min(this.pat.rows - 1, st.row + dRow)), ch: Math.max(0, Math.min(this.song.channels - 1, st.ch + dCh)) });
    st.selection.r1 = st.row;
    st.selection.c1 = st.ch;
  }

  copySelection(cut = false) {
    const r = this.selectionRect() || { r0: this.state.row, r1: this.state.row, c0: this.state.ch, c1: this.state.ch };
    const rows = r.r1 - r.r0 + 1, chans = r.c1 - r.c0 + 1;
    const data = new Uint8Array(rows * chans * CELL);
    const d = this.pat.data;
    for (let y = 0; y < rows; y++) for (let x = 0; x < chans; x++) {
      const o = this.cellOffset(r.r0 + y, r.c0 + x);
      data.set(d.subarray(o, o + CELL), (y * chans + x) * CELL);
    }
    this.clipboard = { rows, chans, data };
    if (cut) this.clearSelection(r);
    this.status(`${cut ? 'Cut' : 'Copied'} ${rows} row${rows > 1 ? 's' : ''} × ${chans} channel${chans > 1 ? 's' : ''}.`);
  }

  clearSelection(r = this.selectionRect()) {
    if (!r) return;
    this.pushUndo();
    for (let y = r.r0; y <= r.r1; y++) for (let x = r.c0; x <= r.c1; x++) {
      const o = this.cellOffset(y, x);
      this.pat.data.fill(0, o, o + CELL);
    }
    this.patternChanged();
  }

  paste() {
    const cb = this.clipboard;
    if (!cb) return;
    const st = this.state, p = this.pat;
    this.pushUndo();
    for (let y = 0; y < cb.rows && st.row + y < p.rows; y++) {
      for (let x = 0; x < cb.chans && st.ch + x < this.song.channels; x++) {
        const o = this.cellOffset(st.row + y, st.ch + x);
        p.data.set(cb.data.subarray((y * cb.chans + x) * CELL, (y * cb.chans + x + 1) * CELL), o);
      }
    }
    this.patternChanged();
  }

  transpose(semis) {
    const r = this.selectionRect() || { r0: this.state.row, r1: this.state.row, c0: this.state.ch, c1: this.state.ch };
    this.pushUndo();
    for (let y = r.r0; y <= r.r1; y++) for (let x = r.c0; x <= r.c1; x++) {
      const o = this.cellOffset(y, x);
      const n = this.pat.data[o];
      if (n && n !== NOTE_OFF) this.pat.data[o] = Math.max(1, Math.min(96, n + semis));
    }
    this.patternChanged();
  }

  // ------------------------------------------------------------------
  // Orders / patterns

  ordersChanged(patternsAdded = false) {
    if (patternsAdded) this.engine.setPatterns(this.song.patterns);
    this.engine.setOrders(this.song.orders, this.song.restart);
    this.gotoOrder(this.state.order);
    this.changed();
  }

  orderAction(action) {
    const s = this.song, st = this.state;
    switch (action) {
      case 'order-insert':
        if (s.orders.length >= 256) return;
        s.orders.splice(st.order + 1, 0, s.orders[st.order]);
        st.order++;
        if (s.restart > st.order) s.restart++;
        return this.ordersChanged();
      case 'order-delete':
        if (s.orders.length <= 1) return;
        s.orders.splice(st.order, 1);
        if (st.order >= s.orders.length) st.order = s.orders.length - 1;
        if (s.restart >= s.orders.length) s.restart = 0;
        return this.ordersChanged();
      case 'order-prev-pat':
      case 'order-next-pat': {
        const v = Math.max(0, Math.min(255, s.orders[st.order] + (action === 'order-next-pat' ? 1 : -1)));
        const added = v >= s.patterns.length;
        s.orders[st.order] = v;
        ensurePattern(s, v);
        return this.ordersChanged(added);
      }
      case 'pattern-new':
      case 'pattern-clone': {
        if (s.patterns.length >= 256) return this.toast('Maximum 256 patterns', 'error');
        const src = this.pat;
        const np = action === 'pattern-clone' ? { rows: src.rows, data: src.data.slice() } : createPattern(src.rows, s.channels);
        s.patterns.push(np);
        s.orders[st.order] = s.patterns.length - 1;
        return this.ordersChanged(true);
      }
      case 'set-restart':
        s.restart = st.order;
        return this.ordersChanged();
    }
  }

  // ------------------------------------------------------------------
  // Transport

  async play(mode) {
    await this.engine.start();
    const st = this.state;
    this.state.followActive = st.follow;
    if (mode === 'pattern') this.engine.play('pattern', st.order, 0, st.pattern);
    else this.engine.play('song', st.order, 0);
  }

  stop() {
    this.engine.stop();
  }

  toggleMute(ch) {
    this.mutes[ch] = !this.mutes[ch];
    this.engine.mute(ch, this.mutes[ch]);
    this.editor.invalidate();
  }

  soloChannel(ch) {
    const solo = this.mutes.every((m, i) => (i === ch ? !m : m));
    this.mutes = this.mutes.map((_, i) => (solo ? false : i !== ch));
    this.mutes.forEach((m, i) => this.engine.mute(i, m));
    this.editor.invalidate();
  }

  bindEngine() {
    let lastOrder = -1;
    this.engine.addEventListener('row', (e) => {
      const m = e.detail;
      this.playPos = m;
      const st = this.state;
      if (st.followActive) {
        st.order = m.order;
        st.pattern = m.pattern;
        ensurePattern(this.song, st.pattern);
        st.row = Math.min(m.row, this.pat.rows - 1);
      }
      if (m.order !== lastOrder) {
        lastOrder = m.order;
        this.renderOrders();
        this.refreshSongPanel();
      }
      this.updatePosition();
      this.editor.invalidate();
    });
    this.engine.addEventListener('levels', (e) => this.editor.setLevels(e.detail.peaks));
    this.engine.addEventListener('stopped', () => { lastOrder = -1; this.state.followActive = false; this.updatePosition(); this.renderOrders(); this.editor.invalidate(); });
  }

  // ------------------------------------------------------------------
  // Files

  async openSongFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const song = loadSongFile(buf, file.name);
      if (!song.title || song.title === 'untitled') song.title = file.name.replace(/\.[^.]+$/, '').slice(0, 20);
      await this.switchSong(song, { edited: true });
      this.toast(`Loaded ${file.name} (${song.format.toUpperCase()}, ${song.channels} ch)`);
      this.status(`${song.title} – press Enter to play.`);
    } catch (e) {
      console.error(e);
      this.toast(`Could not load ${file.name}: ${e.message}`, 'error');
    }
  }

  exportSong(format) {
    const { data, warnings } = saveSongFile(this.song, format);
    for (const w of warnings) this.toast(w, 'warn');
    return data;
  }

  download(format) {
    const data = this.exportSong(format);
    const name = (this.song.title || 'untitled').replace(/[^\w\- .]+/g, '_').trim() || 'untitled';
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.${format}`;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async saveCloud(asNew = false) {
    if (!this.user) { this.auth.open(); return null; }
    try {
      const data = this.exportSong('xm');
      const name = this.song.title || 'untitled';
      const id = asNew ? null : this.serverSong?.id;
      let r;
      try {
        r = await api.saveSong({ id, name, format: 'xm', data });
      } catch (e) {
        // The song isn't ours (anymore) – e.g. deleted, or signed in as someone else: save a new one.
        if (!id || !/not found/i.test(e.message)) throw e;
        r = await api.saveSong({ id: null, name, format: 'xm', data });
      }
      this.serverSong = { id: r.id, name };
      // Saved in the account: the local "unsaved work" copy is no longer needed.
      const draft = this.draftId;
      this.dirty = false;
      this.draftId = null;
      clearTimeout(this.saveTimer);
      if (draft) await deleteDraft(draft);
      await this.autosave();
      this.toast(`Saved "${name}" to My songs`);
      return this.serverSong;
    } catch (e) {
      this.toast(e.message, 'error');
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Bindings

  bindUi() {
    const actions = {
      new: () => this.switchSong(newSong()),
      open: () => $('#file-song').click(),
      demo: () => this.switchSong(demoSong()),
      help: () => $('#help-dialog').showModal(),
      'download-xm': () => this.download('xm'),
      'download-mod': () => this.download('mod'),
      'save-cloud': () => this.saveCloud(false),
      'save-cloud-new': () => this.saveCloud(true),
      'my-songs': () => this.songsDialog.open(),
      playlists: () => this.playlists.manager.open(),
      'play-song': () => this.play('song'),
      'play-pattern': () => this.play('pattern'),
      stop: () => this.stop(),
      'toggle-edit': () => { this.state.edit = !this.state.edit; this.updatePosition(); this.editor.invalidate(); },
      'load-sample': () => $('#file-sample').click(),
      'clear-instrument': () => {
        const ins = this.currentInstrument();
        if (!ins || !confirm(`Clear instrument ${hex2(this.state.instrument)}?`)) return;
        this.song.instruments[this.state.instrument - 1] = createInstrument();
        this.instrumentChanged();
        this.renderInstList();
        this.renderInstrument();
      },
      preview: () => this.preview(),
    };
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;
      if (a.startsWith('order-') || a.startsWith('pattern-') || a === 'set-restart') this.orderAction(a);
      else actions[a]?.();
      btn.closest('.dropdown')?.classList.remove('open');
      if (!btn.closest('dialog') && !['open', 'load-sample', 'help', 'my-songs', 'playlists'].includes(a)) $('#pattern').focus();
    });

    // dropdown
    document.querySelectorAll('.dropdown-toggle').forEach((t) => t.addEventListener('click', (e) => {
      e.stopPropagation();
      t.parentElement.classList.toggle('open');
    }));
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.dropdown')) document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
    });

    $('#file-song').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.openSongFile(f); });
    $('#file-sample').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.loadSampleFile(f); });

    const num = (el, min, max, fn) => el.addEventListener('change', () => {
      let v = Math.round(Number(el.value));
      if (!Number.isFinite(v)) v = min;
      v = Math.max(min, Math.min(max, v));
      el.value = v;
      fn(v);
    });
    $('#song-title').addEventListener('input', (e) => { this.song.title = e.target.value; this.changed(); });
    num($('#song-bpm'), 32, 255, (v) => { this.song.bpm = v; this.engine.setParams({ bpm: v }); this.changed(); });
    num($('#song-speed'), 1, 31, (v) => { this.song.speed = v; this.engine.setParams({ speed: v }); this.changed(); });
    num($('#song-channels'), 1, 32, (v) => {
      if (this.song.format === 'mod' && v % 2) v += 1;
      if (v < this.song.channels && !confirm(`Remove channels ${v + 1}–${this.song.channels}? Notes in them will be deleted.`)) { this.refreshSongPanel(); return; }
      setChannelCount(this.song, v);
      this.mutes = new Array(v).fill(false);
      this.state.ch = Math.min(this.state.ch, v - 1);
      this.undo = []; this.redo = [];
      this.engine.loadSong(this.song);
      this.refreshAll();
      this.changed();
    });
    num($('#pattern-rows'), 1, 256, (v) => {
      this.pushUndo();
      resizePattern(this.song, this.state.pattern, v);
      this.undo = []; // pattern size changed, keep history simple
      this.setCursor({ row: this.state.row });
      this.patternChanged();
    });
    num($('#edit-octave'), 0, 7, (v) => { this.state.octave = v; this.updatePosition(); });
    num($('#edit-step'), 0, 16, (v) => { this.state.step = v; });
    $('#follow').addEventListener('change', (e) => { this.state.follow = e.target.checked; this.state.followActive = e.target.checked && this.engine.playing; });
    const vol = $('#master-volume');
    const savedVol = local.get('dt.volume');
    if (savedVol !== null) vol.value = savedVol;
    this.engine.setVolume(vol.value / 100);
    vol.addEventListener('input', () => { this.engine.setVolume(vol.value / 100); local.set('dt.volume', vol.value); });

    $('#orders').addEventListener('click', (e) => {
      const el = e.target.closest('.order');
      if (el) this.gotoOrder(+el.dataset.index);
    });

    $('#inst-list').addEventListener('click', (e) => {
      const el = e.target.closest('.inst');
      if (el) this.selectInstrument(+el.dataset.index);
    });
    $('#inst-list').addEventListener('dblclick', () => $('#inst-name').focus());
    $('#inst-name').addEventListener('input', (e) => {
      const ins = this.ensureInstrument(this.state.instrument);
      ins.name = e.target.value;
      const el = $('#inst-list').children[this.state.instrument - 1];
      if (el) el.querySelector('.name').textContent = ins.name;
      this.changed();
    });
    $('#sample-select').addEventListener('change', (e) => { this.state.sample = +e.target.value; this.renderInstrument(); });

    const smpField = (id, key, min, max) => num($('#' + id), min, max, (v) => {
      const smp = this.currentInstrument()?.samples[this.state.sample];
      if (!smp) return;
      smp[key] = v;
      if (key === 'loopStart' || key === 'loopLength') {
        smp.loopStart = Math.min(smp.loopStart, Math.max(0, smp.data.length - 1));
        smp.loopLength = Math.min(smp.loopLength, smp.data.length - smp.loopStart);
        if (smp.loopLength > 0 && !smp.loopType) smp.loopType = 1;
      }
      if (key === 'loopType' && v && !smp.loopLength) { smp.loopStart = 0; smp.loopLength = smp.data.length; }
      this.instrumentChanged();
      this.renderInstrument();
    });
    smpField('smp-volume', 'volume', 0, 64);
    smpField('smp-panning', 'panning', 0, 255);
    smpField('smp-finetune', 'finetune', -128, 127);
    smpField('smp-relnote', 'relativeNote', -96, 95);
    smpField('smp-loopstart', 'loopStart', 0, 1e8);
    smpField('smp-looplen', 'loopLength', 0, 1e8);
    smpField('smp-looptype', 'loopType', 0, 2);
    num($('#inst-fadeout'), 0, 4095, (v) => { const ins = this.currentInstrument(); if (ins) { ins.fadeout = v; this.instrumentChanged(); } });
    $('#inst-volenv').addEventListener('change', (e) => {
      const ins = this.currentInstrument();
      if (!ins) return;
      ins.volEnv.on = e.target.checked;
      if (ins.volEnv.on && ins.volEnv.points.length < 2) {
        ins.volEnv.points = [[0, 64], [1, 64]];
        ins.volEnv.sustain = true;
        ins.volEnv.sustainPoint = 1;
        if (!ins.fadeout) ins.fadeout = 1024;
      }
      this.instrumentChanged();
      this.renderInstrument();
    });

    window.addEventListener('resize', () => this.drawWaveform());
  }

  bindDragDrop() {
    const overlay = $('#drop-overlay');
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; overlay.hidden = false; } });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const f = e.dataTransfer.files[0];
      if (!f) return;
      const ext = f.name.toLowerCase().split('.').pop();
      if (['mod', 'xm', 'nst'].includes(ext) || f.name.toLowerCase().startsWith('mod.')) this.openSongFile(f);
      else if (['s3m', 'stm', 'it'].includes(ext)) this.toast(`.${ext.toUpperCase()} support is coming – MOD and XM work today.`, 'warn');
      else this.loadSampleFile(f);
    });
  }

  bindKeyboard() {
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => {
      for (const ch of this.held.values()) this.engine.jamOff(ch);
      this.held.clear();
    });
  }

  isTyping(e) {
    const t = e.target;
    if (t.closest?.('dialog[open]')) return true;
    return t instanceof HTMLInputElement && !['checkbox', 'range', 'button'].includes(t.type) ||
      t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable;
  }

  onKeyDown(e) {
    if (document.querySelector('dialog[open]')) return;
    if (this.isTyping(e)) {
      if (e.key === 'Escape' || e.key === 'Enter') { e.target.blur?.(); $('#pattern').focus(); }
      return;
    }
    const st = this.state;
    const mod = e.ctrlKey || e.metaKey;
    const code = e.code;

    // --- global shortcuts
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      const handled = {
        z: () => (e.shiftKey ? this.applyHistory(this.redo, this.undo) : this.applyHistory(this.undo, this.redo)),
        y: () => this.applyHistory(this.redo, this.undo),
        c: () => this.copySelection(false),
        x: () => this.copySelection(true),
        v: () => this.paste(),
        a: () => { st.selection = { pattern: st.pattern, r0: 0, c0: 0, r1: this.pat.rows - 1, c1: this.song.channels - 1 }; this.editor.invalidate(); },
        s: () => (this.user ? this.saveCloud(false) : this.download('xm')),
        o: () => $('#file-song').click(),
        arrowup: () => this.selectInstrument(st.instrument - 1),
        arrowdown: () => this.selectInstrument(st.instrument + 1),
        arrowleft: () => this.gotoOrder(st.order - 1),
        arrowright: () => this.gotoOrder(st.order + 1),
      }[k];
      if (handled) { e.preventDefault(); handled(); }
      return;
    }

    if (e.altKey && (code === 'ArrowUp' || code === 'ArrowDown')) {
      e.preventDefault();
      if (st.edit) this.transpose(code === 'ArrowUp' ? (e.shiftKey ? 12 : 1) : (e.shiftKey ? -12 : -1));
      return;
    }

    const fkey = /^F([1-8])$/.exec(code);
    if (fkey) { e.preventDefault(); st.octave = +fkey[1] - 1; $('#edit-octave').value = st.octave; this.updatePosition(); return; }

    switch (code) {
      case 'Space':
        e.preventDefault();
        if (e.repeat) return;
        if (this.engine.playing) this.stop();
        else { st.edit = !st.edit; this.updatePosition(); this.editor.invalidate(); }
        return;
      case 'Enter': case 'NumpadEnter':
        e.preventDefault();
        if (!e.repeat) this.play(e.shiftKey ? 'pattern' : 'song');
        return;
      case 'Escape':
        e.preventDefault();
        if (st.selection) { st.selection = null; this.editor.invalidate(); }
        else this.stop();
        return;
      case 'ArrowUp': case 'ArrowDown': {
        e.preventDefault();
        const d = code === 'ArrowUp' ? -1 : 1;
        if (e.shiftKey) this.extendSelection(d, 0);
        else { st.selection = null; this.moveRow(d, true); }
        return;
      }
      case 'ArrowLeft': case 'ArrowRight': {
        e.preventDefault();
        const d = code === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) this.extendSelection(0, d);
        else this.moveCol(d);
        return;
      }
      case 'Tab':
        e.preventDefault();
        this.moveChannel(e.shiftKey ? -1 : 1);
        return;
      case 'PageUp': case 'PageDown':
        e.preventDefault();
        if (e.shiftKey) this.extendSelection(code === 'PageUp' ? -16 : 16, 0);
        else this.moveRow(code === 'PageUp' ? -16 : 16, false);
        return;
      case 'Home': e.preventDefault(); this.setCursor({ row: 0 }); return;
      case 'End': e.preventDefault(); this.setCursor({ row: this.pat.rows - 1 }); return;
      case 'Delete':
        e.preventDefault();
        if (st.edit || st.selection) this.clearField(e.shiftKey);
        return;
      case 'Insert':
        e.preventDefault();
        if (st.edit) this.insertRow(false);
        return;
      case 'Backspace':
        e.preventDefault();
        if (st.edit) this.insertRow(true);
        return;
    }

    if (st.col === 0) {
      if (KEYOFF_KEYS.has(code)) {
        e.preventDefault();
        if (st.edit && !e.repeat) this.enterNote(NOTE_OFF);
        return;
      }
      if (code in NOTE_KEYS) {
        e.preventDefault();
        if (e.repeat) return;
        const note = st.octave * 12 + NOTE_KEYS[code] + 1;
        if (note > 96) return;
        this.noteDown(code, note);
      }
      return;
    }

    if (st.edit) {
      const v = hexFromCode(code);
      if (this.enterHex(v, code)) e.preventDefault();
    } else if (code in NOTE_KEYS && !e.repeat) {
      // outside edit mode the keyboard always plays, regardless of column
      e.preventDefault();
      const note = st.octave * 12 + NOTE_KEYS[code] + 1;
      if (note <= 96) this.noteDown(code, note);
    }
  }

  noteDown(code, note) {
    const st = this.state;
    this.engine.start();
    let ch = st.ch;
    if (!st.edit) {
      // chord: give each held key its own channel
      const used = new Set(this.held.values());
      for (let i = 0; i < this.song.channels; i++) {
        const c = (st.ch + i) % this.song.channels;
        if (!used.has(c)) { ch = c; break; }
      }
    }
    this.held.set(code, ch);
    this.engine.jam(ch, note, st.instrument);
    if (st.edit) this.enterNote(note);
  }

  onKeyUp(e) {
    const ch = this.held.get(e.code);
    if (ch === undefined) return;
    this.held.delete(e.code);
    if ([...this.held.values()].includes(ch)) return;
    const ins = this.currentInstrument();
    const smp = ins?.samples[0];
    // Let one-shot samples (drums, plucks) ring out; release sustained ones.
    if (ins && (ins.volEnv.on || (smp && smp.loopType))) this.engine.jamOff(ch);
  }
}

const app = new App();
window.discotracker = app; // handy for debugging in the console
app.init();
