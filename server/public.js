// Public side of the site: handles and profile pages (/@handle), public song links (/s/<token>)
// and Explore (search and browse public songs, playlists and people).
//
// Visibility of songs and playlists:
//   private  only the owner (playlists: also people invited by email)
//   link     anyone with the link, but not listed anywhere
//   public   listed on the owner's page and in Explore (needs a handle)
import express from 'express';
import { db } from './db.js';
import { requireUser } from './auth.js';

export const VISIBILITIES = new Set(['private', 'link', 'public']);
export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$/;
const RESERVED = new Set([
  'admin', 'administrator', 'api', 'app', 'about', 'blog', 'contact', 'discotracker', 'disco', 'tracker', 'explore', 'search',
  'help', 'support', 'settings', 'account', 'login', 'logout', 'signin', 'signup', 'register', 'root', 'system', 'staff',
  'mod', 'moderator', 'official', 'team', 'security', 'privacy', 'terms', 'legal', 'www', 'mail', 'email', 'null', 'undefined',
  'me', 'you', 'user', 'users', 'song', 'songs', 'playlist', 'playlists', 'static', 'assets', 'css', 'js', 'healthz',
]);
const PAGE = 30;

const cleanText = (s, max) => String(s ?? '').replace(/[\x00-\x09\x0b-\x1f]/g, '').trim().slice(0, max);

/** Why this handle can't be used, or null if it is fine (ignores who has it). */
export function handleProblem(h) {
  if (!h) return 'Enter a handle.';
  if (h.length < 3) return 'At least 3 characters.';
  if (h.length > 30) return 'At most 30 characters.';
  if (!HANDLE_RE.test(h)) return 'Use a–z, 0–9, - and _ (start and end with a letter or digit).';
  if (RESERVED.has(h)) return 'That handle is reserved.';
  return null;
}
export const normalizeHandle = (h) => String(h ?? '').trim().replace(/^@/, '').toLowerCase();

/** The public face of a user: never the email. */
export function publicUser(u) {
  if (!u?.handle) return null;
  return { handle: u.handle, name: u.display_name || u.handle };
}

// Counting plays: once per visitor and item every few hours, kept in memory.
const seen = new Map();
export function countPlay(req, table, id) {
  if (req.user && db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND user_id = ?`).get(id, req.user.id)) return; // own plays
  const key = `${req.ip}:${table}:${id}`;
  const now = Date.now();
  if (now - (seen.get(key) || 0) < 6 * 3600e3) return;
  seen.set(key, now);
  db.prepare(`UPDATE ${table} SET plays = plays + 1 WHERE id = ?`).run(id);
}
setInterval(() => {
  const old = Date.now() - 6 * 3600e3;
  for (const [k, t] of seen) if (t < old) seen.delete(k);
}, 600e3).unref();

// LIKE with the user's text taken literally.
const likeTerm = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const words = (q) => cleanText(q, 100).split(/\s+/).filter(Boolean).slice(0, 6);
/** "(a LIKE ? OR b LIKE ?) AND (...)" for every word, each word matching any of the columns. */
function searchWhere(q, columns) {
  const ws = words(q);
  if (!ws.length) return { sql: '1', args: [] };
  return {
    sql: ws.map(() => `(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`).join(' AND '),
    args: ws.flatMap((w) => columns.map(() => likeTerm(w))),
  };
}

const songRow = (r) => ({
  token: r.token, name: r.name, description: r.description, format: r.format, size: r.size,
  plays: r.plays, published_at: r.published_at, owner: { handle: r.handle, name: r.display_name || r.handle },
});
const playlistRow = (r) => ({
  token: r.token, name: r.name, description: r.description, tracks: r.tracks,
  plays: r.plays, published_at: r.published_at, owner: { handle: r.handle, name: r.display_name || r.handle },
});

const SONG_SQL = `SELECT s.token, s.name, s.description, s.format, s.size, s.plays, s.published_at, u.handle, u.display_name
  FROM songs s JOIN users u ON u.id = s.user_id
  WHERE s.visibility = 'public' AND u.handle IS NOT NULL`;
const PLAYLIST_SQL = `SELECT p.token, p.name, p.description, p.plays, p.published_at, u.handle, u.display_name,
    (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS tracks
  FROM playlists p JOIN users u ON u.id = p.user_id
  WHERE p.visibility = 'public' AND u.handle IS NOT NULL`;

// ---------------------------------------------------------------------------
// Profile of the signed-in user: /api/profile

export const profileRouter = express.Router();
profileRouter.use(requireUser);

profileRouter.get('/handle/:handle', (req, res) => {
  const h = normalizeHandle(req.params.handle);
  const problem = handleProblem(h);
  if (problem) return res.json({ available: false, error: problem });
  const taken = db.prepare('SELECT id FROM users WHERE handle = ?').get(h);
  res.json({ available: !taken || taken.id === req.user.id, error: taken && taken.id !== req.user.id ? 'That handle is taken.' : null });
});

profileRouter.put('/', (req, res) => {
  const b = req.body || {};
  const me = db.prepare('SELECT handle, display_name, bio FROM users WHERE id = ?').get(req.user.id);
  let handle = me.handle;
  if (b.handle !== undefined) {
    const h = normalizeHandle(b.handle);
    if (!h && me.handle) {
      // Giving up the handle: the page is gone and public things are no longer listed
      // (they still work by link, like "link").
      handle = null;
    } else if (h !== me.handle) {
      const problem = handleProblem(h);
      if (problem) return res.status(400).json({ error: problem });
      if (db.prepare('SELECT 1 FROM users WHERE handle = ? AND id != ?').get(h, req.user.id)) return res.status(409).json({ error: 'That handle is taken.' });
      handle = h;
    }
  }
  const name = b.name !== undefined ? cleanText(b.name, 50) : me.display_name;
  const bio = b.bio !== undefined ? cleanText(b.bio, 500) : me.bio;
  db.prepare('UPDATE users SET handle = ?, display_name = ?, bio = ? WHERE id = ?').run(handle, name, bio, req.user.id);
  res.json({ user: userView(req.user.id) });
});

/** What /api/auth/me returns about the signed-in user. */
export function userView(id) {
  const u = db.prepare('SELECT id, email, handle, display_name, bio FROM users WHERE id = ?').get(id);
  return u && { id: u.id, email: u.email, handle: u.handle || null, name: u.display_name, bio: u.bio };
}

// ---------------------------------------------------------------------------
// Public pages: /api/u/:handle, /api/s/:token, /api/explore

export const publicRouter = express.Router();

publicRouter.get('/u/:handle', (req, res) => {
  const u = db.prepare('SELECT id, handle, display_name, bio, created_at FROM users WHERE handle = ?').get(normalizeHandle(req.params.handle));
  if (!u) return res.status(404).json({ error: 'There is no one with that handle.' });
  const songs = db.prepare(`${SONG_SQL} AND s.user_id = ? ORDER BY s.published_at DESC LIMIT 200`).all(u.id).map(songRow);
  const playlists = db.prepare(`${PLAYLIST_SQL} AND p.user_id = ? ORDER BY p.published_at DESC LIMIT 200`).all(u.id).map(playlistRow);
  res.json({
    handle: u.handle, name: u.display_name || u.handle, bio: u.bio, since: u.created_at,
    plays: songs.reduce((n, s) => n + s.plays, 0) + playlists.reduce((n, p) => n + p.plays, 0),
    me: req.user?.id === u.id,
    songs, playlists,
  });
});

/** A song by its link token, if this request may see it. */
function songByToken(req, res) {
  const s = db.prepare(`SELECT s.*, u.handle, u.display_name FROM songs s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(req.params.token);
  const mine = s && req.user?.id === s.user_id;
  if (!s || (!mine && s.visibility === 'private')) {
    res.status(404).json({ error: 'This song does not exist, or it is not shared any more.' });
    return null;
  }
  return { s, mine };
}

publicRouter.get('/s/:token', (req, res) => {
  const r = songByToken(req, res);
  if (!r) return;
  const { s, mine } = r;
  res.json({
    token: s.token, id: s.id, name: s.name, description: s.description, format: s.format, size: s.size,
    visibility: s.visibility, plays: s.plays, published_at: s.published_at, access: mine ? 'owner' : 'public',
    owner: publicUser(s),
  });
});

publicRouter.get('/s/:token/data', (req, res) => {
  const r = songByToken(req, res);
  if (!r) return;
  countPlay(req, 'songs', r.s.id);
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Song-Name', encodeURIComponent(r.s.name));
  res.set('X-Song-Format', r.s.format);
  res.set('Cache-Control', 'private, no-store');
  res.send(Buffer.from(r.s.data));
});

publicRouter.get('/explore', (req, res) => {
  const type = ['songs', 'playlists', 'people'].includes(req.query.type) ? req.query.type : 'songs';
  const popular = req.query.sort === 'popular';
  const offset = Math.max(0, Math.min(10000, Number(req.query.offset) || 0));
  const q = String(req.query.q || '');
  let rows;
  if (type === 'songs') {
    const w = searchWhere(q, ['s.name', 's.description', 'u.handle', 'u.display_name']);
    rows = db.prepare(`${SONG_SQL} AND ${w.sql} ORDER BY ${popular ? 's.plays DESC,' : ''} s.published_at DESC LIMIT ? OFFSET ?`)
      .all(...w.args, PAGE + 1, offset).map(songRow);
  } else if (type === 'playlists') {
    const w = searchWhere(q, ['p.name', 'p.description', 'u.handle', 'u.display_name']);
    rows = db.prepare(`${PLAYLIST_SQL} AND ${w.sql} ORDER BY ${popular ? 'p.plays DESC,' : ''} p.published_at DESC LIMIT ? OFFSET ?`)
      .all(...w.args, PAGE + 1, offset).map(playlistRow);
  } else {
    const w = searchWhere(q, ['u.handle', 'u.display_name', 'u.bio']);
    // People with a handle and at least one public song or playlist.
    rows = db.prepare(`SELECT * FROM (
        SELECT u.handle, u.display_name, u.bio, u.created_at,
          (SELECT COUNT(*) FROM songs s WHERE s.user_id = u.id AND s.visibility = 'public') AS songs,
          (SELECT COUNT(*) FROM playlists p WHERE p.user_id = u.id AND p.visibility = 'public') AS playlists,
          (SELECT COALESCE(SUM(plays), 0) FROM songs s WHERE s.user_id = u.id AND s.visibility = 'public') +
          (SELECT COALESCE(SUM(plays), 0) FROM playlists p WHERE p.user_id = u.id AND p.visibility = 'public') AS plays,
          (SELECT MAX(published_at) FROM songs s WHERE s.user_id = u.id AND s.visibility = 'public') AS latest
        FROM users u WHERE u.handle IS NOT NULL AND ${w.sql})
      WHERE songs + playlists > 0
      ORDER BY ${popular ? 'plays DESC,' : ''} COALESCE(latest, created_at) DESC LIMIT ? OFFSET ?`)
      .all(...w.args, PAGE + 1, offset)
      .map((r) => ({ handle: r.handle, name: r.display_name || r.handle, bio: r.bio, songs: r.songs, playlists: r.playlists, plays: r.plays }));
  }
  res.json({ type, items: rows.slice(0, PAGE), more: rows.length > PAGE, offset });
});

/** Title and description for the HTML head of /@handle, /s/<token> and /p/<token> (link previews, search engines). */
export function pageMeta(path) {
  let m = /^\/@([^/]+)\/?$/.exec(path);
  if (m) {
    const u = db.prepare('SELECT handle, display_name, bio FROM users WHERE handle = ?').get(normalizeHandle(decodeURIComponent(m[1])));
    if (!u) return { noindex: true };
    return { title: `${u.display_name || u.handle} (@${u.handle})`, description: u.bio || `Songs and playlists by @${u.handle} on DiscoTracker` };
  }
  m = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(path);
  if (m) {
    const s = db.prepare('SELECT s.name, s.description, s.visibility, u.handle FROM songs s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(m[1]);
    if (!s || s.visibility === 'private') return { noindex: true };
    return {
      title: s.handle ? `${s.name} by @${s.handle}` : s.name,
      description: s.description || 'A song made with DiscoTracker',
      noindex: s.visibility !== 'public',
    };
  }
  m = /^\/p\/([A-Za-z0-9_-]+)\/?$/.exec(path);
  if (m) {
    const p = db.prepare('SELECT p.name, p.description, p.visibility, u.handle FROM playlists p JOIN users u ON u.id = p.user_id WHERE p.token = ?').get(m[1]);
    // Private playlists: don't even reveal the name.
    if (!p || p.visibility === 'private') return { noindex: true };
    return {
      title: p.handle && p.visibility === 'public' ? `${p.name} – playlist by @${p.handle}` : `${p.name} – playlist`,
      description: p.description || 'A playlist on DiscoTracker',
      noindex: p.visibility !== 'public',
    };
  }
  return null;
}
