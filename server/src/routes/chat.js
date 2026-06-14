import express from 'express';
import { nanoid } from 'nanoid';
import db from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { streamReply, engineInfo } from '../engine/index.js';
import { gatherContext, webSearch, fetchReadable, searchProviderInfo } from '../engine/research.js';
import { learnFromText, getLearnStats, isTrained } from '../ml/trainer.js';

const router = express.Router();
router.use(requireAuth);

router.get('/engine', (req, res) => {
  res.json(engineInfo(req.query.engine));
});

// Direct web search endpoint (handy for tools/UI).
router.post('/search', async (req, res) => {
  const { query, limit } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'query required' });
  try {
    const results = await webSearch(query.trim(), Math.min(Number(limit) || 5, 10));
    res.json({ provider: searchProviderInfo().provider, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Fetch & extract a single page.
router.post('/fetch', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'valid url required' });
  try {
    const page = await fetchReadable(url, 6000);
    res.json(page);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

function autoTitle(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  return (t.length > 48 ? t.slice(0, 48) + '…' : t) || 'New chat';
}

// Heuristic: should Xenara gather live web data for this message?
function shouldResearch(text) {
  const t = text.toLowerCase();
  if (/\b(don'?t|do not) (search|look (it )?up|browse)\b/.test(t)) return false;
  const triggers = [
    /\b(search|look up|google|browse|find( me)?|research)\b/,
    /\b(latest|recent|current|today|tonight|this (week|month|year)|right now|breaking)\b/,
    /\b(news|price|stock|weather|score|release|version|update)\b/,
    /\b(who is|what is|when (is|did|was)|where is|how much|how many)\b/,
    /\b20(2[4-9]|3\d)\b/, // explicit recent years
    /https?:\/\//, // a URL was pasted
  ];
  return triggers.some((re) => re.test(t));
}

// Stream a chat completion over Server-Sent Events.
// Body: { conversationId?, content, web? }  web: 'on' | 'off' | 'auto'
router.post('/stream', async (req, res) => {
  const { content } = req.body || {};
  let { conversationId } = req.body || {};
  const webMode = (req.body?.web || 'auto').toLowerCase();
  const selectedEngine = req.body?.engine || 'auto';
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message content required.' });

  const now = Date.now();

  // Create conversation if needed.
  if (!conversationId) {
    conversationId = nanoid();
    db.prepare(
      'INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)'
    ).run(conversationId, req.user.id, autoTitle(content), now, now);
  } else {
    const owns = db
      .prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
      .get(conversationId, req.user.id);
    if (!owns) return res.status(404).json({ error: 'Conversation not found' });
  }

  // Persist user message.
  const userMsgId = nanoid();
  db.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)')
    .run(userMsgId, conversationId, 'user', content, now);

  // Build history for the engine.
  const history = db
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId);

  // SSE headers.
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

  send('meta', { conversationId, engine: engineInfo(selectedEngine) });

  // --- Web research phase ---
  const webEnabled = searchProviderInfo().enabled;
  const wantsWeb =
    webEnabled && (webMode === 'on' || (webMode === 'auto' && shouldResearch(content)));

  let research = null;
  if (wantsWeb) {
    send('status', { stage: 'searching', message: 'Searching the web…' });
    try {
      research = await gatherContext(content, { maxResults: 5, readTop: 3 });
      if (research.sources.length) {
        send('sources', { sources: research.sources.map(({ content: _c, ...s }) => s) });
        send('status', { stage: 'reading', message: `Read ${research.sources.length} sources.` });
      } else {
        send('status', { stage: 'no_results', message: 'No web results found.' });
        research = null;
      }
    } catch (err) {
      send('status', { stage: 'error', message: `Web research failed: ${err.message}` });
      research = null;
    }
  }

  let full = '';
  try {
    for await (const chunk of streamReply(history, { research, engine: selectedEngine })) {
      full += chunk;
      send('delta', { text: chunk });
    }
  } catch (err) {
    send('error', { message: err.message });
  }

  // Append a machine-readable sources block so it persists with the message.
  if (research && research.sources.length) {
    const refs = research.sources
      .map((s) => `${s.n}. [${s.title}](${s.url})`)
      .join('\n');
    if (!/\bSources\b/i.test(full)) {
      full += `\n\n**Sources**\n${refs}`;
    }
  }

  // Persist assistant message.
  const assistantId = nanoid();
  const doneAt = Date.now();
  db.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)')
    .run(assistantId, conversationId, 'assistant', full, doneAt);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(doneAt, conversationId);

  // --- Continual learning: every question trains Xenara a little more. ---
  // Learn from the question, and (when the answer is clean text) the answer too.
  let learnResult = null;
  if (isTrained() && process.env.XENARA_LEARN !== 'off') {
    learnResult = learnFromText(content);
    // Learn from a non-web, non-system answer to reinforce style.
    if (!research && full && full.length > 8 && !full.startsWith('_[')) {
      learnFromText(full.replace(/\*\*Xenara Neural\*\*[^\n]*\n+/g, ''));
    }
    if (learnResult?.learned) {
      db.prepare('INSERT INTO learn_log (chars, loss, created_at) VALUES (?,?,?)')
        .run(learnResult.chars, learnResult.loss ?? null, Date.now());
      send('learned', {
        chars: learnResult.chars,
        loss: learnResult.loss,
        stats: getLearnStats(),
      });
    }
  }

  send('done', { messageId: assistantId, conversationId, content: full, learned: learnResult });
  res.end();
});

export default router;
