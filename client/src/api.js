// Lightweight API client. Uses cookie auth + optional bearer token fallback.

const TOKEN_KEY = 'xenara_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function req(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b),
  put: (u, b) => req('PUT', u, b),
  del: (u) => req('DELETE', u),
};

// Stream a chat response via SSE-over-fetch.
export async function streamChat({
  conversationId,
  content,
  web = 'auto',
  engine = 'auto',
  onMeta,
  onStatus,
  onSources,
  onDelta,
  onDone,
  onError,
  onLearned,
  signal,
}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ conversationId, content, web, engine }),
    signal,
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    onError?.(new Error(err.error || `Stream failed (${res.status})`));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const block of events) {
      const lines = block.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (event === 'meta') onMeta?.(parsed);
      else if (event === 'status') onStatus?.(parsed);
      else if (event === 'sources') onSources?.(parsed.sources);
      else if (event === 'delta') onDelta?.(parsed.text);
      else if (event === 'learned') onLearned?.(parsed);
      else if (event === 'done') onDone?.(parsed);
      else if (event === 'error') onError?.(new Error(parsed.message));
    }
  }
}

// Generic SSE-over-fetch POST helper (used for training progress).
export async function streamPost(url, body, handlers = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify(body || {}),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    handlers.onError?.(new Error(err.error || `Request failed (${res.status})`));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const block of events) {
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      handlers[event]?.(parsed);
    }
  }
}
