import crypto from 'node:crypto';
import express from 'express';
import { db } from './db.js';
import { requireUser, normalizeEmail } from './auth.js';
import { sendPlaylistInvite } from './mailer.js';
import { publicBaseUrl } from './canonical.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SHARES_PER_PLAYLIST = 100;
const MAX_INVITES_PER_HOUR = 30; // per user, to keep the mail server from being used for spam
const MAX_ITEMS = 500;

const cleanText = (s, max) => String(s ?? '').replace(/[\x00-\x09\x0b-\x1f]/g, '').trim().slice(0, max);
const newToken = () => crypto.randomBytes(12).toString('base64url');

function ownPlaylist(req, res) {
  const p = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!p) res.status(404).json({ error: 'Playlist not found' });
  return p;
}

function items(playlistId) {
  return db
    .prepare(`SELECT s.id, s.name, s.format, s.size FROM playlist_items i JOIN songs s ON s.id = i.song_id
              WHERE i.playlist_id = ? ORDER BY i.position`)
    .all(playlistId);
}

function shares(playlistId) {
  return db
    .prepare('SELECT email, created_at, notified_at FROM playlist_shares WHERE playlist_id = ? ORDER BY created_at')
    .all(playlistId);
}

function ownerView(p, req) {
  return {
    id: p.id,
    token: p.token,
    url: `${publicBaseUrl(req)}/p/${p.token}`,
    name: p.name,
    description: p.description,
    visibility: p.visibility,
    created_at: p.created_at,
    updated_at: p.updated_at,
    tracks: items(p.id),
    shares: shares(p.id),
  };
}

/** Can this request see the playlist? Returns 'owner' | 'shared' | 'public' | null. */
function access(p, user) {
  if (user && user.id === p.user_id) return 'owner';
  if (user && db.prepare('SELECT 1 FROM playlist_shares WHERE playlist_id = ? AND email = ?').get(p.id, user.email)) return 'shared';
  if (p.visibility === 'public') return 'public';
  return null;
}

// ---------------------------------------------------------------------------
// Owner API: /api/playlists

export const playlistsRouter = express.Router();
playlistsRouter.use(requireUser);

playlistsRouter.get('/', (req, res) => {
  const mine = db
    .prepare(`SELECT p.id, p.token, p.name, p.visibility, p.updated_at,
                (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS tracks,
                (SELECT COUNT(*) FROM playlist_shares s WHERE s.playlist_id = p.id) AS shares
              FROM playlists p WHERE p.user_id = ? ORDER BY p.updated_at DESC`)
    .all(req.user.id);
  const shared = db
    .prepare(`SELECT p.token, p.name, p.updated_at, u.email AS owner,
                (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS tracks
              FROM playlist_shares s JOIN playlists p ON p.id = s.playlist_id JOIN users u ON u.id = p.user_id
              WHERE s.email = ? AND p.user_id != ? ORDER BY p.updated_at DESC`)
    .all(req.user.email, req.user.id);
  res.json({ mine, shared });
});

playlistsRouter.post('/', (req, res) => {
  const now = Date.now();
  const name = cleanText(req.body?.name, 100) || 'New playlist';
  const r = db
    .prepare('INSERT INTO playlists (user_id, token, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, newToken(), name, cleanText(req.body?.description, 1000), now, now);
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(r.lastInsertRowid);
  res.json(ownerView(p, req));
});

playlistsRouter.get('/:id', (req, res) => {
  const p = ownPlaylist(req, res);
  if (p) res.json(ownerView(p, req));
});

playlistsRouter.put('/:id', (req, res) => {
  const p = ownPlaylist(req, res);
  if (!p) return;
  const b = req.body || {};
  const name = b.name !== undefined ? cleanText(b.name, 100) || p.name : p.name;
  const description = b.description !== undefined ? cleanText(b.description, 1000) : p.description;
  const visibility = b.visibility === 'public' || b.visibility === 'private' ? b.visibility : p.visibility;

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE playlists SET name = ?, description = ?, visibility = ?, updated_at = ? WHERE id = ?')
      .run(name, description, visibility, Date.now(), p.id);
    if (Array.isArray(b.songIds)) {
      const ids = [...new Set(b.songIds.map(Number).filter(Number.isInteger))].slice(0, MAX_ITEMS);
      // Only the owner's own songs can be put in a playlist.
      const owned = new Set(
        db.prepare('SELECT id FROM songs WHERE user_id = ?').all(req.user.id).map((r) => r.id),
      );
      db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(p.id);
      const ins = db.prepare('INSERT INTO playlist_items (playlist_id, song_id, position) VALUES (?, ?, ?)');
      ids.filter((id) => owned.has(id)).forEach((id, i) => ins.run(p.id, id, i));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json(ownerView(db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.id), req));
});

playlistsRouter.delete('/:id', (req, res) => {
  const p = ownPlaylist(req, res);
  if (!p) return;
  db.prepare('DELETE FROM playlists WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// New share link; the old link stops working.
playlistsRouter.post('/:id/new-link', (req, res) => {
  const p = ownPlaylist(req, res);
  if (!p) return;
  db.prepare('UPDATE playlists SET token = ?, updated_at = ? WHERE id = ?').run(newToken(), Date.now(), p.id);
  res.json(ownerView(db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.id), req));
});

playlistsRouter.post('/:id/shares', async (req, res) => {
  const p = ownPlaylist(req, res);
  if (!p) return;
  const raw = Array.isArray(req.body?.emails) ? req.body.emails : String(req.body?.emails || '').split(/[\s,;]+/);
  const emails = [...new Set(raw.map(normalizeEmail).filter(Boolean))];
  const invalid = emails.filter((e) => !EMAIL_RE.test(e) || e.length > 254);
  if (!emails.length) return res.status(400).json({ error: 'Enter at least one email address.' });
  if (invalid.length) return res.status(400).json({ error: `Not a valid email: ${invalid.join(', ')}` });

  const existing = new Set(shares(p.id).map((s) => s.email));
  const fresh = emails.filter((e) => !existing.has(e) && e !== req.user.email);
  if (existing.size + fresh.length > MAX_SHARES_PER_PLAYLIST) {
    return res.status(400).json({ error: `A playlist can be shared with at most ${MAX_SHARES_PER_PLAYLIST} addresses.` });
  }
  const hour = Date.now() - 3600e3;
  const sentLastHour = db
    .prepare(`SELECT COUNT(*) AS n FROM playlist_shares s JOIN playlists p ON p.id = s.playlist_id
              WHERE p.user_id = ? AND s.notified_at > ?`)
    .get(req.user.id, hour).n;
  if (sentLastHour + fresh.length > MAX_INVITES_PER_HOUR) {
    return res.status(429).json({ error: 'Too many invitations sent in the last hour. Please try again later.' });
  }

  const now = Date.now();
  const ins = db.prepare('INSERT OR IGNORE INTO playlist_shares (playlist_id, email, created_at) VALUES (?, ?, ?)');
  for (const e of fresh) ins.run(p.id, e, now);

  const url = `${publicBaseUrl(req)}/p/${p.token}`;
  const failed = [];
  for (const e of fresh) {
    try {
      await sendPlaylistInvite(e, { from: req.user.email, name: p.name, url, isPublic: p.visibility === 'public' });
      db.prepare('UPDATE playlist_shares SET notified_at = ? WHERE playlist_id = ? AND email = ?').run(Date.now(), p.id, e);
    } catch (err) {
      console.error('[mail] playlist invite failed:', err.message);
      failed.push(e);
    }
  }
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, p.id);
  res.json({ ...ownerView(p, req), added: fresh, failed });
});

playlistsRouter.delete('/:id/shares/:email', (req, res) => {
  const p = ownPlaylist(req, res);
  if (!p) return;
  db.prepare('DELETE FROM playlist_shares WHERE playlist_id = ? AND email = ?').run(p.id, normalizeEmail(req.params.email));
  res.json(ownerView(p, req));
});

// ---------------------------------------------------------------------------
// Listener API: /api/p/:token (public, shared or owner)

export const sharedPlaylistRouter = express.Router();

function byToken(req, res) {
  const p = db.prepare('SELECT * FROM playlists WHERE token = ?').get(req.params.token);
  if (!p) { res.status(404).json({ error: 'This playlist does not exist or the link has been changed.' }); return null; }
  const a = access(p, req.user);
  if (!a) {
    res.status(req.user ? 403 : 401).json({
      error: req.user
        ? `This playlist hasn't been shared with ${req.user.email}.`
        : 'This playlist is private. Sign in with the email address it was shared with.',
      needsSignIn: !req.user,
    });
    return null;
  }
  return { p, access: a };
}

sharedPlaylistRouter.get('/:token', (req, res) => {
  const r = byToken(req, res);
  if (!r) return;
  const { p, access: a } = r;
  res.json({
    token: p.token,
    id: a === 'owner' ? p.id : undefined,
    name: p.name,
    description: p.description,
    visibility: p.visibility,
    access: a,
    // The owner's email is only shown to people it was explicitly shared with.
    owner: a === 'shared' ? db.prepare('SELECT email FROM users WHERE id = ?').get(p.user_id).email : undefined,
    tracks: items(p.id),
  });
});

sharedPlaylistRouter.get('/:token/songs/:songId', (req, res) => {
  const r = byToken(req, res);
  if (!r) return;
  const row = db
    .prepare(`SELECT s.name, s.format, s.data FROM playlist_items i JOIN songs s ON s.id = i.song_id
              WHERE i.playlist_id = ? AND s.id = ?`)
    .get(r.p.id, req.params.songId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Song-Name', encodeURIComponent(row.name));
  res.set('X-Song-Format', row.format);
  res.set('Cache-Control', 'private, no-store');
  res.send(Buffer.from(row.data));
});
