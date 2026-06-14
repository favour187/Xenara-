// Training & neural-model routes.
// Lets the user actually train Xenara's from-scratch neural net and watch
// the loss go down live over Server-Sent Events.

import express from 'express';
import { requireAuth, requireOwner } from '../lib/auth.js';
import { train, getStatus, generate, loadCorpus, isTrained } from '../ml/trainer.js';

const router = express.Router();
router.use(requireAuth);
// Training & generation are owner-only and expensive.
router.use(requireOwner);

// Current training/model status.
router.get('/status', (req, res) => {
  res.json(getStatus());
});

// Info about the corpus the model trains on.
router.get('/corpus', (req, res) => {
  const text = loadCorpus();
  res.json({ chars: text.length, lines: text.split('\n').length, preview: text.slice(0, 600) });
});

// Generate raw text from the trained neural model.
router.post('/generate', (req, res) => {
  if (!isTrained()) return res.status(400).json({ error: 'Model not trained yet. Train it first.' });
  const { prompt = '', maxTokens = 200, temperature = 0.7 } = req.body || {};
  try {
    const text = generate(prompt, {
      maxTokens: Math.min(Number(maxTokens) || 200, 800),
      temperature: Math.max(0, Math.min(Number(temperature) || 0.7, 1.5)),
    });
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Train the model, streaming live progress as SSE.
// Body: { epochs?, lr?, block?, embDim?, hidden?, extraCorpus? }
router.post('/start', async (req, res) => {
  const opts = req.body || {};

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

  send('start', { message: 'Initializing Xenara neural model…' });

  try {
    const arch = opts.arch === 'transformer' ? 'transformer' : 'mlp';
    const meta = await train({
      arch,
      epochs: Math.min(Number(opts.epochs) || 30, 100),
      lr: opts.lr ? Number(opts.lr) : undefined,
      block: opts.block ? Math.min(Number(opts.block), 24) : undefined,
      embDim: opts.embDim ? Math.min(Number(opts.embDim), 64) : undefined,
      hidden: opts.hidden ? Math.min(Number(opts.hidden), 256) : undefined,
      dModel: opts.dModel ? Math.min(Number(opts.dModel), 64) : undefined,
      dff: opts.dff ? Math.min(Number(opts.dff), 128) : undefined,
      extraCorpus: typeof opts.extraCorpus === 'string' ? opts.extraCorpus.slice(0, 200000) : '',
      onProgress: (p) => send('progress', p),
    });
    // Show a sample of what the freshly trained model produces.
    let sample = '';
    try {
      sample = generate('I am Xenara', { maxTokens: 160, temperature: 0.5 });
    } catch {
      /* ignore */
    }
    send('done', { meta, sample });
  } catch (err) {
    send('error', { message: err.message });
  }
  res.end();
});

export default router;
