import { useState } from 'react';
import { api, setToken } from '../api.js';

export default function Auth({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = mode === 'login' ? { email, password } : { email, name, password };
      const data = await api.post(path, body);
      if (data.token) setToken(data.token);
      // On first registration the plaintext API key is returned exactly once.
      onAuthed(data.apiKey ? { ...data.user, apiKey: data.apiKey } : data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand">
          <div className="brand-logo">X</div>
          <h1>Xenara</h1>
          <p className="muted">Your AI assistant</p>
        </div>

        <div className="tabs">
          <button className={mode === 'login' ? 'tab active' : 'tab'} onClick={() => setMode('login')}>
            Sign in
          </button>
          <button className={mode === 'register' ? 'tab active' : 'tab'} onClick={() => setMode('register')}>
            Create account
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === 'register' && (
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </label>
          )}
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </label>

          {error && <div className="error">{error}</div>}

          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="muted small center">
          By continuing you agree to use Xenara responsibly.
        </p>
      </div>
    </div>
  );
}
