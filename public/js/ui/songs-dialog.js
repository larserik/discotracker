// My songs: work in progress on this device (everyone) + songs in the account (signed in).
import { api } from '../api.js';
import { confirmDialog } from './confirm.js';
import { loadSongFile } from '../formats/index.js';
import { listDrafts, getDraft, deleteDraft } from '../storage.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);

export function loadDraftSong(d) {
  const song = loadSongFile(d.data.buffer ?? d.data, 'draft.xm');
  if (d.format === 'mod') { song.format = 'mod'; song.linear = false; }
  if (d.channelPan) song.channelPan = d.channelPan;
  return song;
}

export function initSongsDialog(app) {
  const dialog = $('#songs-dialog');
  const box = $('#songs-list');

  const run = (fn) => async () => {
    try { await fn(); } catch (e) { app.toast(e.message, 'error'); }
  };

  async function refresh() {
    await app.flushAutosave(); // so the current song's latest changes are listed
    const [drafts, cloud] = await Promise.all([
      listDrafts(),
      app.user ? api.listSongs().then((r) => r.songs).catch((e) => { app.toast(e.message, 'error'); return []; }) : null,
    ]);
    box.replaceChildren();

    // ---- On this device
    box.append(el('h3', { className: 'pl-sub', textContent: 'On this device' }));
    box.append(el('p', { className: 'muted', textContent: app.user
      ? 'Songs you are working on. They stay in this browser until you save them to your account.'
      : 'Songs you are working on, kept in this browser. Sign in to save them in your account and share them.' }));
    if (!drafts.length) box.append(el('p', { className: 'muted', textContent: 'Nothing here yet – songs show up as soon as you change them.' }));
    else {
      const tb = el('tbody');
      for (const d of drafts) {
        const isCurrent = d.id === app.draftId;
        const note = d.serverSong ? ` · unsaved changes to "${d.serverSong.name}"` : '';
        tb.append(el('tr', { className: isCurrent ? 'current' : '' },
          el('td', { className: 'name' }, d.title || 'untitled', isCurrent ? el('span', { className: 'badge', textContent: 'open' }) : ''),
          el('td', { textContent: `${fmtDate(d.updatedAt)}${note}` }),
          el('td', { textContent: fmtSize(d.size) }),
          el('td', { className: 'acts' },
            isCurrent ? '' : el('button', { textContent: 'Open', onclick: run(() => openDraft(d.id)) }), ' ',
            app.user ? el('button', { textContent: 'Save to account', onclick: run(() => draftToAccount(d.id)) }) : '', ' ',
            el('button', { className: 'danger', textContent: 'Delete', onclick: run(() => removeDraft(d)) }))));
      }
      box.append(el('table', { className: 'songs-table' }, tb));
    }

    // ---- In your account
    box.append(el('h3', { className: 'pl-sub', textContent: 'In your account' }));
    if (!app.user) {
      box.append(el('p', { className: 'muted', textContent: 'Saved songs can be opened on any device and put in playlists you share.' }),
        el('button', { className: 'primary', textContent: 'Sign in', onclick: () => { dialog.close(); app.auth.open(); } }));
      return;
    }
    box.append(el('div', { className: 'songs-actions' },
      el('button', { className: 'primary', textContent: 'Save the open song', onclick: run(async () => { await app.saveCloud(false); refresh(); }) }),
      el('button', { textContent: 'Save as new copy', onclick: run(async () => { await app.saveCloud(true); refresh(); }) })));
    if (!cloud.length) { box.append(el('p', { className: 'muted', textContent: 'No songs saved in your account yet.' })); return; }
    box.append(el('p', { className: 'muted', textContent: app.user.handle
      ? `Public songs are listed on your page (${location.host}/@${app.user.handle}) and in Explore.`
      : 'Share a song by link, or choose a handle to get your own page with your public songs.' }));
    const tb = el('tbody');
    for (const s of cloud) {
      tb.append(el('tr', { className: app.serverSong?.id === s.id && !app.dirty ? 'current' : '' },
        el('td', { className: 'name' }, s.name, s.plays ? el('span', { className: 'muted plays', textContent: ` · ${s.plays} play${s.plays === 1 ? '' : 's'}` }) : ''),
        el('td', { textContent: s.format.toUpperCase() }),
        el('td', { textContent: fmtSize(s.size) }),
        el('td', { textContent: fmtDate(s.updated_at) }),
        el('td', { className: 'sharing' }, sharing(s)),
        el('td', { className: 'acts' },
          el('button', { textContent: 'Open', onclick: run(() => openCloud(s.id)) }), ' ',
          el('button', { className: 'danger', textContent: 'Delete', onclick: run(() => removeCloud(s.id)) }))));
    }
    box.append(el('table', { className: 'songs-table' }, tb));
  }

  /** Who can listen: Private / Anyone with the link / Public, and the link to copy. */
  function sharing(s) {
    const sel = el('select', { className: `vis-select vis-${s.visibility}`, ariaLabel: `Who can listen to ${s.name}`, title: 'Who can listen' },
      el('option', { value: 'private', textContent: 'Private' }),
      el('option', { value: 'link', textContent: 'Anyone with the link' }),
      el('option', { value: 'public', textContent: 'Public' }));
    sel.value = s.visibility;
    sel.addEventListener('change', run(async () => {
      const v = sel.value;
      try {
        Object.assign(s, await api.setSongSharing(s.id, { visibility: v }));
      } catch (e) {
        sel.value = s.visibility;
        if (e.needsHandle) { app.askForHandle('song'); return; }
        throw e;
      }
      sel.className = `vis-select vis-${s.visibility}`;
      copy.hidden = s.visibility === 'private';
      if (v === 'public') app.toast(`"${s.name}" is public: on your page and in Explore.`);
      else if (v === 'link') app.toast(`Anyone with the link can listen to "${s.name}". Copy it with 🔗.`);
    }));
    const copy = el('button', { className: 'icon-text', textContent: '🔗', title: 'Copy the link', ariaLabel: `Copy the link to ${s.name}`, hidden: s.visibility === 'private',
      onclick: async () => {
        const link = `${location.origin}/s/${s.token}`;
        try { await navigator.clipboard.writeText(link); app.toast('Link copied'); } catch { app.toast(link); }
      } });
    return el('span', { className: 'sharing-ctl' }, sel, copy);
  }

  // E.g. a handle was just chosen: the texts and what can be made public change.
  app.onUserChange.push(() => { if (dialog.open) refresh(); });

  async function openDraft(id) {
    const d = await getDraft(id);
    if (!d) throw new Error('This song is no longer on this device.');
    await app.switchSong(loadDraftSong(d), { serverSong: d.serverSong || null, draftId: id, dirty: true, origin: d.origin || null });
    dialog.close();
    app.toast(`Opened "${d.title}"`);
  }

  async function draftToAccount(id) {
    if (id !== app.draftId) await openDraft(id);
    await app.saveCloud(false);
    refresh();
  }

  async function removeDraft(d) {
    if (!(await confirmDialog({
      title: `Delete "${d.title || 'untitled'}" from this device?`,
      message: d.serverSong ? 'The version saved in your account is kept.' : 'This cannot be undone.',
      confirmText: 'Delete', danger: true,
    }))) return;
    await deleteDraft(d.id);
    if (app.draftId === d.id) app.draftId = null;
    refresh();
  }

  async function openCloud(id) {
    const s = await api.getSong(id);
    await app.switchSong(loadSongFile(s.data, `${s.name}.${s.format}`), { serverSong: { id, name: s.name } });
    dialog.close();
    app.toast(`Opened "${s.name}"`);
  }

  async function removeCloud(id) {
    if (!(await confirmDialog({
      title: 'Delete this song from your account?',
      message: 'It is deleted permanently and removed from your playlists.',
      confirmText: 'Delete', danger: true,
    }))) return;
    await api.deleteSong(id);
    if (app.serverSong?.id === id) app.serverSong = null;
    refresh();
  }

  return {
    open() {
      dialog.showModal();
      box.replaceChildren(el('p', { className: 'muted', textContent: 'Loading…' }));
      refresh();
    },
    refresh,
  };
}
