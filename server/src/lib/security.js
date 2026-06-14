// Xenara security layer — defense in depth.
//
// - Helmet security headers + a strict Content-Security-Policy
// - Per-route rate limiters (auth, api, chat, training)
// - Brute-force login lockout (progressive)
// - API-key hashing (keys stored as SHA-256, never in plaintext at rest)
// - Request id + audit logging helpers
// - Body size limits & input sanitization helpers

import crypto from 'node:crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// ----------------------------- secrets check -----------------------------

export function assertSecrets() {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    if (!secret || secret === 'xenara-dev-secret-change-me' || secret.length < 24) {
      console.error(
        '\n  FATAL: JWT_SECRET is missing or weak in production. Set a long random JWT_SECRET.\n'
      );
      process.exit(1);
    }
  }
}

// ----------------------------- API key hashing -----------------------------

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

// Constant-time compare for tokens/keys.
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ----------------------------- helmet / CSP -----------------------------

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        // Vite build emits hashed JS/CSS served from same origin.
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // inline styles used in app
        imgSrc: ["'self'", 'data:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"], // clickjacking protection
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts:
      process.env.NODE_ENV === 'production'
        ? { maxAge: 15552000, includeSubDomains: true, preload: true }
        : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

// ----------------------------- rate limiters -----------------------------

const makeLimiter = (opts) =>
  rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...opts,
  });

// Global API limiter (generous).
export const apiLimiter = makeLimiter({ windowMs: 60 * 1000, max: 240 });

// Auth endpoints: tighter to slow credential stuffing.
export const authLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many attempts. Please wait and try again.' },
});

// Chat/generation: protect CPU.
export const chatLimiter = makeLimiter({ windowMs: 60 * 1000, max: 60 });

// Training: very expensive — strict.
export const trainLimiter = makeLimiter({ windowMs: 60 * 1000, max: 6 });

// Public API (per API key when present, else per IP).
export const publicApiLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => {
    const k = req.headers['x-api-key'] || req.headers.authorization || req.ip;
    return hashApiKey(k);
  },
});

// ----------------------------- login lockout -----------------------------

const attempts = new Map(); // ip+email -> { count, lockUntil }

export function loginGuard(req, res, next) {
  const id = `${req.ip}:${(req.body?.email || '').toLowerCase()}`;
  const rec = attempts.get(id);
  if (rec?.lockUntil && Date.now() < rec.lockUntil) {
    const secs = Math.ceil((rec.lockUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `Too many failed logins. Try again in ${secs}s.` });
  }
  req._loginId = id;
  next();
}

export function recordLoginFailure(id) {
  const rec = attempts.get(id) || { count: 0, lockUntil: 0 };
  rec.count += 1;
  // Progressive lockout after 5 failures.
  if (rec.count >= 5) {
    const factor = Math.min(rec.count - 4, 6);
    rec.lockUntil = Date.now() + factor * 30 * 1000; // 30s, 60s, ... up to 3m
  }
  attempts.set(id, rec);
}

export function recordLoginSuccess(id) {
  attempts.delete(id);
}

// ----------------------------- request id + audit -----------------------------

export function requestId(req, res, next) {
  req.id = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
}

export function auditLog(req, event, extra = {}) {
  const line = {
    t: new Date().toISOString(),
    id: req.id,
    ip: req.ip,
    event,
    user: req.user?.id || null,
    ...extra,
  };
  // Structured single-line log (easy to ship to a log drain).
  console.log('[audit]', JSON.stringify(line));
}

// ----------------------------- input helpers -----------------------------

export function clampString(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

// Strip control chars that could poison logs/terminals.
export function stripControl(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
