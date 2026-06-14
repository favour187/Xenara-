/**
 * Xenara Node.js SDK — call your private Xenara from your own work.
 *
 * Usage:
 *   import { Xenara } from "./xenara.js";
 *   const client = new Xenara({ apiKey: "xen_live_xxx", baseUrl: "https://YOUR-APP.onrender.com" });
 *
 *   // Simple chat
 *   console.log(await client.chat("Summarize quantum computing"));
 *
 *   // Full response (reply, sources, learned)
 *   const data = await client.chatFull("Latest AI news?", { web: "on" });
 *
 *   // Streaming
 *   for await (const chunk of client.stream("Write a haiku")) process.stdout.write(chunk);
 *
 * Works on Node 18+ (built-in fetch). No dependencies.
 */

export class Xenara {
  constructor({ apiKey, baseUrl = 'http://localhost:3000' } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  _headers() {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  async info() {
    const r = await fetch(`${this.baseUrl}/api/v1/info`, { headers: this._headers() });
    if (!r.ok) throw new Error(`Xenara info failed: ${r.status}`);
    return r.json();
  }

  async chatFull(message, opts = {}) {
    const body = { message, engine: 'auto', web: 'auto', history: [], ...opts };
    const r = await fetch(`${this.baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `Xenara chat failed: ${r.status}`);
    }
    return r.json();
  }

  async chat(message, opts = {}) {
    const data = await this.chatFull(message, opts);
    return data.reply;
  }

  async *stream(message, opts = {}) {
    const body = { message, engine: 'auto', web: 'auto', history: [], ...opts, stream: true };
    const r = await fetch(`${this.baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!r.ok || !r.body) throw new Error(`Xenara stream failed: ${r.status}`);

    const reader = r.body.getReader();
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
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (event === 'delta' && parsed.text) yield parsed.text;
        else if (event === 'done') return;
      }
    }
  }
}

export default Xenara;
