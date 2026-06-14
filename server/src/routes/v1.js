// Xenara public API (v1) — for use in your own apps with your personal API key.
//
//   Authorization: Bearer xen_live_xxx     (or  x-api-key: xen_live_xxx)
//
//   POST /api/v1/chat
//     { "message": "Hello", "engine": "auto", "web": "auto", "stream": false,
//       "history": [ {"role":"user","content":"..."}, ... ] }
//
// Returns JSON { reply, engine, sources?, learned } or, if stream:true, an
// SSE stream of { text } deltas. Every call also trains Xenara a little more.

import express from 'express';
import { requireAuth } from '../lib/auth.js';
import { streamReply, engineInfo } from '../engine/index.js';
import { gatherContext, searchProviderInfo } from '../engine/research.js';
import { learnFromText, isTrained, getLearnStats } from '../ml/trainer.js';
import db, { recordUsage } from '../lib/db.js';
import { clampString } from '../lib/security.js';

const router = express.Router();
router.use(requireAuth); // accepts the personal API key

function shouldResearch(text) {
  const t = text.toLowerCase();
  if (/\b(don'?t|do not) (search|look (it )?up|browse)\b/.test(t)) return false;
  return [
    /\b(search|look up|google|browse|find|research)\b/,
    /\b(latest|recent|current|today|news|price|weather|score|version)\b/,
    /\b(who|what|when|where|how much|how many)\b/,
    /https?:\/\//,
  ].some((re) => re.test(t));
}

function doLearn(message, reply, hadResearch) {
  if (!isTrained() || process.env.XENARA_LEARN === 'off') return null;
  const r = learnFromText(message);
  if (!hadResearch && reply && reply.length > 8) learnFromText(reply);
  if (r?.learned) {
    db.prepare('INSERT INTO learn_log (chars, loss, created_at) VALUES (?,?,?)')
      .run(r.chars, r.loss ?? null, Date.now());
  }
  return r;
}

router.get('/info', (req, res) => {
  res.json({
    name: 'Xenara API',
    version: 1,
    authenticatedAs: req.user.email,
    engine: engineInfo(req.query.engine),
    learning: getLearnStats(),
  });
});

router.post('/chat', async (req, res) => {
  let { message, engine = 'auto', web = 'auto', stream = false } = req.body || {};
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-20) : [];
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  // Clamp inputs to protect CPU/memory.
  message = clampString(String(message), 8000);

  // Compose conversation history for the engine.
  const convo = [
    ...history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => ({ role: m.role, content: String(m.content) })),
    { role: 'user', content: String(message) },
  ];

  // Optional web research.
  const webMode = String(web).toLowerCase();
  const webEnabled = searchProviderInfo().enabled;
  const wantsWeb = webEnabled && (webMode === 'on' || (webMode === 'auto' && shouldResearch(String(message))));
  let research = null;
  if (wantsWeb) {
    try {
      research = await gatherContext(String(message), { maxResults: 5, readTop: 3 });
      if (!research.sources?.length) research = null;
    } catch {
      research = null;
    }
  }

  // ---- Streaming response ----
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    if (research) send('sources', { sources: research.sources.map(({ content: _c, ...s }) => s) });

    let full = '';
    try {
      for await (const chunk of streamReply(convo, { research, engine })) {
        full += chunk;
        send('delta', { text: chunk });
      }
    } catch (err) {
      send('error', { message: err.message });
    }
    const learned = doLearn(String(message), full, !!research);
    recordUsage({ userId: req.user.id, endpoint: '/v1/chat:stream', viaKey: req.viaApiKey, inChars: message.length, outChars: full.length });
    send('done', { reply: full, learned });
    return res.end();
  }

  // ---- JSON response ----
  let full = '';
  try {
    for await (const chunk of streamReply(convo, { research, engine })) full += chunk;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const learned = doLearn(String(message), full, !!research);
  recordUsage({ userId: req.user.id, endpoint: '/v1/chat', viaKey: req.viaApiKey, inChars: message.length, outChars: full.length });

  res.json({
    reply: full,
    engine: engineInfo(engine).model,
    sources: research ? research.sources.map(({ content: _c, ...s }) => s) : undefined,
    learned: learned ? { chars: learned.chars, loss: learned.loss } : null,
  });
});

export default router;
