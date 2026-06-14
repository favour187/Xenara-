// Engine router: selects which "brain" answers — the connected LLM endpoint,
// Xenara's own trained neural model, or the built-in Xenara Core engine.

import { XENARA_SYSTEM_PROMPT } from './persona.js';
import { localStream } from './localEngine.js';
import { isConfigured, openaiStream } from './openaiEngine.js';
import { nnAvailable, nnStream } from './nnEngine.js';
import { searchProviderInfo } from './research.js';

// List engines the client can pick from.
export function listEngines() {
  const engines = [
    { id: 'xenara-core', name: 'Xenara Core', desc: 'Built-in rule/retrieval engine. Always available.', ready: true },
    {
      id: 'xenara-nn',
      name: 'Xenara Neural (trained)',
      desc: 'A neural net trained from scratch inside Xenara.',
      ready: nnAvailable(),
    },
  ];
  if (isConfigured()) {
    engines.push({
      id: 'connected',
      name: `Connected: ${process.env.XENARA_MODEL_NAME || 'gpt-4o-mini'}`,
      desc: 'External OpenAI-compatible model.',
      ready: true,
    });
  }
  return engines;
}

function defaultEngine() {
  if (isConfigured()) return 'connected';
  if (nnAvailable()) return 'xenara-nn';
  return 'xenara-core';
}

export function engineInfo(selected) {
  const id = selected && selected !== 'auto' ? selected : defaultEngine();
  const map = {
    connected: { mode: 'connected', model: process.env.XENARA_MODEL_NAME || 'gpt-4o-mini' },
    'xenara-nn': { mode: 'neural', model: 'xenara-nn' },
    'xenara-core': { mode: 'core', model: 'xenara-core' },
  };
  const info = map[id] || map['xenara-core'];
  return {
    name: 'Xenara',
    engine: id,
    ...info,
    web: searchProviderInfo(),
    engines: listEngines(),
  };
}

function buildSystem(research) {
  if (!research || !research.context) return XENARA_SYSTEM_PROMPT;
  return `${XENARA_SYSTEM_PROMPT}

You have been given live web research results below. Use them to answer the
user's most recent question with up-to-date, accurate information. Cite sources
inline using bracketed numbers like [1], [2] that correspond to the numbered
sources. If the sources don't contain the answer, say so honestly.

=== WEB RESEARCH (gathered ${new Date().toUTCString()}) ===
${research.context}
=== END WEB RESEARCH ===`;
}

// opts: { research, engine }
export async function* streamReply(history, opts = {}) {
  const selected = opts.engine && opts.engine !== 'auto' ? opts.engine : defaultEngine();

  const messages = [
    { role: 'system', content: buildSystem(opts.research) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  // Xenara's own trained neural model.
  if (selected === 'xenara-nn') {
    if (!nnAvailable()) {
      yield `_[Xenara Neural is not trained yet. Go to the Train panel to train it, or use Xenara Core.]_\n\n`;
      yield* localStream(messages, opts.research);
      return;
    }
    yield `**Xenara Neural** (trained from scratch) responding:\n\n`;
    yield* nnStream(history);
    return;
  }

  // External connected model.
  if (selected === 'connected' && isConfigured()) {
    try {
      yield* openaiStream(messages);
      return;
    } catch (err) {
      yield `\n\n_[Xenara: the connected model failed (${err.message}). Falling back to Xenara Core.]_\n\n`;
      yield* localStream(messages, opts.research);
      return;
    }
  }

  // Default: Xenara Core.
  yield* localStream(messages, opts.research);
}
