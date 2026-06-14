// Xenara trainer — orchestrates training the neural LM on the corpus,
// reports live progress, persists the trained model, and generates text.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NeuralLM } from './nn.js';
import { MiniTransformer } from './attention.js';
import { CharTokenizer } from './tokenizer.js';
import { DEFAULT_CORPUS } from './corpus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const MODEL_PATH = path.join(DATA_DIR, 'xenara-model.json');
const CORPUS_DIR = path.join(DATA_DIR, 'corpus');
// Text learned live from questions is appended here and re-used on full retrains.
const LEARNED_CORPUS = path.join(DATA_DIR, 'learned.txt');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Singleton training state.
const state = {
  status: 'idle', // idle | training | trained | error
  model: null,
  arch: null, // 'mlp' | 'transformer'
  tokenizer: null,
  progress: null, // { epoch, epochs, step, steps, loss }
  history: [], // [{ epoch, loss }]
  meta: null, // { vocabSize, params, corpusChars, trainedAt }
  error: null,
  // Continual-learning stats.
  learn: { interactions: 0, charsLearned: 0, lastLoss: null, lastAt: null },
};

let savePending = false;

// ----------------------------- corpus loading -----------------------------

export function loadCorpus() {
  let text = DEFAULT_CORPUS;
  try {
    if (fs.existsSync(CORPUS_DIR)) {
      const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.txt'));
      for (const f of files) {
        text += '\n' + fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8');
      }
    }
    // Include text learned live from questions/answers.
    if (fs.existsSync(LEARNED_CORPUS)) {
      text += '\n' + fs.readFileSync(LEARNED_CORPUS, 'utf8');
    }
  } catch {
    /* use default only */
  }
  return text;
}

function countParams(m) {
  if (m instanceof MiniTransformer) {
    return (
      m.tok.length + m.pos.length + m.Wq.length + m.Wk.length + m.Wv.length +
      m.Wo.length + m.W1.length + m.b1.length + m.W2.length + m.b2.length +
      m.Wout.length + m.bout.length
    );
  }
  return m.C.length + m.W1.length + m.b1.length + m.W2.length + m.b2.length;
}

// Snapshot/restore model params (for early-stopping "keep best weights").
function snapshot(m) {
  return JSON.stringify(m.toJSON());
}
function restore(arch, json) {
  return arch === 'transformer' ? MiniTransformer.fromJSON(JSON.parse(json)) : NeuralLM.fromJSON(JSON.parse(json));
}

// ----------------------------- training -----------------------------

// Train asynchronously, yielding to the event loop so the server stays
// responsive and progress can be streamed.
// Sensible per-architecture defaults.
const ARCH_DEFAULTS = {
  mlp: { lr: 0.03, block: 10, embDim: 32, hidden: 160 },
  transformer: { lr: 0.0015, block: 16, dModel: 48, dff: 96 },
};

export async function train({
  arch = 'mlp', // 'mlp' (default, robust) | 'transformer' (experimental, attention)
  epochs = 30,
  lr,
  block,
  embDim,
  hidden,
  dModel,
  dff,
  onProgress,
  extraCorpus = '',
} = {}) {
  if (state.status === 'training') throw new Error('Training already in progress');

  const d = ARCH_DEFAULTS[arch] || ARCH_DEFAULTS.mlp;
  lr = lr ?? d.lr;
  block = block ?? d.block;

  state.status = 'training';
  state.error = null;
  state.history = [];

  try {
    const text = loadCorpus() + (extraCorpus ? '\n' + extraCorpus : '');
    const tokenizer = CharTokenizer.fromText(text);
    const data = tokenizer.encode(text);

    if (data.length <= block + 1) throw new Error('Corpus too small to train.');

    let model;
    if (arch === 'transformer') {
      model = new MiniTransformer({
        vocabSize: tokenizer.vocabSize,
        block,
        dModel: dModel ?? d.dModel,
        dff: dff ?? d.dff,
      });
    } else {
      model = new NeuralLM({
        vocabSize: tokenizer.vocabSize,
        block,
        embDim: embDim ?? d.embDim,
        hidden: hidden ?? d.hidden,
      });
    }

    const N = data.length - block;
    const order = new Int32Array(N);
    for (let i = 0; i < N; i++) order[i] = i;
    const REPORT_EVERY = Math.max(1, Math.floor(N / 20));

    // Early-stopping: keep the best (lowest-loss) weights and stop if the model
    // diverges (NaN) or stops improving. This guarantees a usable model even
    // for the finicky transformer.
    let bestLoss = Infinity;
    let bestSnapshot = null;
    let worseStreak = 0;

    for (let epoch = 1; epoch <= epochs; epoch++) {
      for (let i = N - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
      }

      const curLr = lr * (1 - (epoch - 1) / (epochs * 1.5));
      let lossSum = 0;
      const ctx = new Int32Array(block);
      let diverged = false;

      for (let s = 0; s < N; s++) {
        const start = order[s];
        for (let p = 0; p < block; p++) ctx[p] = data[start + p];
        const target = data[start + block];
        const l = model.trainStep(ctx, target, curLr);
        if (!Number.isFinite(l)) {
          diverged = true;
          break;
        }
        lossSum += l;

        if (s % REPORT_EVERY === 0) {
          const avg = lossSum / (s + 1);
          state.progress = { epoch, epochs, step: s, steps: N, loss: avg };
          onProgress?.({ ...state.progress });
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setImmediate(r));
        }
      }

      if (diverged) {
        onProgress?.({ epoch, epochs, step: N, steps: N, loss: bestLoss, note: 'diverged — stopping early, keeping best weights' });
        break;
      }

      const epochLoss = lossSum / N;
      state.history.push({ epoch, loss: epochLoss });
      state.progress = { epoch, epochs, step: N, steps: N, loss: epochLoss };
      onProgress?.({ ...state.progress, epochDone: true });

      // Track best weights.
      if (epochLoss < bestLoss - 1e-4) {
        bestLoss = epochLoss;
        bestSnapshot = snapshot(model);
        worseStreak = 0;
      } else {
        worseStreak += 1;
        // Stop if not improving for several epochs (transformer safety).
        if (arch === 'transformer' && worseStreak >= 3) {
          onProgress?.({ epoch, epochs, step: N, steps: N, loss: bestLoss, note: 'early stop (no improvement)' });
          break;
        }
      }
    }

    // Restore best weights if we captured them.
    if (bestSnapshot) model = restore(arch, bestSnapshot);

    state.model = model;
    state.tokenizer = tokenizer;
    state.arch = arch;
    state.meta = {
      arch,
      vocabSize: tokenizer.vocabSize,
      params: countParams(model),
      corpusChars: text.length,
      block,
      epochs,
      finalLoss: Number.isFinite(bestLoss) ? bestLoss : (state.history[state.history.length - 1]?.loss ?? null),
      trainedAt: Date.now(),
    };
    state.status = 'trained';
    save();
    return state.meta;
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    throw err;
  }
}

// ----------------------------- continual learning -----------------------------

// Debounced model save so frequent online updates don't thrash the disk.
function scheduleSave() {
  if (savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    try {
      save();
    } catch {
      /* ignore */
    }
  }, 4000);
}

// Append learned text to the persistent learned corpus.
function appendLearned(text) {
  try {
    fs.appendFileSync(LEARNED_CORPUS, text + '\n');
  } catch {
    /* ignore */
  }
}

// Learn online from a piece of text (e.g. a question, or a Q+A pair).
// Runs real gradient-descent passes over the text's sliding windows using only
// characters already in the vocabulary, then persists. This makes Xenara learn
// a little more from every question, exactly as requested.
//
// Returns { learned: boolean, loss, chars, skipped } — never throws.
export function learnFromText(text, { passes = 3, lr = 0.02 } = {}) {
  try {
    if (!state.model || !state.tokenizer) return { learned: false, skipped: 'not_trained' };
    const clean = String(text || '').trim();
    if (clean.length < 4) return { learned: false, skipped: 'too_short' };

    const { model, tokenizer } = state;
    const block = model.block;

    // Encode using existing vocab (unknown chars are dropped by encode()).
    const data = tokenizer.encode(clean);
    if (data.length <= block + 1) return { learned: false, skipped: 'too_short_for_block' };

    const N = data.length - block;
    const ctx = new Int32Array(block);
    let lossSum = 0;
    let steps = 0;

    for (let pass = 0; pass < passes; pass++) {
      for (let s = 0; s < N; s++) {
        for (let p = 0; p < block; p++) ctx[p] = data[s + p];
        const target = data[s + block];
        lossSum += model.trainStep(ctx, target, lr);
        steps++;
      }
    }

    const avgLoss = steps ? lossSum / steps : null;

    // Persist the learned text and update stats.
    appendLearned(clean);
    state.learn.interactions += 1;
    state.learn.charsLearned += clean.length;
    state.learn.lastLoss = avgLoss;
    state.learn.lastAt = Date.now();
    if (state.meta) {
      state.meta.corpusChars = (state.meta.corpusChars || 0) + clean.length;
      state.meta.learnedInteractions = state.learn.interactions;
    }
    scheduleSave();

    return { learned: true, loss: avgLoss, chars: clean.length };
  } catch (err) {
    return { learned: false, skipped: err.message };
  }
}

export function getLearnStats() {
  return { ...state.learn };
}

// ----------------------------- generation -----------------------------

export function generate(prompt = '', { maxTokens = 240, temperature = 0.8 } = {}) {
  if (!state.model || !state.tokenizer) throw new Error('Model not trained yet.');
  const { model, tokenizer } = state;
  const block = model.block;

  // Seed context from the prompt (or spaces if empty).
  let ids = tokenizer.encode(prompt);
  const ctx = [];
  for (let i = 0; i < block; i++) {
    const idx = ids.length - block + i;
    ctx.push(idx >= 0 ? ids[idx] : (tokenizer.stoi.get(' ') ?? 0));
  }

  let out = '';
  for (let t = 0; t < maxTokens; t++) {
    const next = model.sample(ctx, temperature);
    const ch = tokenizer.itos.get(next) ?? '';
    out += ch;
    ctx.shift();
    ctx.push(next);
  }
  return out;
}

// Streaming generator (yields one char at a time).
export async function* generateStream(prompt = '', opts = {}) {
  if (!state.model || !state.tokenizer) throw new Error('Model not trained yet.');
  const { model, tokenizer } = state;
  const block = model.block;
  const { maxTokens = 240, temperature = 0.8 } = opts;

  let ids = tokenizer.encode(prompt);
  const ctx = [];
  for (let i = 0; i < block; i++) {
    const idx = ids.length - block + i;
    ctx.push(idx >= 0 ? ids[idx] : (tokenizer.stoi.get(' ') ?? 0));
  }

  for (let t = 0; t < maxTokens; t++) {
    const next = model.sample(ctx, temperature);
    const ch = tokenizer.itos.get(next) ?? '';
    yield ch;
    ctx.shift();
    ctx.push(next);
    if (t % 16 === 0) await new Promise((r) => setImmediate(r));
  }
}

// ----------------------------- persistence -----------------------------

export function save() {
  if (!state.model || !state.tokenizer) return false;
  const payload = {
    arch: state.arch || 'mlp',
    model: state.model.toJSON(),
    tokenizer: state.tokenizer.toJSON(),
    meta: state.meta,
    history: state.history,
    learn: state.learn,
  };
  fs.writeFileSync(MODEL_PATH, JSON.stringify(payload));
  return true;
}

export function load() {
  try {
    if (!fs.existsSync(MODEL_PATH)) return false;
    const payload = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    const arch = payload.arch || (payload.model?.type === 'transformer' ? 'transformer' : 'mlp');
    state.arch = arch;
    state.model = arch === 'transformer' ? MiniTransformer.fromJSON(payload.model) : NeuralLM.fromJSON(payload.model);
    state.tokenizer = CharTokenizer.fromJSON(payload.tokenizer);
    state.meta = payload.meta;
    state.history = payload.history || [];
    if (payload.learn) state.learn = payload.learn;
    state.status = 'trained';
    return true;
  } catch {
    return false;
  }
}

export function getStatus() {
  return {
    status: state.status,
    arch: state.arch,
    progress: state.progress,
    history: state.history,
    meta: state.meta,
    error: state.error,
    learn: state.learn,
    isReady: state.status === 'trained',
  };
}

export function isTrained() {
  return state.status === 'trained' && !!state.model;
}
