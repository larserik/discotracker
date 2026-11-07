import express from 'express';
import { db } from './db.js';
import { requireUser } from './auth.js';

const MAX_SIZE = 32 * 1024 * 1024;
const FORMATS = new Set(['mod', 'xm', 's3m', 'stm', 'it']);

export const songsRouter = express.Router();
songsRouter.use(requireUser);

const cleanName = (n) => String(n || 'untitled').replace(/[\x00-\x1f]/g, '').trim().slice(0, 100) || 'untitled';
const cleanFormat = (f) => (FORMATS.has(String(f).toLowerCase()) ? String(f).toLowerCase() : null);

songsRouter.get('/', (req, res) => {
  const songs = db
    .prepare('SELECT id, name, format, size, created_at, updated_at FROM songs WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.user.id);
  res.json({ songs });
});

songsRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT name, format, data FROM songs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Song-Name', encodeURIComponent(row.name));
  res.set('X-Song-Format', row.format);
  res.send(Buffer.from(row.data));
});

const raw = express.raw({ type: '*/*', limit: MAX_SIZE });

songsRouter.post('/', raw, (req, res) => {
  const format = cleanFormat(req.query.format);
  if (!format || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Bad upload' });
  const now = Date.now();
  const r = db
    .prepare('INSERT INTO songs (user_id, name, format, data, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, cleanName(req.query.name), format, req.body, req.body.length, now, now);
  res.json({ id: Number(r.lastInsertRowid) });
});

songsRouter.put('/:id', raw, (req, res) => {
  const format = cleanFormat(req.query.format);
  if (!format || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Bad upload' });
  const r = db
    .prepare('UPDATE songs SET name = ?, format = ?, data = ?, size = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(cleanName(req.query.name), format, req.body, req.body.length, Date.now(), req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ id: Number(req.params.id) });
});

songsRouter.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM songs WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
