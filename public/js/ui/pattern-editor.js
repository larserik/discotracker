// Canvas pattern editor in the classic "cursor row in the middle" style.
import { CELL, NOTE_OFF, noteName, FX_CHARS } from '../song.js';

// sub-column -> character offset inside a channel ("C-4 01 40 A0F")
export const COL_X = [0, 4, 5, 7, 8, 10, 11, 12];
export const COL_W = [3, 1, 1, 1, 1, 1, 1, 1];
const CH_CHARS = 14;
const VOLCMD = { 6: '-', 7: '+', 8: 'D', 9: 'U', 10: 'S', 11: 'V', 12: 'P', 13: 'L', 14: 'R', 15: 'M' };
const HEX = '0123456789ABCDEF';
const hex2 = (v) => HEX[v >> 4] + HEX[v & 15];

export function volText(v) {
  if (!v) return '..';
  if (v >= 0x10 && v <= 0x50) return hex2(v - 0x10);
  const c = VOLCMD[v >> 4];
  return c ? c + HEX[v & 15] : '..';
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export class PatternEditor {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.app = app;
    this.ctx = canvas.getContext('2d');
    this.scrollCh = 0;
    this.dirty = true;
    this.levels = new Float32Array(32);
    this.fontSize = 14;
    this.rowH = 17;
    this.headerH = 26;
    this.dragging = false;
    this.readTheme();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.readTheme(); this.invalidate(); });
    this.resize();
    this.bindMouse();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.dirty && this.app.song) {
        this.dirty = false;
        try { this.draw(); } catch (e) { console.error(e); }
      }
    };
    requestAnimationFrame(loop);
  }

  readTheme() {
    this.colors = {
      bg: cssVar('--pe-bg', '#0d1124'),
      beat: cssVar('--pe-beat', '#141a36'),
      bar: cssVar('--pe-bar', '#1b2246'),
      cursorRow: cssVar('--pe-cursor-row', '#26305f'),
      editRow: cssVar('--pe-edit-row', '#4a1f3d'),
      cursor: cssVar('--pe-cursor', '#ffd23f'),
      sel: cssVar('--pe-sel', 'rgba(80,160,255,0.28)'),
      dim: cssVar('--pe-dim', '#3a4370'),
      rowNum: cssVar('--pe-rownum', '#7d87b8'),
      note: cssVar('--pe-note', '#e8ecff'),
      inst: cssVar('--pe-inst', '#ffd23f'),
      vol: cssVar('--pe-vol', '#5ef2a0'),
      fx: cssVar('--pe-fx', '#ff6fb5'),
      off: cssVar('--pe-off', '#ff8a5c'),
      header: cssVar('--pe-header', '#1b2246'),
      headerText: cssVar('--pe-header-text', '#c8cff5'),
      muted: cssVar('--pe-muted', '#5a2333'),
      vu: cssVar('--pe-vu', '#5ef2a0'),
      sep: cssVar('--pe-sep', '#262e58'),
      play: cssVar('--pe-play', 'rgba(94,242,160,0.18)'),
    };
  }

  invalidate() { this.dirty = true; }

  resize() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = Math.max(100, Math.floor(box.width));
    this.height = Math.max(100, Math.floor(box.height));
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fontSize = this.width < 520 ? 12 : 14;
    this.rowH = this.fontSize + 3;
    this.ctx.font = `${this.fontSize}px ${cssVar('--mono', 'ui-monospace, Menlo, Consolas, monospace')}`;
    this.charW = Math.ceil(this.ctx.measureText('0').width * 10) / 10;
    this.invalidate();
  }

  get rowNumW() { return this.charW * 4; }
  get chW() { return this.charW * CH_CHARS; }

  visibleChannels() {
    if (!this.app.song) return { first: 0, count: 0 };
    const n = this.app.song.channels;
    const fit = Math.max(1, Math.floor((this.width - this.rowNumW) / this.chW));
    const ch = this.app.state.ch;
    if (ch < this.scrollCh) this.scrollCh = ch;
    if (ch >= this.scrollCh + fit) this.scrollCh = ch - fit + 1;
    this.scrollCh = Math.max(0, Math.min(this.scrollCh, Math.max(0, n - fit)));
    return { first: this.scrollCh, count: Math.min(fit, n - this.scrollCh) };
  }

  setLevels(peaks) {
    let changed = false;
    for (let i = 0; i < peaks.length; i++) {
      const v = Math.max(peaks[i] * 1.6, this.levels[i] * 0.82);
      if (Math.abs(v - this.levels[i]) > 0.003) changed = true;
      this.levels[i] = v;
    }
    if (changed) this.invalidate();
  }

  draw() {
    const { ctx, colors: C, app } = this;
    const song = app.song;
    const st = app.state;
    const pat = song.patterns[st.pattern];
    const W = this.width, H = this.height, rh = this.rowH, cw = this.charW;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    if (!pat) return;

    const { first, count } = this.visibleChannels();
    const top = this.headerH;
    const centerY = top + Math.floor((H - top) / 2 / rh) * rh;
    const rowsAbove = Math.ceil((centerY - top) / rh);
    const rowsBelow = Math.ceil((H - centerY) / rh);
    const x0 = this.rowNumW;
    const textOff = Math.round((rh - this.fontSize) / 2 + this.fontSize * 0.8);
    const sel = st.selection;
    const playRow = app.engine.playing && app.playPos && app.playPos.pattern === st.pattern && !st.followActive ? app.playPos.row : -1;

    // row backgrounds
    for (let i = -rowsAbove; i <= rowsBelow; i++) {
      const r = st.row + i;
      if (r < 0 || r >= pat.rows) continue;
      const y = centerY + i * rh;
      let bg = null;
      if (i === 0) bg = st.edit ? C.editRow : C.cursorRow;
      else if (r % 16 === 0) bg = C.bar;
      else if (r % 4 === 0) bg = C.beat;
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, y, W, rh); }
      if (r === playRow) { ctx.fillStyle = C.play; ctx.fillRect(0, y, W, rh); }
    }

    // selection
    if (sel && sel.pattern === st.pattern) {
      const r0 = Math.min(sel.r0, sel.r1), r1 = Math.max(sel.r0, sel.r1);
      const c0 = Math.min(sel.c0, sel.c1), c1 = Math.max(sel.c0, sel.c1);
      const vc0 = Math.max(c0, first), vc1 = Math.min(c1, first + count - 1);
      if (vc0 <= vc1) {
        const ya = Math.max(top, centerY + (r0 - st.row) * rh);
        const yb = Math.min(H, centerY + (r1 - st.row + 1) * rh);
        if (yb > ya) {
          ctx.fillStyle = C.sel;
          ctx.fillRect(x0 + (vc0 - first) * this.chW, ya, (vc1 - vc0 + 1) * this.chW - cw, yb - ya);
        }
      }
    }

    // cells
    const n = song.channels;
    const d = pat.data;
    for (let i = -rowsAbove; i <= rowsBelow; i++) {
      const r = st.row + i;
      if (r < 0 || r >= pat.rows) continue;
      const y = centerY + i * rh + textOff;
      ctx.fillStyle = r % 4 === 0 ? C.headerText : C.rowNum;
      ctx.fillText(String(r).padStart(pat.rows > 100 ? 3 : 2, '0'), cw * 0.5, y);
      for (let k = 0; k < count; k++) {
        const ch = first + k;
        const o = (r * n + ch) * CELL;
        const x = x0 + k * this.chW;
        const note = d[o], ins = d[o + 1], vol = d[o + 2], fx = d[o + 3], par = d[o + 4];
        ctx.fillStyle = note === NOTE_OFF ? C.off : note ? C.note : C.dim;
        ctx.fillText(note ? noteName(note) : '···', x, y);
        ctx.fillStyle = ins ? C.inst : C.dim;
        ctx.fillText(ins ? hex2(ins) : '··', x + cw * 4, y);
        ctx.fillStyle = vol ? C.vol : C.dim;
        ctx.fillText(vol ? volText(vol) : '··', x + cw * 7, y);
        const hasFx = fx || par;
        ctx.fillStyle = hasFx ? C.fx : C.dim;
        ctx.fillText(hasFx ? FX_CHARS[fx] + hex2(par) : '···', x + cw * 10, y);
      }
    }

    // channel separators
    ctx.fillStyle = C.sep;
    for (let k = 0; k <= count; k++) ctx.fillRect(x0 + k * this.chW - cw * 0.5, top, 1, H - top);

    // cursor
    if (st.ch >= first && st.ch < first + count) {
      const x = x0 + (st.ch - first) * this.chW + COL_X[st.col] * cw;
      ctx.strokeStyle = C.cursor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 1, centerY + 0.5, COL_W[st.col] * cw + 2, rh - 1);
    }

    // header
    ctx.fillStyle = C.header;
    ctx.fillRect(0, 0, W, top);
    ctx.fillStyle = C.rowNum;
    ctx.fillText(String(st.pattern).padStart(2, '0'), cw * 0.5, 17);
    for (let k = 0; k < count; k++) {
      const ch = first + k;
      const x = x0 + k * this.chW;
      const muted = app.mutes[ch];
      if (muted) { ctx.fillStyle = C.muted; ctx.fillRect(x - cw * 0.5, 0, this.chW, top); }
      ctx.fillStyle = muted ? C.off : C.headerText;
      ctx.fillText(muted ? `CH${ch + 1} MUTE` : `CH${ch + 1}`, x, 15);
      const lv = Math.min(1, this.levels[ch] || 0);
      ctx.fillStyle = C.vu;
      ctx.fillRect(x, top - 5, (this.chW - cw * 1.5) * lv, 3);
    }
  }

  // --------------------------------------------------------------------
  // Mouse

  hit(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    const { first, count } = this.visibleChannels();
    const top = this.headerH;
    const centerY = top + Math.floor((this.height - top) / 2 / this.rowH) * this.rowH;
    const k = Math.floor((x - this.rowNumW + this.charW * 0.5) / this.chW);
    const ch = Math.max(first, Math.min(first + count - 1, first + k));
    const cx = (x - this.rowNumW - (ch - first) * this.chW) / this.charW;
    let col = 0;
    for (let i = 0; i < COL_X.length; i++) if (cx >= COL_X[i] - 0.5) col = i;
    const row = this.app.state.row + Math.floor((y - centerY) / this.rowH);
    return { header: y < top, ch, col, row };
  }

  bindMouse() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.focus();
      const h = this.hit(e);
      if (h.header) {
        if (e.button === 2) this.app.soloChannel(h.ch);
        else this.app.toggleMute(h.ch);
        return;
      }
      const pat = this.app.song.patterns[this.app.state.pattern];
      const row = Math.max(0, Math.min(pat.rows - 1, h.row));
      this.dragging = true;
      this.dragStart = { ch: h.ch, row };
      c.setPointerCapture(e.pointerId);
      this.app.setCursor({ ch: h.ch, col: h.col, row: this.app.state.row });
      this.app.state.selection = null;
      this.dragRowAnchor = row;
      this.invalidate();
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const h = this.hit(e);
      const pat = this.app.song.patterns[this.app.state.pattern];
      const row = Math.max(0, Math.min(pat.rows - 1, h.row));
      if (row !== this.dragStart.row || h.ch !== this.dragStart.ch) {
        this.app.state.selection = { pattern: this.app.state.pattern, c0: this.dragStart.ch, r0: this.dragStart.row, c1: h.ch, r1: row };
        this.invalidate();
      }
    });
    c.addEventListener('pointerup', (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      const h = this.hit(e);
      if (!this.app.state.selection) {
        // simple click: move cursor to the clicked row
        const pat = this.app.song.patterns[this.app.state.pattern];
        this.app.setCursor({ row: Math.max(0, Math.min(pat.rows - 1, h.row)) });
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        this.app.moveChannel(Math.sign(e.deltaX || e.deltaY));
      } else {
        this.app.moveRow(Math.sign(e.deltaY) * (Math.abs(e.deltaY) > 50 ? 2 : 1), true);
      }
    }, { passive: false });
  }
}
