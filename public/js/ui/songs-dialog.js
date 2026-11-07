import { api } from '../api.js';
import { loadSongFile } from '../formats/index.js';

const $ = (s) => document.querySelector(s);

function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtSize(b) {
  return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`;
}

export function initSongsDialog(app) {
  const dialog = $('#songs-dialog');
  const list = $('#songs-list');

  async function refresh() {
    list.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const { songs } = await api.listSongs();
      list.innerHTML = '';
      const save = document.createElement('div');
      save.className = 'songs-actions';
      save.innerHTML = `<button class="primary" data-act="save">Save current song</button> <button data-act="save-new">Save as new copy</button>`;
      list.append(save);
      if (!songs.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'No songs saved yet.';
        list.append(p);
        return;
      }
      const table = document.createElement('table');
      table.className = 'songs-table';
      table.innerHTML = '<thead><tr><th>Name</th><th>Format</th><th>Size</th><th>Saved</th><th></th></tr></thead>';
      const tb = document.createElement('tbody');
      for (const s of songs) {
        const tr = document.createElement('tr');
        if (app.serverSong?.id === s.id) tr.className = 'current';
        tr.innerHTML = `<td class="name"></td><td>${s.format.toUpperCase()}</td><td>${fmtSize(s.size)}</td><td>${fmtDate(s.updated_at)}</td>
          <td class="acts"><button data-act="load" data-id="${s.id}">Load</button> <button data-act="delete" data-id="${s.id}" class="danger">Delete</button></td>`;
        tr.querySelector('.name').textContent = s.name;
        tb.append(tr);
      }
      table.append(tb);
      list.append(table);
    } catch (e) {
      list.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'error';
      p.textContent = e.message;
      list.append(p);
    }
  }

  list.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    try {
      if (b.dataset.act === 'save' || b.dataset.act === 'save-new') {
        await app.saveCloud(b.dataset.act === 'save-new');
        refresh();
      } else if (b.dataset.act === 'load') {
        const s = await api.getSong(id);
        const song = loadSongFile(s.data, `${s.name}.${s.format}`);
        app.setSong(song, { serverSong: { id, name: s.name } });
        app.changed();
        dialog.close();
        app.toast(`Loaded "${s.name}"`);
      } else if (b.dataset.act === 'delete') {
        if (!confirm('Delete this song permanently?')) return;
        await api.deleteSong(id);
        if (app.serverSong?.id === id) app.serverSong = null;
        refresh();
      }
    } catch (err) {
      app.toast(err.message, 'error');
    }
  });

  return {
    open() {
      if (!app.user) { app.auth.open(); return; }
      dialog.showModal();
      refresh();
    },
  };
}
