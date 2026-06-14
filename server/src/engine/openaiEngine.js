// Adapter for any OpenAI-compatible chat completions endpoint.
// Works with: OpenAI, OpenRouter, Together, Groq, local Ollama
// (http://localhost:11434/v1), LM Studio, vLLM, etc.
//
// Configure via environment variables:
//   XENARA_MODEL_URL  e.g. https://api.openai.com/v1  (base url, /chat/completions appended)
//   XENARA_MODEL_KEY  API key (optional for local servers)
//   XENARA_MODEL_NAME e.g. gpt-4o-mini, llama3.1, etc.

export function isConfigured() {
  return Boolean(process.env.XENARA_MODEL_URL);
}

function endpoint() {
  const base = process.env.XENARA_MODEL_URL.replace(/\/$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.XENARA_MODEL_KEY) {
    h.Authorization = `Bearer ${process.env.XENARA_MODEL_KEY}`;
  }
  return h;
}

const MODEL = () => process.env.XENARA_MODEL_NAME || 'gpt-4o-mini';

export async function* openaiStream(messages) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: MODEL(),
      messages,
      stream: true,
      temperature: 0.7,
    }),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Model endpoint error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        /* ignore partial json */
      }
    }
  }
}
