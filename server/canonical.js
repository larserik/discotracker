// Redirect every request to one canonical host (e.g. www.example.com -> example.com)
// so users and search engines always end up on the same URL.
//
// CANONICAL_HOST=example.com           keep the request's protocol, fix the host
// CANONICAL_HOST=https://example.com   also force https
import net from 'node:net';

export function parseCanonical(value) {
  const raw = (value || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  const hasScheme = /^https?:\/\//i.test(raw);
  const url = new URL(hasScheme ? raw : `http://${raw}`);
  return {
    protocol: hasScheme ? url.protocol.replace(':', '') : null,
    host: url.host.toLowerCase(), // includes port if given
    hostname: url.hostname.toLowerCase(),
  };
}

const isLocal = (h) => h === 'localhost' || net.isIP(h.replace(/^\[|\]$/g, '')) !== 0;

export function canonicalHostMiddleware(value) {
  const canon = parseCanonical(value);
  if (!canon) return (_req, _res, next) => next();
  console.log(`Canonical host: ${canon.protocol ? canon.protocol + '://' : ''}${canon.host}`);

  return (req, res, next) => {
    // Health checks and direct access by IP / localhost (local testing) are left alone.
    if (req.path === '/healthz') return next();
    const hostname = (req.hostname || '').toLowerCase();
    if (!hostname || isLocal(hostname)) return next();

    const wrongHost = hostname !== canon.hostname;
    // Only enforce the protocol when the proxy tells us what it is, otherwise
    // a proxy that doesn't send X-Forwarded-Proto would cause a redirect loop.
    const wrongProto = canon.protocol && req.get('x-forwarded-proto') && req.protocol !== canon.protocol;
    if (!wrongHost && !wrongProto) return next();

    const target = `${canon.protocol || req.protocol}://${canon.host}${req.originalUrl}`;
    // 301 for normal page loads; 308 keeps the method/body for API calls.
    res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, target);
  };
}
