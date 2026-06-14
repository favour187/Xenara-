import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import db from './db.js';
import { hashApiKey } from './security.js';

const JWT_SECRET = process.env.JWT_SECRET || 'xenara-dev-secret-change-me';
const COOKIE_NAME = 'xenara_token';

// Generate a personal API key like: xen_live_<40 hex chars>.
// Returns the plaintext (shown once) and its hash (stored at rest).
export function generateApiKey() {
  const plaintext = 'xen_live_' + crypto.randomBytes(24).toString('hex');
  return { plaintext, hash: hashApiKey(plaintext), preview: plaintext.slice(0, 12) + '…' + plaintext.slice(-4) };
}

export function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: '30d',
    issuer: 'xenara',
  });
}

export function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Auth middleware: accepts a session token (cookie / Bearer JWT) OR a
// personal API key (Bearer xen_... or x-api-key header). Keys are matched
// against their SHA-256 hash; plaintext keys are never stored.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const bearer = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  const apiKeyRaw = req.headers['x-api-key'] || (bearer && bearer.startsWith('xen_') ? bearer : null);

  // 1) Personal API key path.
  if (apiKeyRaw) {
    const keyHash = hashApiKey(apiKeyRaw);
    const user = db
      .prepare('SELECT id, email, is_owner FROM users WHERE api_key_hash = ?')
      .get(keyHash);
    if (!user) return res.status(401).json({ error: 'Invalid API key' });
    req.user = { id: user.id, email: user.email, isOwner: !!user.is_owner };
    req.viaApiKey = true;
    // Track last-used + usage counters.
    db.prepare('UPDATE users SET api_key_last_used = ? WHERE id = ?').run(Date.now(), user.id);
    return next();
  }

  // 2) Session token path.
  const token = req.cookies?.[COOKIE_NAME] || bearer;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET, { issuer: 'xenara' });
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Restrict a route to the owner account only.
export function requireOwner(req, res, next) {
  const u = db.prepare('SELECT is_owner FROM users WHERE id = ?').get(req.user.id);
  if (!u || !u.is_owner) return res.status(403).json({ error: 'Owner only' });
  next();
}
