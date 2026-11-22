import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup } from './db.js';
import { authRouter, sessionMiddleware } from './auth.js';
import { songsRouter } from './songs.js';
import { playlistsRouter, sharedPlaylistRouter } from './playlists.js';
import { canonicalHostMiddleware, parseCanonical } from './canonical.js';
import { profileRouter, publicRouter, pageMeta } from './public.js';
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
app.use('/api/profile', profileRouter);
app.use('/api', publicRouter); // /api/u/:handle, /api/s/:token, /api/explore
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const publicDir = path.join(__dirname, '..', 'public');
const canon = parseCanonical(process.env.CANONICAL_HOST);
const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// The app shell. Links to playlists (/p/<token>), songs (/s/<token>), people (/@handle)
// and Explore are opened by the frontend; the head gets a title for link previews.
function sendIndex(req, res) {
  const head = [];
  let html = indexHtml;
  if (canon) {
    // <link rel="canonical"> so search engines index one URL.
    const p = req.path === '/index.html' ? '/' : req.path;
    head.push(`<link rel="canonical" href="${canon.protocol || req.protocol}://${canon.host}${esc(p)}">`);
  }
  const meta = pageMeta(req.path);
  if (meta?.title) {
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title)} – DiscoTracker</title>`);
    head.push(`<meta property="og:title" content="${esc(meta.title)}">`);
  }
  if (meta?.description) {
    head.push(`<meta name="description" content="${esc(meta.description)}">`, `<meta property="og:description" content="${esc(meta.description)}">`);
  }
  // Private and link-only things stay out of search results.
  if (meta?.noindex) head.push('<meta name="robots" content="noindex">');
  res.type('html').send(head.length ? html.replace('</head>', `  ${head.join('\n  ')}\n</head>`) : html);
}
app.get(['/', '/index.html', '/p/:token', '/s/:token', '/explore', /^\/@[^/]+\/?$/], sendIndex);
app.use(express.static(publicDir, { maxAge: 0, etag: true }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Server error' });
});

cleanup();
setInterval(cleanup, 3600e3).unref();

app.listen(PORT, () => console.log(`DiscoTracker listening on :${PORT}`));
