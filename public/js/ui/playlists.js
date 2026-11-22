// Playlists: manage (owner), share by link/email, and listen (anyone allowed).
import { api } from '../api.js';
import { confirmDialog } from './confirm.js';
import { loadSongFile } from '../formats/index.js';
import { local, listDrafts, getDraft } from '../storage.js';
import { loadDraftSong } from './songs-dialog.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

// Playlists opened in this browser, so a shared link can be found again.
const RECENT_KEY = 'dt.recentPlaylists';
const recent = {
  list() {
    try { return JSON.parse(local.get(RECENT_KEY)) || []; } catch { return []; }
  },
  add(p) {
    const list = recent.list().filter((x) => x.token !== p.token);
    list.unshift({ token: p.token, name: p.name, tracks: p.tracks.length, openedAt: Date.now() });
    local.set(RECENT_KEY, JSON.stringify(list.slice(0, 30)));
  },
  remove(token) {
    local.set(RECENT_KEY, JSON.stringify(recent.list().filter((x) => x.token !== token)));
  },
};

// Links (/p/<token>, /s/<token>) are opened by the router in explore.js.
export function initPlaylists(app) {
  const player = initPlayer(app);
  const manager = initManager(app, (token) => player.open(token));
  return { manager, player };
}

const VIS_LABEL = { private: 'Private', link: 'Anyone with the link', public: 'Public' };

// ---------------------------------------------------------------------------
// Manager

function initManager(app, playerOpen) {
  const dialog = $('#playlists-dialog');
  const err = $('#pl-error');
  let current = null; // owner view of the playlist being edited
  let mySongs = [];

  const setError = (m = '') => { err.textContent = m; };
  const guard = (fn) => async (...a) => {
    setError();
    try { return await fn(...a); } catch (e) { setError(e.message); }
  };

  function showList() {
    current = null;
    $('#pl-list-view').hidden = false;
    $('#pl-edit-view').hidden = true;
    refreshList();
  }

  function renderRecent(hide = new Set()) {
    const box = $('#pl-recent');
    box.replaceChildren();
    const list = recent.list().filter((p) => !hide.has(p.token));
    $('#pl-recent-h').hidden = !list.length && !!app.user;
    if (!list.length) {
      if (!app.user) box.append(el('p', { className: 'muted', textContent: 'Playlists you open from a link show up here.' }));
      return;
    }
    const tb = el('tbody');
    for (const p of list) {
      tb.append(el('tr', {},
        el('td', { className: 'name', textContent: p.name }),
        el('td', { textContent: `${p.tracks} song${p.tracks === 1 ? '' : 's'}` }),
        el('td', { textContent: `opened ${fmtDate(p.openedAt)}` }),
        el('td', { className: 'acts' },
          el('button', { textContent: '▶ Play', onclick: () => { dialog.close(); playerOpen(p.token); } }), ' ',
          el('button', { textContent: '✕', title: 'Remove from this list', onclick: () => { recent.remove(p.token); renderRecent(hide); } }))));
    }
    box.append(el('table', { className: 'songs-table' }, tb));
  }

  const refreshList = guard(async () => {
    $('#pl-signed-out').hidden = !!app.user;
    $('#pl-signed-in').hidden = !app.user;
    if (!app.user) { renderRecent(); return; }
    const { mine, shared } = await api.listPlaylists();
    // Playlists already listed above don't need to appear under "recently opened".
    renderRecent(new Set([...mine, ...shared].map((p) => p.token)));
    const mineBox = $('#pl-mine');
    mineBox.replaceChildren();
    if (!mine.length) mineBox.append(el('p', { className: 'muted', textContent: 'No playlists yet.' }));
    else {
      const tb = el('tbody');
      for (const p of mine) {
        const vis = p.visibility !== 'private'
          ? el('span', { className: `badge ${p.visibility}`, textContent: VIS_LABEL[p.visibility] })
          : el('span', { className: 'badge', textContent: p.shares ? `Shared with ${p.shares}` : 'Private' });
        tb.append(el('tr', {},
          el('td', { className: 'name', textContent: p.name }),
          el('td', { textContent: `${p.tracks} song${p.tracks === 1 ? '' : 's'}` }),
          el('td', {}, vis),
          el('td', { className: 'acts' },
            el('button', { textContent: '▶ Play', onclick: () => { dialog.close(); playerOpen(p.token); } }), ' ',
            el('button', { textContent: 'Edit', onclick: () => edit(p.id) }))));
      }
      mineBox.append(el('table', { className: 'songs-table' }, tb));
    }
    const sharedBox = $('#pl-shared');
    sharedBox.replaceChildren();
    if (!shared.length) sharedBox.append(el('p', { className: 'muted', textContent: 'Nothing shared with you yet.' }));
    else {
      const tb = el('tbody');
      for (const p of shared) {
        tb.append(el('tr', {},
          el('td', { className: 'name', textContent: p.name }),
          el('td', { textContent: `from ${p.owner}` }),
          el('td', { textContent: `${p.tracks} song${p.tracks === 1 ? '' : 's'}` }),
          el('td', { className: 'acts' }, el('button', { textContent: '▶ Play', onclick: () => { dialog.close(); playerOpen(p.token); } }))));
      }
      sharedBox.append(el('table', { className: 'songs-table' }, tb));
    }
  });

  const edit = guard(async (id) => {
    const [pl, songs] = await Promise.all([api.getPlaylist(id), api.listSongs()]);
    mySongs = songs.songs;
    current = pl;
    $('#pl-list-view').hidden = true;
    $('#pl-edit-view').hidden = false;
    renderEdit();
  });

  function renderEdit() {
    const p = current;
    $('#pl-name').value = p.name;
    $('#pl-desc').value = p.description;
    document.querySelectorAll('input[name="pl-vis"]').forEach((r) => { r.checked = r.value === p.visibility; });
    $('#pl-link').value = p.url;

    const list = $('#pl-tracks');
    list.replaceChildren();
    if (!p.tracks.length) list.append(el('li', { className: 'empty', textContent: 'No songs yet – add some from My songs below.' }));
    p.tracks.forEach((t, i) => {
      list.append(el('li', {},
        el('span', { className: 't-name', textContent: t.name }),
        el('span', { className: 't-fmt', textContent: t.format.toUpperCase() }),
        el('button', { textContent: '↑', title: 'Move up', disabled: i === 0, onclick: () => move(i, -1) }),
        el('button', { textContent: '↓', title: 'Move down', disabled: i === p.tracks.length - 1, onclick: () => move(i, 1) }),
        el('button', { textContent: '✕', title: 'Remove from playlist', onclick: () => setTracks(p.tracks.filter((_, j) => j !== i).map((x) => x.id)) })));
    });

    const sel = $('#pl-add-select');
    sel.replaceChildren();
    const inList = new Set(p.tracks.map((t) => t.id));
    const avail = mySongs.filter((s) => !inList.has(s.id));
    sel.append(el('option', { value: '', textContent: avail.length ? 'Choose a song from My songs…' : mySongs.length ? 'All your songs are in this playlist' : 'No songs in My songs yet' }));
    for (const s of avail) sel.append(el('option', { value: s.id, textContent: s.name }));
    $('#pl-add').disabled = !avail.length;

    const shares = $('#pl-shares');
    shares.replaceChildren();
    for (const s of p.shares) {
      shares.append(el('li', {},
        el('span', { textContent: s.email }),
        s.notified_at ? '' : el('span', { className: 'pending', textContent: 'email not sent' }),
        el('button', { className: 'link', textContent: 'Remove', onclick: guard(async () => { current = await api.unsharePlaylist(p.id, s.email); renderEdit(); }) })));
    }
  }

  const save = guard(async (data) => {
    try {
      current = await api.updatePlaylist(current.id, data);
    } catch (e) {
      renderEdit(); // e.g. the radio buttons back to how it is
      if (e.needsHandle) { app.askForHandle('playlist'); return; }
      throw e;
    }
    renderEdit();
  });
  const setTracks = (ids) => save({ songIds: ids });
  const move = (i, d) => {
    const ids = current.tracks.map((t) => t.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    setTracks(ids);
  };

  $('#pl-signin').addEventListener('click', () => { dialog.close(); app.auth.open(); });
  // Signing in/out changes what the list shows.
  app.onUserChange.push(() => { if (dialog.open && !current) refreshList(); });
  $('#pl-new').addEventListener('click', guard(async () => {
    const p = await api.createPlaylist({ name: 'New playlist' });
    await edit(p.id);
    $('#pl-name').select();
  }));
  $('#pl-back').addEventListener('click', showList);
  $('#pl-name').addEventListener('change', (e) => save({ name: e.target.value }));
  $('#pl-desc').addEventListener('change', (e) => save({ description: e.target.value }));
  document.querySelectorAll('input[name="pl-vis"]').forEach((r) => r.addEventListener('change', () => save({ visibility: r.value })));
  $('#pl-add').addEventListener('click', () => {
    const id = Number($('#pl-add-select').value);
    if (id) setTracks([...current.tracks.map((t) => t.id), id]);
  });
  $('#pl-add-select').addEventListener('dblclick', () => $('#pl-add').click());
  $('#pl-add-current').addEventListener('click', guard(async () => {
    const saved = await app.saveCloud(false);
    if (!saved) return;
    mySongs = (await api.listSongs()).songs;
    if (!current.tracks.some((t) => t.id === saved.id)) await setTracks([...current.tracks.map((t) => t.id), saved.id]);
    else renderEdit();
  }));
  $('#pl-copy').addEventListener('click', async () => {
    const input = $('#pl-link');
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    app.toast('Link copied');
  });
  $('#pl-new-link').addEventListener('click', guard(async () => {
    if (!(await confirmDialog({
      title: 'Make a new link?',
      message: 'The current link stops working, also for people you invited. People you shared with by email can still find the playlist under Playlists when signed in.',
      confirmText: 'Make new link', danger: true,
    }))) return;
    current = await api.newPlaylistLink(current.id);
    renderEdit();
  }));
  $('#pl-share-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const input = $('#pl-share-emails');
    if (!input.value.trim()) return;
    const r = await api.sharePlaylist(current.id, input.value);
    current = r;
    input.value = '';
    renderEdit();
    if (r.added.length) app.toast(`Shared with ${r.added.join(', ')}`);
    else app.toast('Already shared with those addresses');
    if (r.failed.length) setError(`Saved, but the email could not be sent to: ${r.failed.join(', ')}`);
  }));
  $('#pl-play').addEventListener('click', () => { const t = current.token; dialog.close(); playerOpen(t); });
  $('#pl-delete').addEventListener('click', guard(async () => {
    if (!(await confirmDialog({
      title: `Delete "${current.name}"?`,
      message: 'The playlist and its link are removed. The songs stay in My songs.',
      confirmText: 'Delete playlist', danger: true,
    }))) return;
    await api.deletePlaylist(current.id);
    showList();
  }));

  return {
    open() {
      setError();
      dialog.showModal();
      showList();
    },
  };
}

// ---------------------------------------------------------------------------
// Player

function initPlayer(app) {
  const dialog = $('#player-dialog');
  // Playback goes through the main tracker so the song scrolls in the pattern
  // editor behind the player. The user's own song is stashed meanwhile.
  const engine = app.engine;
  let stash = null; // the user's own song while listening: { song, serverSong, draftId, dirty, state, undo, redo, mutes }
  let kind = 'playlist'; // or 'song': a single song from its link /s/<token>
  let token = null;
  let playlist = null;
  let index = -1;
  let playing = false;
  let loadSeq = 0;
  const cache = new Map(); // songId -> { name, format, data }

  // Is the editor (still) holding the user's copy of track i from this playlist?
  const editingCopyOf = (i) => !stash && !!playlist?.tracks[i] && app.origin?.songId === playlist.tracks[i].id;
  const copyPlaying = () => editingCopyOf(index) && engine.playing;

  engine.addEventListener('ended', () => { if (playing && stash) next(1); });
  engine.addEventListener('stopped', () => { if (dialog.open && !stash) render(); });
  engine.addEventListener('row', (e) => {
    if (!stash || !playing) return;
    const m = e.detail;
    const t = playlist?.tracks[index];
    if (t) $('#pp-now').textContent = `${t.name} · pos ${String(m.order).padStart(2, '0')} row ${String(m.row).padStart(2, '0')}`;
  });

  const pathFor = (k, t) => `/${k === 'song' ? 's' : 'p'}/${t}`;

  function render() {
    $('#pp-title').textContent = playlist?.name || (kind === 'song' ? 'Song' : 'Playlist');
    const meta = []; // parts, each a list of nodes, shown joined with " · "
    if (playlist) {
      if (kind === 'song') meta.push([playlist.tracks[0]?.format.toUpperCase() || 'Song']);
      else meta.push([`${playlist.tracks.length} song${playlist.tracks.length === 1 ? '' : 's'}`]);
      if (playlist.by && playlist.access !== 'owner') {
        const { handle, name } = playlist.by;
        meta.push(['by ', el('a', { href: `/@${handle}`, textContent: name !== handle ? `${name} @${handle}` : `@${handle}`,
          onclick: (e) => { e.preventDefault(); closingFromHistory = true; dialog.close(); app.explore.openProfile(handle); } })]); // Back returns here
      } else if (playlist.owner) meta.push([`shared by ${playlist.owner}`]);
      if (playlist.plays) meta.push([`${playlist.plays} play${playlist.plays === 1 ? '' : 's'}`]);
      if (playlist.access === 'owner') meta.push([VIS_LABEL[playlist.visibility]?.toLowerCase() || '']);
    }
    $('#pp-meta').replaceChildren(...meta.flatMap((part, i) => (i ? [' · ', ...part] : part)));
    $('#pp-desc').textContent = playlist?.description || '';
    const list = $('#pp-tracks');
    list.replaceChildren();
    if (playlist && !playlist.tracks.length) list.append(el('li', { className: 'empty', textContent: 'This playlist is empty.' }));
    (playlist?.tracks || []).forEach((t, i) => {
      const li = el('li', { className: i === index ? 'current' : '', onclick: (e) => { if (!e.target.closest('button')) play(i); } },
        el('span', { className: 't-name', textContent: (i === index && (playing || copyPlaying()) ? '♪ ' : '') + t.name }),
        editingCopyOf(i) ? el('span', { className: 'badge', textContent: playlist.access === 'owner' ? 'open in editor' : 'your copy' }) : '',
        el('span', { className: 't-fmt', textContent: t.format.toUpperCase() }),
        el('button', { textContent: editingCopyOf(i) ? '✎ Continue' : '✎ Edit', title: editingCopyOf(i) ? 'Back to editing' : playlist.access === 'owner' ? 'Edit this song' : 'Edit your own copy of this song', onclick: () => editTrack(i) }),
        el('button', { textContent: '⤓', title: 'Download', onclick: () => download(i) }));
      list.append(li);
    });
    $('#pp-play').textContent = playing || copyPlaying() ? '■' : '▶';
    $('#pp-play').disabled = !playlist?.tracks.length;
    $('#pp-edit').disabled = index < 0;
    $('#pp-edit').textContent = editingCopyOf(index) ? '✎ Continue editing' : '✎ Edit this song';
    if (editingCopyOf(index) && !playing) {
      const t = playlist.tracks[index];
      const what = playlist.access === 'owner' ? `"${t.name}"` : `Your copy of "${t.name}"`;
      $('#pp-now').textContent = `${what} is ${engine.playing ? 'playing' : 'open'} in the editor`;
    }
  }

  async function fetchSong(i) {
    const t = playlist.tracks[i];
    if (!cache.has(t.id)) cache.set(t.id, await (kind === 'song' ? api.getPublicSongData(token) : api.getSharedSong(token, t.id)));
    return cache.get(t.id);
  }

  async function play(i) {
    if (!playlist?.tracks.length) return;
    index = (i + playlist.tracks.length) % playlist.tracks.length;
    const seq = ++loadSeq;
    app.stop();
    await engine.start();
    playing = true;
    render();
    $('#pp-now').textContent = 'Loading…';
    try {
      const s = await fetchSong(index);
      if (seq !== loadSeq) return;
      const song = loadSongFile(s.data.slice(0), `${s.name}.${s.format}`);
      await enterListening();
      render(); // now listening: the track is the original, not the user's copy
      app.setSong(song);
      app.state.follow = true;
      await app.play('song');
    } catch (e) {
      $('#pp-now').textContent = `Could not play: ${e.message}`;
      playing = false;
      render();
    }
  }

  function next(d) { if (playlist?.tracks.length) play(index < 0 ? 0 : index + d); }

  function stop() {
    loadSeq++;
    playing = false;
    app.stop();
    $('#pp-now').textContent = '';
    render();
  }

  async function enterListening() {
    if (stash) return;
    // Save the user's work first so a pending autosave can't store the playlist song instead.
    await app.flushAutosave();
    stash = {
      song: app.song, serverSong: app.serverSong, draftId: app.draftId, dirty: app.dirty, origin: app.origin, undo: app.undo, redo: app.redo,
      state: { ...app.state, selection: null }, mutes: app.mutes.slice(),
    };
    app.listening = true;
    document.body.classList.add('listening');
  }

  /** Put the user's own song back into the editor. */
  function leaveListening() {
    if (!stash) return;
    const s = stash;
    stash = null;
    app.listening = false;
    document.body.classList.remove('listening');
    app.setSong(s.song, { serverSong: s.serverSong, draftId: s.draftId, dirty: s.dirty, origin: s.origin });
    Object.assign(app.state, s.state, { followActive: false });
    app.undo = s.undo; app.redo = s.redo;
    s.mutes.forEach((m, i) => { if (m) app.toggleMute(i); });
    app.refreshAll();
  }

  /**
   * Start editing a track. It always becomes the user's own work: the owner edits
   * their song, anyone else gets a copy. There is one copy per playlist song: if
   * the user already has one in My songs (on this device), that one is opened.
   * A copy is only stored once the user actually changes something.
   */
  async function editTrack(i) {
    // Already editing this track (e.g. came back with the Back button):
    // just return to it – don't stop the music or load anything again.
    if (editingCopyOf(i)) {
      dialog.close();
      $('#pattern').focus();
      return;
    }
    try {
      const t = playlist.tracks[i];
      const own = playlist.access === 'owner';
      const serverSong = own ? { id: t.id, name: t.name } : null;
      const origin = { songId: t.id, name: t.name };
      const existing = (await listDrafts()).find((d) => d.origin?.songId === t.id);
      const s = existing ? null : await fetchSong(i);
      // If this track is playing right now, keep the music going in the copy.
      const playingThis = stash && playing && index === i;
      const pos = playingThis && app.playPos ? { order: app.playPos.order, row: app.playPos.row } : null;
      const prev = stash;
      index = i; // highlighted when the user comes back to the playlist
      if (stash) {
        stash = null;
        app.listening = false;
        document.body.classList.remove('listening');
      }
      dialog.close(); // not listening any more, so closing leaves the music running
      if (existing) {
        const d = await getDraft(existing.id);
        await app.switchSong(loadDraftSong(d), { serverSong: d.serverSong || serverSong, draftId: d.id, dirty: true, origin });
        if (pos) { app.state.follow = true; await app.play('song', pos); }
      } else if (playingThis) {
        // The original is already in the editor and playing: it simply becomes the user's song.
        Object.assign(app, { serverSong, draftId: null, dirty: false, origin });
        app.scheduleAutosave();
      } else {
        await app.switchSong(loadSongFile(s.data.slice(0), `${s.name}.${s.format}`), { serverSong, origin });
      }
      if (prev && prev.dirty && prev.draftId) app.toast(`"${prev.song.title || 'untitled'}" is kept in My songs (on this device).`);
      let msg;
      if (existing) msg = `Opened your copy of "${t.name}" from My songs (changed ${fmtDate(existing.updatedAt)}).`;
      else if (own) msg = `You're editing "${t.name}". Save it from My songs to update it in your account.`;
      else msg = `You're editing your own copy of "${t.name}". It's kept in My songs as soon as you change something.`;
      app.toast(`${msg} Back to the playlist: ♫ ${playlist.name} at the top.`);
      pulseChip();
      $('#pattern').focus();
    } catch (e) {
      app.toast(e.message, 'error');
    }
  }

  async function download(i) {
    try {
      const s = await fetchSong(i);
      const a = el('a', { href: URL.createObjectURL(new Blob([s.data])), download: `${s.name.replace(/[^\w\- .]+/g, '_')}.${s.format}` });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) {
      app.toast(e.message, 'error');
    }
  }

  async function load() {
    $('#pp-gate').hidden = true;
    $('#pp-body').hidden = false;
    try {
      if (kind === 'song') {
        const s = await api.getPublicSong(token);
        playlist = { ...s, by: s.owner, owner: undefined, tracks: [{ id: s.id, name: s.name, format: s.format, size: s.size }] };
      } else {
        playlist = await api.openShared(token);
        recent.add(playlist);
      }
      if (index >= playlist.tracks.length) index = -1; // keep the place when coming back
      showChip();
      render();
    } catch (e) {
      if (e.status === 404) { if (kind === 'playlist') recent.remove(token); hideChip(); }
      playlist = null;
      render();
      $('#pp-title').textContent = 'Playlist';
      $('#pp-body').hidden = true;
      $('#pp-gate').hidden = false;
      $('#pp-gate-msg').textContent = e.message;
      $('#pp-signin').hidden = !e.needsSignIn && e.status !== 403;
      $('#pp-signin').textContent = e.status === 403 ? 'Sign in with another email' : 'Sign in';
    }
  }

  $('#pp-play').addEventListener('click', () => (playing || copyPlaying() ? stop() : play(index < 0 ? 0 : index)));
  $('#pp-prev').addEventListener('click', () => next(-1));
  $('#pp-next').addEventListener('click', () => next(1));
  $('#pp-edit').addEventListener('click', () => { if (index >= 0) editTrack(index); });
  $('#pp-signin').addEventListener('click', () => { dialog.close(); app.auth.open(); });
  dialog.addEventListener('close', () => {
    if (stash) {
      // Listening to the playlist: stop and give the user's own song back.
      stop();
      leaveListening();
    } else {
      // Music in the editor (e.g. the user's copy) wasn't started by the player: leave it.
      loadSeq++;
      playing = false;
    }
    // Leaving the playlist is a new history entry, so Back returns to it.
    // Opened from Explore or someone's page: back to that page.
    if (closingFromHistory) closingFromHistory = false;
    else if (/^\/[ps]\//.test(location.pathname)) history.pushState(null, '', app.explore?.returnUrl() || '/');
  });

  // Back/Forward: the router (explore.js) opens and closes the player.
  let closingFromHistory = false;
  function closeFromHistory() {
    if (dialog.open) { closingFromHistory = true; dialog.close(); }
  }
  // After signing in from the gate, reopen the playlist.
  app.onUserChange.push(() => { if (token && !playlist && !dialog.open) openKind(kind, token); });

  async function openKind(k, t, { fromHistory = false, autoplay = false } = {}) {
    if (token !== t || kind !== k) { cache.clear(); index = -1; }
    kind = k;
    token = t;
    if (!fromHistory && location.pathname !== pathFor(k, t)) history.pushState(null, '', pathFor(k, t));
    if (!dialog.open) dialog.showModal();
    await load();
    // A single song: ready to play, no list to choose from.
    if (k === 'song' && playlist && index < 0) { index = 0; render(); }
    if (autoplay && playlist?.tracks.length && !playing) play(index < 0 ? 0 : index);
  }
  const open = (t, o) => openKind('playlist', t, o);
  const openSong = (t, o) => openKind('song', t, o);

  // "♫ <playlist>" in the top bar: one click back to the playlist, e.g. after "Edit".
  const chip = $('#playlist-chip');
  function showChip() {
    chip.querySelector('span').textContent = playlist.name;
    chip.title = kind === 'song' ? `Back to "${playlist.name}"` : `Back to the playlist "${playlist.name}"`;
    chip.hidden = false;
  }
  function hideChip() { chip.hidden = true; }
  function pulseChip() {
    chip.classList.remove('attention');
    void chip.offsetWidth; // restart the animation if it is already running
    chip.classList.add('attention');
    clearTimeout(pulseChip.t);
    pulseChip.t = setTimeout(() => chip.classList.remove('attention'), 4000);
  }
  chip.addEventListener('click', () => { if (token) openKind(kind, token); });

  return { open, openSong, closeFromHistory };
}
