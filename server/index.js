import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup } from './db.js';
import { authRouter, sessionMiddleware } from './auth.js';
import { songsRouter } from './songs.js';
import { playlistsRouter, sharedPlaylistRouter } from './playlists.js';
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
app.use('/api/playlists', playlistsRouter);
app.use('/api/p', sharedPlaylistRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const publicDir = path.join(__dirname, '..', 'public');
const canon = parseCanonical(process.env.CANONICAL_HOST);
const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

// The app shell. Playlist links (/p/<token>) are opened by the frontend.
function sendIndex(req, res) {
  const head = [];
  if (canon) {
    // <link rel="canonical"> so search engines index one URL.
    const p = req.path === '/index.html' ? '/' : req.path;
    head.push(`<link rel="canonical" href="${canon.protocol || req.protocol}://${canon.host}${p}">`);
  }
  // Shared playlists are unlisted: keep them out of search results.
  if (req.path.startsWith('/p/')) head.push('<meta name="robots" content="noindex">');
  res.type('html').send(head.length ? indexHtml.replace('</head>', `  ${head.join('\n  ')}\n</head>`) : indexHtml);
}
app.get(['/', '/index.html', '/p/:token'], sendIndex);
app.use(express.static(publicDir, { maxAge: 0, etag: true }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Server error' });
});

cleanup();
setInterval(cleanup, 3600e3).unref();

app.listen(PORT, () => console.log(`DiscoTracker listening on :${PORT}`));
