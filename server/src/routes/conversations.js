import express from 'express';
import { nanoid } from 'nanoid';
import db from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

const router = express.Router();
router.use(requireAuth);

// List conversations for current user
router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.user.id);
  res.json({ conversations: rows });
});

// Create a conversation
router.post('/', (req, res) => {
  const now = Date.now();
  const convo = {
    id: nanoid(),
    user_id: req.user.id,
    title: (req.body?.title || 'New chat').slice(0, 120),
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    'INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (@id,@user_id,@title,@created_at,@updated_at)'
  ).run(convo);
  res.json({ conversation: convo });
});

// Get a conversation + its messages
router.get('/:id', (req, res) => {
  const convo = db
    .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  const messages = db
    .prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(convo.id);
  res.json({ conversation: convo, messages });
});

// Rename
router.put('/:id', (req, res) => {
  const convo = db
    .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  const title = (req.body?.title || convo.title).slice(0, 120);
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), convo.id);
  res.json({ ok: true, title });
});

// Delete
router.delete('/:id', (req, res) => {
  const info = db
    .prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ ok: true });
});

export default router;
