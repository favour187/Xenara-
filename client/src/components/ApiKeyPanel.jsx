import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function ApiKeyPanel({ user, onClose }) {
  // The full key is only available in-memory right after creation/rotation.
  const [apiKey, setApiKey] = useState(user?.apiKey || null);
  const [preview, setPreview] = useState(user?.apiKeyPreview || null);
  const [revealed, setRevealed] = useState(!!user?.apiKey);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [learn, setLearn] = useState(null);

  useEffect(() => {
    api.get('/api/auth/api-key').then((d) => setPreview(d.preview)).catch(() => {});
    api.get('/api/train/status').then((s) => setLearn(s.learn)).catch(() => {});
  }, []);

  async function rotate() {
    if (!confirm('Rotate your API key? The old key stops working immediately.')) return;
    setRotating(true);
    try {
      const d = await api.post('/api/auth/api-key/rotate');
      setApiKey(d.apiKey);
      setPreview(d.preview);
      setRevealed(true);
    } catch {
      /* ignore */
    } finally {
      setRotating(false);
    }
  }

  function copy() {
    if (!apiKey) return;
    navigator.clipboard?.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const masked = preview || (apiKey ? apiKey.slice(0, 12) + '…' + apiKey.slice(-4) : '— not available —');
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-xenara.onrender.com';

  const curlExample = `curl -X POST ${origin}/api/v1/chat \\
  -H "Authorization: Bearer ${revealed && apiKey ? apiKey : 'YOUR_API_KEY'}" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello Xenara", "web": "auto"}'`;

  const jsExample = `const res = await fetch("${origin}/api/v1/chat", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${revealed && apiKey ? apiKey : 'YOUR_API_KEY'}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ message: "Hello Xenara", web: "auto" }),
});
const data = await res.json();
console.log(data.reply);`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>🔑 Your Xenara API</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <p className="muted small">
          This Xenara instance is <b>yours alone</b>. Use this personal key to call Xenara from
          your own apps and scripts. Keep it secret.
          {user?.isOwner && <span className="owner-badge"> Owner</span>}
        </p>

        <div className="key-row">
          <code className="key-box">{revealed && apiKey ? apiKey : masked}</code>
          {apiKey && (
            <button className="mini-btn" onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
          )}
          <button className="mini-btn danger" onClick={rotate} disabled={rotating}>
            {rotating ? '…' : 'Rotate'}
          </button>
        </div>
        {!apiKey && (
          <p className="muted small">
            For your security, the full key is only shown once when created or rotated.
            If you've lost it, click <b>Rotate</b> to generate a new one.
          </p>
        )}
        {apiKey && (
          <p className="muted small">
            ⚠️ Copy this key now — for security it won't be shown again.
          </p>
        )}

        {learn && (
          <div className="learn-stats">
            <div className="muted small">📈 Continual learning (every question trains Xenara)</div>
            <div className="learn-grid">
              <div><span className="muted small">Interactions learned</span><b>{learn.interactions ?? 0}</b></div>
              <div><span className="muted small">Characters learned</span><b>{(learn.charsLearned ?? 0).toLocaleString()}</b></div>
              <div><span className="muted small">Last update loss</span><b>{learn.lastLoss != null ? learn.lastLoss.toFixed(3) : '—'}</b></div>
            </div>
          </div>
        )}

        <h3 className="ex-title">Use it in your work</h3>
        <div className="muted small">cURL</div>
        <pre className="code-block">{curlExample}</pre>
        <div className="muted small">JavaScript (fetch)</div>
        <pre className="code-block">{jsExample}</pre>

        <h3 className="ex-title">Download an SDK</h3>
        <div className="sdk-row">
          <a className="mini-btn" href="/api/sdk/python" download>⬇ Python SDK</a>
          <a className="mini-btn" href="/api/sdk/node" download>⬇ Node.js SDK</a>
        </div>
        <pre className="code-block">{`# Python\npip install requests\nfrom xenara import Xenara\nclient = Xenara(api_key="${revealed && apiKey ? apiKey : 'YOUR_API_KEY'}", base_url="${origin}")\nprint(client.chat("Hello Xenara"))`}</pre>

        <details className="api-details">
          <summary>Endpoint reference</summary>
          <ul className="muted small">
            <li><code>POST /api/v1/chat</code> — body: <code>{`{ message, engine?, web?, stream?, history? }`}</code></li>
            <li><code>GET /api/v1/info</code> — engine + learning status</li>
            <li>Auth: <code>Authorization: Bearer xen_live_...</code> or <code>x-api-key</code> header</li>
            <li><code>stream: true</code> returns Server-Sent Events (<code>delta</code> chunks)</li>
            <li><code>GET /api/analytics/usage</code> — your usage stats (owner)</li>
          </ul>
        </details>
      </div>
    </div>
  );
}
