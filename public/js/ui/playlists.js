// Playlists: manage (owner), share by link/email, and listen (anyone allowed).
import { api } from '../api.js';
import { loadSongFile } from '../formats/index.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

export function initPlaylists(app) {
  const player = initPlayer(app);
  const manager = initManager(app, (token) => player.open(token));
  // A shared link: /p/<token>
  const m = /^\/p\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  if (m) player.open(m[1]);
  return { manager, player };
}

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

  const refreshList = guard(async () => {
    const { mine, shared } = await api.listPlaylists();
    const mineBox = $('#pl-mine');
    mineBox.replaceChildren();
    if (!mine.length) mineBox.append(el('p', { className: 'muted', textContent: 'No playlists yet.' }));
    else {
      const tb = el('tbody');
      for (const p of mine) {
        const vis = p.visibility === 'public'
          ? el('span', { className: 'badge public', textContent: 'Public' })
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
    current = await api.updatePlaylist(current.id, data);
    renderEdit();
  });
  const setTracks = (ids) => save({ songIds: ids });
  const move = (i, d) => {
    const ids = current.tracks.map((t) => t.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    setTracks(ids);
  };

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
    if (!confirm('Make a new link? The current link stops working, also for people you invited.')) return;
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
    if (!confirm(`Delete the playlist "${current.name}"? The songs stay in My songs.`)) return;
    await api.deletePlaylist(current.id);
    showList();
  }));

  return {
    open() {
      if (!app.user) { app.auth.open(); return; }
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
  let keepOnClose = false; // closing after "Edit" hands the playing song to the editor
  let token = null;
  let playlist = null;
  let index = -1;
  let playing = false;
  let loadSeq = 0;
  const cache = new Map(); // songId -> { name, format, data }

  engine.addEventListener('ended', () => { if (playing && stash) next(1); });
  engine.addEventListener('row', (e) => {
    if (!stash || !playing) return;
    const m = e.detail;
    const t = playlist?.tracks[index];
    if (t) $('#pp-now').textContent = `${t.name} · pos ${String(m.order).padStart(2, '0')} row ${String(m.row).padStart(2, '0')}`;
  });

  function render() {
    $('#pp-title').textContent = playlist?.name || 'Playlist';
    const meta = [];
    if (playlist) {
      meta.push(`${playlist.tracks.length} song${playlist.tracks.length === 1 ? '' : 's'}`);
      if (playlist.owner) meta.push(`shared by ${playlist.owner}`);
      if (playlist.access === 'owner') meta.push(playlist.visibility === 'public' ? 'public' : 'private');
    }
    $('#pp-meta').textContent = meta.join(' · ');
    $('#pp-desc').textContent = playlist?.description || '';
    const list = $('#pp-tracks');
    list.replaceChildren();
    if (playlist && !playlist.tracks.length) list.append(el('li', { className: 'empty', textContent: 'This playlist is empty.' }));
    (playlist?.tracks || []).forEach((t, i) => {
      const li = el('li', { className: i === index ? 'current' : '', onclick: (e) => { if (!e.target.closest('button')) play(i); } },
        el('span', { className: 't-name', textContent: (i === index && playing ? '♪ ' : '') + t.name }),
        el('span', { className: 't-fmt', textContent: t.format.toUpperCase() }),
        el('button', { textContent: '✎ Edit', title: playlist.access === 'owner' ? 'Edit this song' : 'Edit your own copy of this song', onclick: () => editTrack(i) }),
        el('button', { textContent: '⤓', title: 'Download', onclick: () => download(i) }));
      list.append(li);
    });
    $('#pp-play').textContent = playing ? '■' : '▶';
    $('#pp-play').disabled = !playlist?.tracks.length;
    $('#pp-edit').disabled = index < 0;
  }

  async function fetchSong(i) {
    const t = playlist.tracks[i];
    if (!cache.has(t.id)) cache.set(t.id, await api.getSharedSong(token, t.id));
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
      song: app.song, serverSong: app.serverSong, draftId: app.draftId, dirty: app.dirty, undo: app.undo, redo: app.redo,
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
    app.setSong(s.song, { serverSong: s.serverSong, draftId: s.draftId, dirty: s.dirty });
    Object.assign(app.state, s.state, { followActive: false });
    app.undo = s.undo; app.redo = s.redo;
    s.mutes.forEach((m, i) => { if (m) app.toggleMute(i); });
    app.refreshAll();
  }

  /**
   * Start editing a track. It always becomes the user's own work: the owner edits
   * their song, anyone else gets a copy. Whatever was in the editor before is kept
   * in My songs (on this device) if it had changes.
   */
  async function editTrack(i) {
    try {
      const s = await fetchSong(i);
      const own = playlist.access === 'owner';
      const serverSong = own ? { id: playlist.tracks[i].id, name: s.name } : null;
      const prev = stash;
      const handOver = stash && playing && index === i; // already playing in the editor: keep it going
      if (stash) {
        stash = null;
        app.listening = false;
        document.body.classList.remove('listening');
      }
      if (handOver) {
        keepOnClose = true;
        dialog.close();
        app.serverSong = serverSong;
        app.draftId = null;
        app.dirty = false;
        app.changed(); // now the user's own work in progress
      } else {
        dialog.close();
        const song = loadSongFile(s.data.slice(0), `${s.name}.${s.format}`);
        await app.switchSong(song, { serverSong, edited: true });
      }
      if (prev && prev.dirty && prev.draftId) app.toast(`"${prev.song.title || 'untitled'}" is kept in My songs (on this device).`);
      app.toast(own
        ? `You're editing "${s.name}". Save it from My songs to update it in your account.`
        : `You're editing your own copy of "${s.name}". It's kept in My songs${app.user ? ' – save it to your account any time.' : ' on this device.'}`);
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
      playlist = await api.openShared(token);
      index = -1;
      render();
    } catch (e) {
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

  $('#pp-play').addEventListener('click', () => (playing ? stop() : play(index < 0 ? 0 : index)));
  $('#pp-prev').addEventListener('click', () => next(-1));
  $('#pp-next').addEventListener('click', () => next(1));
  $('#pp-edit').addEventListener('click', () => { if (index >= 0) editTrack(index); });
  $('#pp-signin').addEventListener('click', () => { dialog.close(); app.auth.open(); });
  dialog.addEventListener('close', () => {
    if (keepOnClose) {
      // Handed over to the editor while playing: leave the music running.
      keepOnClose = false;
      loadSeq++;
      playing = false;
    } else {
      stop();
      leaveListening();
    }
    if (location.pathname.startsWith('/p/')) history.replaceState(null, '', '/');
  });
  // After signing in from the gate, reopen the playlist.
  app.onUserChange.push(() => { if (token && !playlist && !dialog.open) open(token); });

  async function open(t) {
    if (token !== t) cache.clear();
    token = t;
    if (location.pathname !== `/p/${t}`) history.replaceState(null, '', `/p/${t}`);
    if (!dialog.open) dialog.showModal();
    await load();
  }

  return { open };
}
