// Xenara Core — a lightweight, fully self-contained response engine.
//
// This is a rule/retrieval-based engine so that Xenara works out of the box
// with ZERO external API keys or GPUs. It is intentionally simple but gives
// coherent, on-brand replies, can do small talk, basic math, time/date, code
// scaffolding hints, and helpful fallbacks. For frontier-level intelligence,
// configure an OpenAI-compatible endpoint (see openaiEngine.js) and Xenara
// will automatically use it instead.

import { XENARA_GREETING } from './persona.js';

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function tryMath(text) {
  // Only allow a very restricted arithmetic expression.
  const cleaned = text.replace(/[^0-9+\-*/().%\s]/g, '').trim();
  if (!cleaned || !/[0-9]/.test(cleaned) || !/[+\-*/%]/.test(cleaned)) return null;
  if (!/^[0-9+\-*/().%\s]+$/.test(cleaned)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${cleaned});`)();
    if (typeof result === 'number' && Number.isFinite(result)) {
      return `\`${cleaned.trim()}\` = **${result}**`;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// When live web research is available, Xenara Core composes a concise,
// sourced summary from the gathered sources (extractive, no external model).
function summarizeFromResearch(question, research) {
  const sources = research.sources || [];
  if (!sources.length) return null;

  // Score sentences from fetched content by overlap with the question terms.
  const qTerms = new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );

  const scored = [];
  for (const s of sources) {
    const sentences = (s.content || '')
      .split(/(?<=[.!?])\s+/)
      .map((x) => x.trim())
      .filter((x) => x.length > 40 && x.length < 320);
    for (const sent of sentences.slice(0, 12)) {
      const words = sent.toLowerCase().split(/\s+/);
      let score = 0;
      for (const w of words) if (qTerms.has(w.replace(/[^a-z0-9]/g, ''))) score++;
      if (score > 0) scored.push({ sent, score, n: s.n });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = [];
  const seen = new Set();
  for (const item of scored) {
    const key = item.sent.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    top.push(item);
    if (top.length >= 5) break;
  }

  let body;
  if (top.length) {
    body = top.map((t) => `- ${t.sent} [${t.n}]`).join('\n');
  } else {
    body = sources
      .filter((s) => s.snippet)
      .slice(0, 4)
      .map((s) => `- ${s.snippet} [${s.n}]`)
      .join('\n');
  }

  const refs = sources.map((s) => `${s.n}. [${s.title}](${s.url})`).join('\n');

  return `Here's what I gathered from the web about **${question}**:

${body || '_No clear extract found, but see the sources below._'}

**Sources**
${refs}

_Summarized by Xenara Core from live web results. Connect a language model (\`XENARA_MODEL_URL\`) for richer, synthesized answers._`;
}

function generate(messages, research) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = (lastUser?.content || '').trim();
  const lower = text.toLowerCase();

  if (!text) return XENARA_GREETING;

  // If web research was gathered, build a sourced summary.
  if (research && (research.sources || []).length) {
    const summary = summarizeFromResearch(text, research);
    if (summary) return summary;
  }

  // Greetings
  if (/^(hi|hello|hey|yo|good (morning|afternoon|evening)|howdy)\b/.test(lower)) {
    return pick([
      `Hello! I'm **Xenara**. How can I help you today?`,
      `Hi there! What would you like to work on?`,
      `Hey! I'm Xenara — ask me anything.`,
    ]);
  }

  // Identity
  if (/(who are you|what are you|your name|are you (claude|chatgpt|gpt))/.test(lower)) {
    return `I'm **Xenara**, an AI assistant. I'm running on the built-in **Xenara Core** engine right now. For more advanced reasoning, my operator can connect me to a larger language model through an OpenAI-compatible endpoint — and I'll seamlessly use it.`;
  }

  // Time / date
  if (/(what.*time|current time|what.*date|today'?s date|what day)/.test(lower)) {
    const now = new Date();
    return `Right now (server time) it is **${now.toUTCString()}**.`;
  }

  // Thanks
  if (/(thank|thanks|thx|appreciate)/.test(lower)) {
    return pick([`You're welcome! 😊`, `Anytime — happy to help!`, `Glad I could help!`]);
  }

  // Math
  const math = tryMath(text);
  if (math) return math;

  // Capabilities
  if (/(what can you do|help me|capabilities|features)/.test(lower)) {
    return `I can help with a lot:

- **Answering questions** and explaining concepts
- **Writing & editing** text, emails, and documents
- **Coding** help and scaffolding ideas
- **Brainstorming** and planning
- Quick **math** and reasoning

> Tip: For deep, frontier-level answers, connect me to a real LLM endpoint via the \`XENARA_MODEL_URL\` setting. I'll automatically upgrade my brain. 🚀

What would you like to start with?`;
  }

  // Generic, on-brand fallback that reflects the user's message.
  const preview = text.length > 220 ? text.slice(0, 220) + '…' : text;
  return `You said:

> ${preview}

I'm currently running on **Xenara Core**, my built-in lightweight engine, so my answers here are limited. To unlock full conversational intelligence, connect a language model by setting the \`XENARA_MODEL_URL\` (and optional \`XENARA_MODEL_KEY\`) environment variable to any OpenAI-compatible endpoint — for example a self-hosted model via [Ollama](https://ollama.com) or a hosted provider.

In the meantime, I can still handle greetings, quick math, date/time, and general guidance. How else can I help?`;
}

// Stream the generated answer word-by-word to mimic real token streaming.
export async function* localStream(messages, research) {
  const full = generate(messages, research);
  const tokens = full.split(/(\s+)/); // keep whitespace
  for (const tok of tokens) {
    await new Promise((r) => setTimeout(r, 8));
    yield tok;
  }
}

export function localComplete(messages, research) {
  return generate(messages, research);
}
