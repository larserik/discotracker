import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup } from './db.js';
import { authRouter, sessionMiddleware } from './auth.js';
import { songsRouter } from './songs.js';
import { canonicalHostMiddleware, parseCanonical } from './canonical.js';
import fs from 'node:fs';

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

app.use(canonicalHostMiddleware(process.env.CANONICAL_HOST));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use('/api', express.json({ limit: '16kb' }), sessionMiddleware);
app.use('/api/auth', authRouter);
app.use('/api/songs', songsRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const publicDir = path.join(__dirname, '..', 'public');
const canon = parseCanonical(process.env.CANONICAL_HOST);
if (canon) {
  // Start page with <link rel="canonical"> so search engines index one URL.
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  app.get(['/', '/index.html'], (req, res) => {
    const href = `${canon.protocol || req.protocol}://${canon.host}/`;
    res.type('html').send(html.replace('</head>', `  <link rel="canonical" href="${href}">\n</head>`));
  });
}
app.use(express.static(publicDir, { maxAge: 0, etag: true }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Server error' });
});

cleanup();
setInterval(cleanup, 3600e3).unref();

app.listen(PORT, () => console.log(`DiscoTracker listening on :${PORT}`));
