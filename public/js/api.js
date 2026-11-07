async function json(res) {
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

const post = (url, data) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data ?? {}),
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
  deleteSong: (id) => fetch(`/api/songs/${id}`, { method: 'DELETE', credentials: 'same-origin' }).then(json),
};
