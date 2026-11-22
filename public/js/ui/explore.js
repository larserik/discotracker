// Explore: search and browse public songs, playlists and people, and people's pages (/@handle).
// Also the router for the site's links: /explore, /@handle, /p/<token> (playlist), /s/<token> (song).
import { api } from '../api.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(ms) {
  if (!ms) return '';
  const s = (ms - Date.now()) / 1000;
  for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
  }
  return 'just now';
}
/** A coloured circle with the first letter, the same colour for the same handle. */
export function avatar(handle, name, size = '') {
  let h = 0;
  for (const c of handle) h = (h * 31 + c.charCodeAt(0)) % 360;
  return el('span', { className: `avatar ${size}`, textContent: (name || handle).trim()[0]?.toUpperCase() || '?', style: `--hue:${h}` });
}

export function initExplore(app) {
  const dialog = $('#explore-dialog');
  const results = $('#ex-results');
  const q = $('#ex-q');
  const sortSel = $('#ex-sort');
  const tabs = [...dialog.querySelectorAll('.ex-tabs .tab')];
  const player = app.playlists.player;
  const err = $('#ex-error');
  let type = 'songs';
  let view = 'browse'; // | 'profile'
  let handle = null;
  let seq = 0;
  let closingFromHistory = false;

  const setError = (m = '') => { err.textContent = m; };
  const by = (o) => el('a', {
    className: 'by', href: `/@${o.handle}`, textContent: o.name !== o.handle ? `${o.name} @${o.handle}` : `@${o.handle}`,
    onclick: (e) => { e.preventDefault(); showProfile(o.handle); },
  });

  // ---- URLs
  const browseUrl = () => {
    const p = new URLSearchParams();
    if (q.value.trim()) p.set('q', q.value.trim());
    if (type !== 'songs') p.set('t', type);
    if (sortSel.value !== 'new') p.set('sort', sortSel.value);
    const s = p.toString();
    return `/explore${s ? `?${s}` : ''}`;
  };
  const url = () => (view === 'profile' ? `/@${handle}` : browseUrl());
  function go(path, replace = false) {
    if (location.pathname + location.search === path) return;
    history[replace ? 'replaceState' : 'pushState'](null, '', path);
  }

  // ---- Browse
  function showBrowse({ query, t, sort, fromHistory = false } = {}) {
    view = 'browse';
    if (query !== undefined) q.value = query;
    if (t) type = t;
    if (sort) sortSel.value = sort;
    tabs.forEach((b) => { const on = b.dataset.type === type; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    $('#ex-browse').hidden = false;
    $('#ex-profile').hidden = true;
    if (!fromHistory) go(browseUrl());
    openDialog();
    search();
    if (!fromHistory) setTimeout(() => q.focus(), 0);
  }

  async function search(offset = 0) {
    const my = ++seq;
    setError();
    if (!offset) results.replaceChildren(el('p', { className: 'muted', textContent: 'Loading…' }));
    try {
      const r = await api.explore({ type, q: q.value.trim(), sort: sortSel.value, offset });
      if (my !== seq) return;
      if (!offset) results.replaceChildren();
      results.querySelector('.ex-more')?.remove();
      if (!r.items.length && !offset) {
        results.append(el('p', { className: 'muted ex-empty', textContent: q.value.trim()
          ? `No ${type} match "${q.value.trim()}".`
          : `No public ${type} yet. Make your own songs and playlists public and they show up here.` }));
        return;
      }
      let list = results.querySelector('.ex-list');
      if (!list) { list = el('ul', { className: 'ex-list' }); results.append(list); }
      for (const it of r.items) list.append(type === 'songs' ? songItem(it) : type === 'playlists' ? playlistItem(it) : personItem(it));
      if (r.more) results.append(el('div', { className: 'ex-more' }, el('button', { textContent: 'Show more', onclick: () => search(offset + r.items.length) })));
    } catch (e) {
      if (my === seq) { results.replaceChildren(); setError(e.message); }
    }
  }

  function songItem(s, showBy = true) {
    return el('li', { className: 'ex-item' },
      el('button', { className: 'ex-play', title: `Play "${s.name}"`, ariaLabel: `Play ${s.name}`, textContent: '▶', onclick: () => listen(() => player.openSong(s.token, { autoplay: true })) }),
      el('div', { className: 'ex-main' },
        el('a', { className: 'ex-title', href: `/s/${s.token}`, textContent: s.name, onclick: (e) => { e.preventDefault(); listen(() => player.openSong(s.token, { autoplay: true })); } }),
        el('div', { className: 'ex-sub' }, showBy ? by(s.owner) : '', showBy ? ' · ' : '',
          `${s.format.toUpperCase()} · ${plural(s.plays, 'play')} · ${ago(s.published_at)}`),
        s.description ? el('div', { className: 'ex-desc', textContent: s.description }) : ''));
  }
  function playlistItem(p, showBy = true) {
    return el('li', { className: 'ex-item' },
      el('button', { className: 'ex-play', title: `Play "${p.name}"`, ariaLabel: `Play ${p.name}`, textContent: '▶', onclick: () => listen(() => player.open(p.token, { autoplay: true })) }),
      el('div', { className: 'ex-main' },
        el('a', { className: 'ex-title', href: `/p/${p.token}`, onclick: (e) => { e.preventDefault(); listen(() => player.open(p.token)); } },
          el('span', { className: 'ex-kind', textContent: '♫ ' }), p.name),
        el('div', { className: 'ex-sub' }, showBy ? by(p.owner) : '', showBy ? ' · ' : '',
          `${plural(p.tracks, 'song')} · ${plural(p.plays, 'play')} · ${ago(p.published_at)}`),
        p.description ? el('div', { className: 'ex-desc', textContent: p.description }) : ''));
  }
  function personItem(u) {
    const open = (e) => { e.preventDefault(); showProfile(u.handle); };
    return el('li', { className: 'ex-item ex-person', onclick: open },
      avatar(u.handle, u.name),
      el('div', { className: 'ex-main' },
        el('a', { className: 'ex-title', href: `/@${u.handle}`, textContent: u.name, onclick: open }),
        el('div', { className: 'ex-sub' }, `@${u.handle} · ${plural(u.songs, 'song')} · ${plural(u.playlists, 'playlist')} · ${plural(u.plays, 'play')}`),
        u.bio ? el('div', { className: 'ex-desc', textContent: u.bio }) : ''));
  }

  // ---- A person's page
  async function showProfile(h, { fromHistory = false } = {}) {
    view = 'profile';
    handle = h.toLowerCase();
    $('#ex-browse').hidden = true;
    $('#ex-profile').hidden = false;
    $('#exp-name').textContent = `@${handle}`;
    $('#exp-meta').textContent = '';
    $('#exp-bio').textContent = '';
    $('#exp-avatar').replaceChildren();
    $('#exp-edit').hidden = true;
    const body = $('#exp-body');
    body.replaceChildren(el('p', { className: 'muted', textContent: 'Loading…' }));
    setError();
    if (!fromHistory) go(`/@${handle}`);
    openDialog();
    const my = ++seq;
    try {
      const u = await api.getProfile(handle);
      if (my !== seq) return;
      handle = u.handle;
      $('#exp-avatar').replaceChildren(avatar(u.handle, u.name, 'big'));
      $('#exp-name').replaceChildren(u.name, u.name !== u.handle ? el('span', { className: 'muted handle', textContent: ` @${u.handle}` }) : '');
      $('#exp-meta').textContent = [plural(u.songs.length, 'song'), plural(u.playlists.length, 'playlist'), plural(u.plays, 'play')].join(' · ');
      $('#exp-bio').textContent = u.bio;
      $('#exp-edit').hidden = !u.me;
      body.replaceChildren();
      if (u.playlists.length) {
        body.append(el('h3', { className: 'pl-sub', textContent: 'Playlists' }), el('ul', { className: 'ex-list' }, ...u.playlists.map((p) => playlistItem(p, false))));
      }
      body.append(el('h3', { className: 'pl-sub', textContent: 'Songs' }));
      if (u.songs.length) body.append(el('ul', { className: 'ex-list' }, ...u.songs.map((s) => songItem(s, false))));
      else body.append(el('p', { className: 'muted', textContent: u.me
        ? 'Nothing public yet. In My songs, set a song to Public and it shows up here.'
        : 'No public songs yet.' }));
    } catch (e) {
      if (my !== seq) return;
      body.replaceChildren();
      $('#exp-name').textContent = `@${handle}`;
      setError(e.message);
    }
  }

  /** Hand over to the player: Explore closes so the music can be seen in the editor. Back comes here again. */
  function listen(openPlayer) {
    closingFromHistory = true; // no history entry for closing: the player adds one
    dialog.close();
    openPlayer();
  }

  function openDialog() {
    if (!dialog.open) dialog.showModal();
  }

  // ---- events
  let timer = 0;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { go(browseUrl(), true); search(); }, 250);
  });
  $('#ex-search').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(timer); go(browseUrl(), true); search(); });
  sortSel.addEventListener('change', () => { go(browseUrl(), true); search(); });
  tabs.forEach((b) => b.addEventListener('click', () => { type = b.dataset.type; showBrowse({ t: type }); }));
  $('#ex-back').addEventListener('click', () => showBrowse());
  $('#exp-edit').addEventListener('click', () => app.settings.open('profile'));
  dialog.addEventListener('close', () => {
    seq++;
    if (closingFromHistory) closingFromHistory = false;
    else if (/^\/(explore|@)/.test(location.pathname)) history.pushState(null, '', '/');
    $('#pattern').focus();
  });

  // ---- Router: what the address shows, also on Back/Forward.
  function route(fromHistory) {
    const path = location.pathname;
    let m;
    if ((m = /^\/p\/([A-Za-z0-9_-]+)\/?$/.exec(path))) return player.open(m[1], { fromHistory });
    if ((m = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(path))) return player.openSong(m[1], { fromHistory });
    player.closeFromHistory();
    if ((m = /^\/@([^/]+)\/?$/.exec(path))) return showProfile(decodeURIComponent(m[1]), { fromHistory });
    if (/^\/explore\/?$/.test(path)) {
      const p = new URLSearchParams(location.search);
      const t = ['songs', 'playlists', 'people'].includes(p.get('t')) ? p.get('t') : 'songs';
      return showBrowse({ query: p.get('q') || '', t, sort: p.get('sort') === 'popular' ? 'popular' : 'new', fromHistory });
    }
    if (dialog.open) { closingFromHistory = true; dialog.close(); }
  }
  window.addEventListener('popstate', () => route(true));
  route(true);

  return {
    open: () => (dialog.open ? null : showBrowse()),
    openProfile: (h) => showProfile(h),
    /** Where to go when a player opened from here closes: back to this page, or the editor. */
    returnUrl: () => (dialog.open ? url() : '/'),
  };
}
