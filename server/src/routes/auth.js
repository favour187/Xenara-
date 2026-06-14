import express from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { nanoid } from 'nanoid';
import db, { ownerExists, recordAudit } from '../lib/db.js';
import {
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  generateApiKey,
} from '../lib/auth.js';
import { loginGuard, recordLoginFailure, recordLoginSuccess, auditLog } from '../lib/security.js';

const router = express.Router();

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isOwner: !!u.is_owner,
    apiKeyPreview: u.api_key_preview || null,
    apiKeyCreated: u.api_key_created || null,
    totpEnabled: !!u.totp_enabled,
    settings: JSON.parse(u.settings || '{}'),
  };
}

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: errors.array()[0].msg });
    return false;
  }
  return true;
}

// Whether registration is open (only until the single owner exists).
router.get('/status', (req, res) => {
  res.json({ ownerExists: ownerExists(), registrationOpen: !ownerExists() });
});

router.post(
  '/register',
  body('email').isEmail().withMessage('A valid email is required.').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
  body('name').optional().isLength({ max: 80 }).trim().escape(),
  (req, res) => {
    if (ownerExists()) {
      return res.status(403).json({
        error: 'Registration is closed. This Xenara instance is owned by a single user.',
      });
    }
    if (!validate(req, res)) return;

    const { email, name, password } = req.body;
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (exists) return res.status(409).json({ error: 'An account with that email already exists.' });

    const key = generateApiKey();
    const user = {
      id: nanoid(),
      email: email.toLowerCase(),
      name: (name || email.split('@')[0]).trim(),
      password: bcrypt.hashSync(password, 12),
      settings: '{}',
      created_at: Date.now(),
      is_owner: 1,
      api_key_hash: key.hash,
      api_key_preview: key.preview,
      api_key_created: Date.now(),
    };
    db.prepare(
      `INSERT INTO users (id, email, name, password, settings, created_at, is_owner, api_key_hash, api_key_preview, api_key_created)
       VALUES (@id,@email,@name,@password,@settings,@created_at,@is_owner,@api_key_hash,@api_key_preview,@api_key_created)`
    ).run(user);

    recordAudit({ userId: user.id, event: 'owner_registered', ip: req.ip });
    auditLog(req, 'owner_registered', { email: user.email });

    const token = signToken(user);
    setAuthCookie(res, token);
    // Plaintext API key returned exactly once.
    res.json({ user: publicUser(user), token, apiKey: key.plaintext });
  }
);

router.post(
  '/login',
  loginGuard,
  body('email').isEmail().normalizeEmail(),
  body('password').isString().notEmpty(),
  (req, res) => {
    if (!validate(req, res)) return;
    const { email, password } = req.body;

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.password)) {
      recordLoginFailure(req._loginId);
      recordAudit({ userId: user?.id || null, event: 'login_failed', ip: req.ip, detail: { email } });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    recordLoginSuccess(req._loginId);
    recordAudit({ userId: user.id, event: 'login_success', ip: req.ip });

    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token });
  }
);

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

// Show key metadata (never the secret again).
router.get('/api-key', requireAuth, (req, res) => {
  const user = db.prepare('SELECT api_key_preview, api_key_created, api_key_last_used FROM users WHERE id = ?').get(req.user.id);
  res.json({
    preview: user?.api_key_preview || null,
    created: user?.api_key_created || null,
    lastUsed: user?.api_key_last_used || null,
  });
});

// Rotate (regenerate) the personal API key — returns plaintext once.
router.post('/api-key/rotate', requireAuth, (req, res) => {
  if (req.viaApiKey) return res.status(403).json({ error: 'Use your dashboard session to rotate the key.' });
  const key = generateApiKey();
  db.prepare('UPDATE users SET api_key_hash = ?, api_key_preview = ?, api_key_created = ?, api_key_last_used = NULL WHERE id = ?')
    .run(key.hash, key.preview, Date.now(), req.user.id);
  recordAudit({ userId: req.user.id, event: 'api_key_rotated', ip: req.ip });
  res.json({ apiKey: key.plaintext, preview: key.preview });
});

router.put(
  '/settings',
  requireAuth,
  body('settings').optional().isObject(),
  (req, res) => {
    const settings = JSON.stringify(req.body?.settings || {});
    if (settings.length > 20000) return res.status(400).json({ error: 'Settings too large.' });
    db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(settings, req.user.id);
    res.json({ ok: true, settings: JSON.parse(settings) });
  }
);

// Change password (requires current password).
router.post(
  '/change-password',
  requireAuth,
  body('current').isString().notEmpty(),
  body('next').isLength({ min: 8 }).withMessage('New password must be at least 8 characters.'),
  (req, res) => {
    if (req.viaApiKey) return res.status(403).json({ error: 'Use your dashboard session.' });
    if (!validate(req, res)) return;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user || !bcrypt.compareSync(req.body.current, user.password)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(req.body.next, 12), user.id);
    recordAudit({ userId: user.id, event: 'password_changed', ip: req.ip });
    res.json({ ok: true });
  }
);

export default router;
