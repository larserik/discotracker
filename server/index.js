import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup } from './db.js';
import { authRouter, sessionMiddleware } from './auth.js';
import { songsRouter } from './songs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 80);

const app = express();
app.disable('x-powered-by');
// Behind the nginx reverse proxy in production: trust X-Forwarded-* from it.
app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal');

app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use('/api', express.json({ limit: '16kb' }), sessionMiddleware);
app.use('/api/auth', authRouter);
app.use('/api/songs', songsRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0, etag: true }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Server error' });
});

cleanup();
setInterval(cleanup, 3600e3).unref();

app.listen(PORT, () => console.log(`DiscoTracker listening on :${PORT}`));
