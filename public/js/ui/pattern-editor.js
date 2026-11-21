// Canvas pattern editor in the classic "cursor row in the middle" style.
import { CELL, NOTE_OFF, noteName, FX_CHARS } from '../song.js';

// sub-column -> character offset inside a channel ("C-4 01 40 A0F")
export const COL_X = [0, 4, 5, 7, 8, 10, 11, 12];
export const COL_W = [3, 1, 1, 1, 1, 1, 1, 1];
const CH_CHARS = 14;
const SB_H = 12; // horizontal scrollbar height
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
    this.scrollX = 0; // horizontal scroll in pixels
    this.revealCh = -1; // cursor channel last scrolled into view
    this.wheelY = 0; // accumulated vertical wheel delta
    this.sbDrag = null;
    this.sbHover = false;
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
      boundary: cssVar('--pe-boundary', '#ff6fb5'),
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
    this.fontFamily = cssVar('--mono', 'ui-monospace, Menlo, Consolas, monospace');
    this.font = `${this.fontSize}px ${this.fontFamily}`;
    this.ctx.font = this.font;
    this.charW = Math.ceil(this.ctx.measureText('0').width * 10) / 10;
    this.invalidate();
  }

  get rowNumW() { return this.charW * 4; }
  get chW() { return this.charW * CH_CHARS; }

  get viewW() { return this.width - this.rowNumW; }
  get contentW() { return (this.app.song?.channels || 0) * this.chW; }
  get maxScroll() { return Math.max(0, this.contentW - this.viewW); }
  get hasScrollbar() { return this.maxScroll > 0; }

  /** Scroll so the cursor's channel is visible (after keyboard moves, clicks and edits). */
  revealCursor() { this.revealCh = -1; this.invalidate(); }

  scrollTo(x) {
    const v = Math.max(0, Math.min(this.maxScroll, x));
    if (v !== this.scrollX) { this.scrollX = v; this.invalidate(); }
  }

  /** Channels that are (partly) on screen; x of channel ch is x0 + ch * chW - scrollX. */
  visibleChannels() {
    if (!this.app.song) return { first: 0, count: 0 };
    const n = this.app.song.channels;
    const ch = this.app.state.ch;
    if (ch !== this.revealCh) {
      this.revealCh = ch;
      const l = ch * this.chW, r = l + this.chW;
      if (l < this.scrollX) this.scrollX = l;
      else if (r > this.scrollX + this.viewW) this.scrollX = r - this.viewW;
    }
    this.scrollX = Math.max(0, Math.min(this.scrollX, this.maxScroll));
    const first = Math.min(n - 1, Math.floor(this.scrollX / this.chW));
    const last = Math.min(n - 1, Math.floor((this.scrollX + this.viewW - 1) / this.chW));
    return { first, count: last - first + 1 };
  }

  chX(ch) { return this.rowNumW + ch * this.chW - this.scrollX; }

  /**
   * What line `i` rows from the cursor shows: { order, pattern, row, rows } or null.
   * In continuous view it runs on into the next/previous order positions.
   */
  lineAt(i) {
    const { song, state: st } = this.app;
    const rowsOf = (o) => song.patterns[song.orders[o]]?.rows ?? 0;
    let order = st.order, row = st.row + i;
    if (!this.app.continuous) {
      const rows = song.patterns[st.pattern]?.rows ?? 0;
      return row >= 0 && row < rows ? { order, pattern: st.pattern, row, rows } : null;
    }
    while (row >= rowsOf(order)) {
      row -= rowsOf(order);
      if (++order >= song.orders.length) return null;
    }
    while (row < 0) {
      if (--order < 0) return null;
      row += rowsOf(order);
    }
    // the cursor's own line always belongs to the pattern being edited
    const pattern = order === st.order ? st.pattern : song.orders[order];
    if (!song.patterns[pattern]) return null;
    return { order, pattern, row, rows: song.patterns[pattern].rows };
  }

  /** Scrollbar geometry: track x/width and thumb x/width. */
  scrollbar() {
    const x = this.rowNumW, w = this.width - x - 2;
    const tw = Math.max(30, w * this.viewW / this.contentW);
    const tx = x + (w - tw) * (this.maxScroll ? this.scrollX / this.maxScroll : 0);
    return { x, w, tx, tw, y: this.height - SB_H };
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
    const pp = app.engine.playing && app.playPos && !st.followActive ? app.playPos : null;
    const n = song.channels;

    // Which order position / pattern / row each visible line shows. In continuous view the
    // neighbouring order positions are shown above and below the current pattern.
    const lines = [];
    for (let i = -rowsAbove; i <= rowsBelow; i++) {
      const L = this.lineAt(i);
      if (L) lines.push({ i, y: centerY + i * rh, ...L });
    }

    // row backgrounds
    for (const L of lines) {
      const r = L.row;
      let bg = null;
      if (L.i === 0) bg = st.edit ? C.editRow : C.cursorRow;
      else if (r % 16 === 0) bg = C.bar;
      else if (r % 4 === 0) bg = C.beat;
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, L.y, W, rh); }
      if (pp && pp.row === r && (pp.order === L.order || (L.order === st.order && pp.pattern === L.pattern))) {
        ctx.fillStyle = C.play; ctx.fillRect(0, L.y, W, rh);
      }
    }

    // channel area is clipped so partly scrolled channels don't spill over the row numbers
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 - cw * 0.5, 0, W - x0 + cw * 0.5, H);
    ctx.clip();

    // selection (only in the current pattern)
    if (sel && sel.pattern === st.pattern) {
      const r0 = Math.min(sel.r0, sel.r1), r1 = Math.max(sel.r0, sel.r1);
      const c0 = Math.min(sel.c0, sel.c1), c1 = Math.max(sel.c0, sel.c1);
      const vc0 = Math.max(c0, first), vc1 = Math.min(c1, first + count - 1);
      if (vc0 <= vc1) {
        const ya = Math.max(top, centerY + (r0 - st.row) * rh);
        const yb = Math.min(H, centerY + (r1 - st.row + 1) * rh);
        if (yb > ya) {
          ctx.fillStyle = C.sel;
          ctx.fillRect(this.chX(vc0), ya, (vc1 - vc0 + 1) * this.chW - cw, yb - ya);
        }
      }
    }

    // cells; other patterns than the current one are drawn a bit faded
    for (const L of lines) {
      const d = song.patterns[L.pattern].data;
      const y = L.y + textOff;
      ctx.globalAlpha = L.order === st.order ? 1 : 0.55;
      for (let k = 0; k < count; k++) {
        const ch = first + k;
        const o = (L.row * n + ch) * CELL;
        const x = this.chX(ch);
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
    ctx.globalAlpha = 1;

    // channel separators
    ctx.fillStyle = C.sep;
    for (let k = 0; k <= count; k++) ctx.fillRect(this.chX(first + k) - cw * 0.5, top, 1, H - top);

    // cursor
    if (st.ch >= first && st.ch < first + count) {
      const x = this.chX(st.ch) + COL_X[st.col] * cw;
      ctx.strokeStyle = C.cursor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 1, centerY + 0.5, COL_W[st.col] * cw + 2, rh - 1);
    }

    ctx.restore();

    // row numbers
    for (const L of lines) {
      ctx.globalAlpha = L.order === st.order ? 1 : 0.55;
      ctx.fillStyle = L.row % 4 === 0 ? C.headerText : C.rowNum;
      ctx.fillText(String(L.row).padStart(L.rows > 100 ? 3 : 2, '0'), cw * 0.5, L.y + textOff);
    }
    ctx.globalAlpha = 1;

    // pattern boundaries: a line where a pattern starts, with its order position and pattern number
    ctx.font = `${Math.max(9, this.fontSize - 3)}px ${this.fontFamily}`;
    for (const L of lines) {
      if (!app.continuous || L.row !== 0 || L.y <= top) continue;
      ctx.fillStyle = C.boundary;
      ctx.fillRect(0, L.y - 1, W, 2);
      const label = `pos ${String(L.order).padStart(2, '0')} · pat ${String(L.pattern).padStart(2, '0')}`;
      // The tag goes on the faded side of the line, so it never hides notes in the pattern being edited.
      const tw = ctx.measureText(label).width + 8, th = Math.max(11, this.fontSize - 1);
      const ty = L.order === st.order ? L.y - th : L.y;
      ctx.fillRect(W - tw - 6, ty, tw, th);
      ctx.fillStyle = C.bg;
      ctx.fillText(label, W - tw - 2, ty + th - 3);
    }
    ctx.font = this.font;

    // header
    ctx.fillStyle = C.header;
    ctx.fillRect(0, 0, W, top);
    ctx.fillStyle = C.rowNum;
    ctx.fillText(String(st.pattern).padStart(2, '0'), cw * 0.5, 17);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 - cw * 0.5, 0, W - x0 + cw * 0.5, top);
    ctx.clip();
    for (let k = 0; k < count; k++) {
      const ch = first + k;
      const x = this.chX(ch);
      const muted = app.mutes[ch];
      if (muted) { ctx.fillStyle = C.muted; ctx.fillRect(x - cw * 0.5, 0, this.chW, top); }
      ctx.fillStyle = muted ? C.off : C.headerText;
      ctx.fillText(muted ? `CH${ch + 1} MUTE` : `CH${ch + 1}`, x, 15);
      const lv = Math.min(1, this.levels[ch] || 0);
      ctx.fillStyle = C.vu;
      ctx.fillRect(x, top - 5, (this.chW - cw * 1.5) * lv, 3);
    }
    ctx.restore();

    // horizontal scrollbar (only when not all channels fit)
    if (this.hasScrollbar) {
      const sb = this.scrollbar();
      ctx.fillStyle = C.header;
      ctx.fillRect(0, sb.y, W, SB_H);
      ctx.globalAlpha = this.sbDrag ? 0.95 : this.sbHover ? 0.8 : 0.55;
      ctx.fillStyle = C.headerText;
      const r = 3, ty = sb.y + 3, th = SB_H - 6;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(sb.tx, ty, sb.tw, th, r) : ctx.rect(sb.tx, ty, sb.tw, th);
      ctx.fill();
      ctx.globalAlpha = 1;
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
    const k = Math.floor((x - this.chX(first) + this.charW * 0.5) / this.chW);
    const ch = Math.max(first, Math.min(first + count - 1, first + k));
    const cx = (x - this.chX(ch)) / this.charW;
    let col = 0;
    for (let i = 0; i < COL_X.length; i++) if (cx >= COL_X[i] - 0.5) col = i;
    const row = this.app.state.row + Math.floor((y - centerY) / this.rowH);
    return { header: y < top, scrollbar: this.hasScrollbar && y >= this.height - SB_H, x, ch, col, row };
  }

  bindMouse() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.focus();
      const h = this.hit(e);
      if (h.scrollbar) {
        const sb = this.scrollbar();
        // click on the track jumps there, then the thumb follows the pointer
        if (h.x < sb.tx || h.x > sb.tx + sb.tw) this.scrollTo((h.x - sb.x - sb.tw / 2) / (sb.w - sb.tw) * this.maxScroll);
        this.sbDrag = { x: h.x, scroll: this.scrollX };
        c.setPointerCapture(e.pointerId);
        this.invalidate();
        return;
      }
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
      if (this.sbDrag) {
        const sb = this.scrollbar();
        const x = e.clientX - c.getBoundingClientRect().left;
        this.scrollTo(this.sbDrag.scroll + (x - this.sbDrag.x) / Math.max(1, sb.w - sb.tw) * this.maxScroll);
        return;
      }
      if (!this.dragging) {
        const over = this.hasScrollbar && e.clientY - c.getBoundingClientRect().top >= this.height - SB_H;
        if (over !== this.sbHover) { this.sbHover = over; c.style.cursor = over ? 'default' : ''; this.invalidate(); }
        return;
      }
      const h = this.hit(e);
      const pat = this.app.song.patterns[this.app.state.pattern];
      const row = Math.max(0, Math.min(pat.rows - 1, h.row));
      if (row !== this.dragStart.row || h.ch !== this.dragStart.ch) {
        this.app.state.selection = { pattern: this.app.state.pattern, c0: this.dragStart.ch, r0: this.dragStart.row, c1: h.ch, r1: row };
        this.invalidate();
      }
    });
    c.addEventListener('pointerleave', () => {
      if (this.sbHover && !this.sbDrag) { this.sbHover = false; c.style.cursor = ''; this.invalidate(); }
    });
    c.addEventListener('pointerup', (e) => {
      if (this.sbDrag) { this.sbDrag = null; this.invalidate(); return; }
      if (!this.dragging) return;
      this.dragging = false;
      const h = this.hit(e);
      if (!this.app.state.selection) {
        // simple click: move cursor to the clicked row
        // a click on a line of the next/previous pattern (continuous view) moves there
        const L = this.lineAt(h.row - this.app.state.row);
        if (L && L.order !== this.app.state.order) {
          this.app.gotoOrder(L.order);
          this.app.setCursor({ row: L.row });
          return;
        }
        const pat = this.app.song.patterns[this.app.state.pattern];
        this.app.setCursor({ row: Math.max(0, Math.min(pat.rows - 1, h.row)) });
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Trackpads send many small pixel deltas, mouse wheels fewer big ones: scroll by distance,
      // not one step per event, and never wrap around.
      const unit = e.deltaMode === 1 ? this.rowH : e.deltaMode === 2 ? this.height : 1;
      let dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      if (Math.abs(dx) > Math.abs(dy)) {
        this.scrollTo(this.scrollX + dx);
      } else if (dy) {
        if (Math.sign(dy) !== Math.sign(this.wheelY)) this.wheelY = 0;
        this.wheelY += dy;
        const steps = Math.trunc(this.wheelY / this.rowH);
        if (steps) {
          this.wheelY -= steps * this.rowH;
          this.app.moveRow(steps, false);
        }
      }
    }, { passive: false });
  }
}
