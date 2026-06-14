// Usage analytics & audit — owner only.

import express from 'express';
import db from '../lib/db.js';
import { requireAuth, requireOwner } from '../lib/auth.js';

const router = express.Router();
router.use(requireAuth, requireOwner);

router.get('/usage', (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(in_chars),0) AS in_chars,
              COALESCE(SUM(out_chars),0) AS out_chars,
              SUM(CASE WHEN via_key=1 THEN 1 ELSE 0 END) AS via_key_calls
       FROM api_usage WHERE created_at >= ?`
    )
    .get(since);

  const byEndpoint = db
    .prepare(
      `SELECT endpoint, COUNT(*) AS calls, COALESCE(SUM(out_chars),0) AS out_chars
       FROM api_usage WHERE created_at >= ? GROUP BY endpoint ORDER BY calls DESC`
    )
    .all(since);

  // Daily buckets.
  const rows = db
    .prepare('SELECT created_at, out_chars FROM api_usage WHERE created_at >= ?')
    .all(since);
  const daily = {};
  for (const r of rows) {
    const day = new Date(r.created_at).toISOString().slice(0, 10);
    daily[day] = (daily[day] || 0) + 1;
  }

  const learn = db
    .prepare(
      `SELECT COUNT(*) AS updates, COALESCE(SUM(chars),0) AS chars, AVG(loss) AS avg_loss
       FROM learn_log WHERE created_at >= ?`
    )
    .get(since);

  res.json({ days, totals, byEndpoint, daily, learn });
});

router.get('/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const events = db
    .prepare('SELECT event, ip, detail, created_at FROM audit_events ORDER BY id DESC LIMIT ?')
    .all(limit);
  res.json({ events });
});

export default router;
