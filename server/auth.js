import crypto from 'node:crypto';
import express from 'express';
import { db } from './db.js';
import { sendLoginCode } from './mailer.js';

const CODE_TTL = 10 * 60e3;
const SESSION_TTL = 60 * 24 * 3600e3;
const MAX_ATTEMPTS = 5;
const COOKIE = 'dt_session';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(e) {
  return typeof e === 'string' ? e.trim().toLowerCase() : '';
}

// Very small in-memory per-IP limiter (sufficient for a single container).
const ipHits = new Map();
function ipLimited(ip, limit, windowMs) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) { ipHits.set(ip, hits); return true; }
  hits.push(now);
  ipHits.set(ip, hits);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits) if (!hits.some((t) => now - t < 3600e3)) ipHits.delete(ip);
}, 600e3).unref();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Attaches req.user if a valid session cookie is present. */
export function sessionMiddleware(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = db
      .prepare(`SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > ?`)
      .get(sha256(token), Date.now());
    if (row) req.user = { id: row.id, email: row.email };
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

export const authRouter = express.Router();

authRouter.get('/me', (req, res) => {
  res.json({ user: req.user || null });
});

authRouter.post('/request-code', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (ipLimited(req.ip, 20, 3600e3)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  const now = Date.now();
  const recent = db
    .prepare('SELECT created_at FROM login_codes WHERE email = ? AND created_at > ? ORDER BY created_at DESC')
    .all(email, now - 3600e3);
  if (recent.length && now - recent[0].created_at < 30e3) {
    return res.status(429).json({ error: 'A code was just sent. Wait a few seconds before requesting a new one.' });
  }
  if (recent.length >= 6) {
    return res.status(429).json({ error: 'Too many codes requested. Please try again later.' });
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  // Invalidate older codes for this address; only the newest one works.
  db.prepare('UPDATE login_codes SET used = 1 WHERE email = ? AND used = 0').run(email);
  db.prepare('INSERT INTO login_codes (email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(email, sha256(`${email}:${code}`), now, now + CODE_TTL);

  try {
    await sendLoginCode(email, code);
  } catch (err) {
    console.error('[mail] failed to send login code:', err.message);
    return res.status(502).json({ error: 'Could not send the email right now. Please try again.' });
  }
  res.json({ ok: true });
});

authRouter.post('/verify', (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code ?? '').replace(/\D/g, '');
  if (!email || code.length !== 6) return res.status(400).json({ error: 'Enter the 6-digit code.' });
  if (ipLimited(`verify:${req.ip}`, 60, 3600e3)) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  const now = Date.now();
  const row = db
    .prepare(`SELECT id, code_hash, attempts FROM login_codes
              WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1`)
    .get(email, now);
  if (!row) return res.status(400).json({ error: 'The code has expired. Request a new one.' });
  if (row.attempts >= MAX_ATTEMPTS) {
    db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id);
    return res.status(400).json({ error: 'Too many wrong attempts. Request a new code.' });
  }

  const a = Buffer.from(row.code_hash, 'hex');
  const b = Buffer.from(sha256(`${email}:${code}`), 'hex');
  if (!crypto.timingSafeEqual(a, b)) {
    db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return res.status(400).json({ error: left > 0 ? `Wrong code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Wrong code. Request a new one.' });
  }

  db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id);

  let user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!user) {
    const r = db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)').run(email, now);
    user = { id: Number(r.lastInsertRowid), email };
  }
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);

  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), user.id, now, now + SESSION_TTL);

  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_TTL,
    path: '/',
  });
  res.json({ user: { id: user.id, email: user.email } });
});

authRouter.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});
