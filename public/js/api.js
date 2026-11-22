async function json(res) {
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error(body?.error || `Request failed (${res.status})`);
    e.status = res.status;
    e.needsHandle = !!body?.needsHandle;
    throw e;
  }
  return body;
}

const post = (url, data) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data ?? {}),
  credentials: 'same-origin',
}).then(json);

const send = (method, url, data) => fetch(url, {
  method,
  headers: data ? { 'Content-Type': 'application/json' } : {},
  body: data ? JSON.stringify(data) : undefined,
  credentials: 'same-origin',
}).then(json);

export const api = {
  me: () => fetch('/api/auth/me', { credentials: 'same-origin' }).then(json),
  requestCode: (email) => post('/api/auth/request-code', { email }),
  verify: (email, code) => post('/api/auth/verify', { email, code }),
  logout: () => post('/api/auth/logout'),

  listSongs: () => fetch('/api/songs', { credentials: 'same-origin' }).then(json),
  async getSong(id) {
    const res = await fetch(`/api/songs/${id}`, { credentials: 'same-origin' });
    if (!res.ok) await json(res);
    return {
      name: decodeURIComponent(res.headers.get('X-Song-Name') || 'untitled'),
      format: res.headers.get('X-Song-Format') || 'xm',
      data: await res.arrayBuffer(),
    };
  },
  saveSong({ id, name, format, data }) {
    const q = `?name=${encodeURIComponent(name)}&format=${encodeURIComponent(format)}`;
    return fetch(id ? `/api/songs/${id}${q}` : `/api/songs${q}`, {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
      credentials: 'same-origin',
    }).then(json);
  },
  // playlists (owner)
  listPlaylists: () => fetch('/api/playlists', { credentials: 'same-origin' }).then(json),
  createPlaylist: (data) => post('/api/playlists', data),
  getPlaylist: (id) => fetch(`/api/playlists/${id}`, { credentials: 'same-origin' }).then(json),
  updatePlaylist: (id, data) => send('PUT', `/api/playlists/${id}`, data),
  deletePlaylist: (id) => send('DELETE', `/api/playlists/${id}`),
  newPlaylistLink: (id) => post(`/api/playlists/${id}/new-link`),
  sharePlaylist: (id, emails) => post(`/api/playlists/${id}/shares`, { emails }),
  unsharePlaylist: (id, email) => send('DELETE', `/api/playlists/${id}/shares/${encodeURIComponent(email)}`),
  // playlists (listener)
  async openShared(token) {
    const res = await fetch(`/api/p/${encodeURIComponent(token)}`, { credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(body.error || `Request failed (${res.status})`); e.status = res.status; e.needsSignIn = body.needsSignIn; throw e; }
    return body;
  },
  async getSharedSong(token, songId) {
    const res = await fetch(`/api/p/${encodeURIComponent(token)}/songs/${songId}`, { credentials: 'same-origin' });
    if (!res.ok) await json(res);
    return {
      name: decodeURIComponent(res.headers.get('X-Song-Name') || 'untitled'),
      format: res.headers.get('X-Song-Format') || 'xm',
      data: await res.arrayBuffer(),
    };
  },
  setSongSharing: (id, data) => send('PATCH', `/api/songs/${id}`, data),
  // profile
  checkHandle: (h) => fetch(`/api/profile/handle/${encodeURIComponent(h)}`, { credentials: 'same-origin' }).then(json),
  saveProfile: (data) => send('PUT', '/api/profile', data),
  // public: people, song links, explore
  getProfile: (handle) => fetch(`/api/u/${encodeURIComponent(handle)}`, { credentials: 'same-origin' }).then(json),
  getPublicSong: (token) => fetch(`/api/s/${encodeURIComponent(token)}`, { credentials: 'same-origin' }).then(json),
  async getPublicSongData(token) {
    const res = await fetch(`/api/s/${encodeURIComponent(token)}/data`, { credentials: 'same-origin' });
    if (!res.ok) await json(res);
    return {
      name: decodeURIComponent(res.headers.get('X-Song-Name') || 'untitled'),
      format: res.headers.get('X-Song-Format') || 'xm',
      data: await res.arrayBuffer(),
    };
  },
  explore: ({ type, q = '', sort = 'new', offset = 0 }) =>
    fetch(`/api/explore?type=${type}&q=${encodeURIComponent(q)}&sort=${sort}&offset=${offset}`, { credentials: 'same-origin' }).then(json),
  deleteSong: (id) => fetch(`/api/songs/${id}`, { method: 'DELETE', credentials: 'same-origin' }).then(json),
};
