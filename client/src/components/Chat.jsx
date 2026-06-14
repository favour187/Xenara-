import { useEffect, useRef, useState } from 'react';
import Markdown from './Markdown.jsx';
import { streamChat } from '../api.js';

const SUGGESTIONS = [
  'What are the latest AI news this week?',
  "Summarize today's top tech headlines",
  'Find the current population of Tokyo',
  'Research the benefits of intermittent fasting',
];

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function Sources({ sources }) {
  if (!sources || !sources.length) return null;
  return (
    <div className="sources">
      <div className="sources-title">🔎 Sources</div>
      <div className="source-chips">
        {sources.map((s) => (
          <a key={s.n} className="source-chip" href={s.url} target="_blank" rel="noreferrer">
            <span className="source-n">{s.n}</span>
            <span className="source-text">
              <span className="source-name">{s.title || s.url}</span>
              <span className="source-host">{hostOf(s.url)}</span>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

export default function Chat({
  messages,
  setMessages,
  conversationId,
  onConversationCreated,
  onMenu,
  webAvailable,
  engines = [],
  engine,
  setEngine,
  onOpenTrain,
}) {
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [webMode, setWebMode] = useState('auto'); // auto | on | off
  const [status, setStatus] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [copiedId, setCopiedId] = useState(null);
  const scrollRef = useRef(null);
  const taRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming, status]);

  function autoGrow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }

  // Core streaming runner. `baseMessages` already includes the user turn and
  // an empty assistant placeholder as the last element.
  async function runStream(content, baseMessages) {
    setStreaming(true);
    setStatus(null);
    const controller = new AbortController();
    abortRef.current = controller;

    let cid = conversationId;
    try {
      await streamChat({
        conversationId,
        content,
        web: webMode,
        engine: engine || 'auto',
        signal: controller.signal,
        onMeta: (meta) => {
          if (meta.conversationId && !cid) {
            cid = meta.conversationId;
            onConversationCreated?.(meta.conversationId);
          }
        },
        onStatus: (s) => setStatus(s),
        onLearned: (info) => {
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = { ...copy[copy.length - 1], learned: info };
            return copy;
          });
        },
        onSources: (sources) => {
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = { ...copy[copy.length - 1], sources };
            return copy;
          });
        },
        onDelta: (delta) => {
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              ...copy[copy.length - 1],
              content: copy[copy.length - 1].content + delta,
            };
            return copy;
          });
        },
        onDone: () => {
          setStreaming(false);
          setStatus(null);
          abortRef.current = null;
        },
        onError: (err) => {
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              ...copy[copy.length - 1],
              content: copy[copy.length - 1].content + `\n\n_⚠️ ${err.message}_`,
            };
            return copy;
          });
          setStreaming(false);
          setStatus(null);
          abortRef.current = null;
        },
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = {
            ...last,
            content: (last.content || '') + '\n\n_⏹ Stopped._',
          };
          return copy;
        });
      }
      setStreaming(false);
      setStatus(null);
      abortRef.current = null;
    }
  }

  async function send(text) {
    const content = (text ?? input).trim();
    if (!content || streaming) return;
    setInput('');
    setTimeout(autoGrow, 0);
    const userMsg = { id: 'u-' + Date.now(), role: 'user', content };
    const aiMsg = { id: 'a-' + Date.now(), role: 'assistant', content: '', sources: null };
    setMessages((prev) => [...prev, userMsg, aiMsg]);
    await runStream(content, null);
  }

  function stop() {
    abortRef.current?.abort();
  }

  // Regenerate: drop the last assistant message and re-ask the previous user one.
  async function regenerate() {
    if (streaming) return;
    let lastUser = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUser = messages[i];
        break;
      }
    }
    if (!lastUser) return;
    setMessages((prev) => {
      const copy = [...prev];
      // remove trailing assistant message(s)
      while (copy.length && copy[copy.length - 1].role === 'assistant') copy.pop();
      copy.push({ id: 'a-' + Date.now(), role: 'assistant', content: '', sources: null });
      return copy;
    });
    await runStream(lastUser.content, null);
  }

  function startEdit(m) {
    setEditingId(m.id);
    setEditText(m.content);
  }

  // Save an edited user message and re-run the conversation from that point.
  async function saveEdit(m) {
    const newText = editText.trim();
    setEditingId(null);
    if (!newText || newText === m.content) return;
    setMessages((prev) => {
      const idx = prev.findIndex((x) => x.id === m.id);
      if (idx === -1) return prev;
      const copy = prev.slice(0, idx);
      copy.push({ ...m, content: newText });
      copy.push({ id: 'a-' + Date.now(), role: 'assistant', content: '', sources: null });
      return copy;
    });
    await runStream(newText, null);
  }

  async function copyMsg(m) {
    try {
      await navigator.clipboard?.writeText(m.content);
      setCopiedId(m.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* ignore */
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function cycleWeb() {
    setWebMode((m) => (m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto'));
  }

  const webLabel = { auto: '🌐 Web: Auto', on: '🌐 Web: On', off: '🌐 Web: Off' }[webMode];
  const empty = messages.length === 0;
  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return i;
    return -1;
  })();

  return (
    <main className="chat">
      <header className="chat-header">
        <button className="menu-btn" onClick={onMenu} aria-label="Menu">
          ☰
        </button>
        <div className="model-picker">
          <select
            value={engine || 'auto'}
            onChange={(e) => setEngine?.(e.target.value)}
            title="Choose which Xenara engine answers"
          >
            <option value="auto">Xenara (auto)</option>
            {engines.map((en) => (
              <option key={en.id} value={en.id} disabled={!en.ready}>
                {en.name}
                {en.ready ? '' : ' — not trained'}
              </option>
            ))}
          </select>
        </div>
        <button className="train-btn" onClick={onOpenTrain} title="Train Xenara's neural model">
          🧠 Train
        </button>
      </header>

      <div className="messages" ref={scrollRef}>
        {empty ? (
          <div className="welcome">
            <div className="brand-logo lg">X</div>
            <h2>How can I help you today?</h2>
            <p className="muted">
              I'm Xenara — I can search and gather live data from the open web. 🌐
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="messages-inner">
            {messages.map((m, i) => (
              <div key={m.id || i} className={`msg ${m.role}`}>
                <div className="msg-avatar">{m.role === 'user' ? 'You' : 'X'}</div>
                <div className="msg-body">
                  {m.role === 'assistant' ? (
                    <>
                      {m.sources && <Sources sources={m.sources} />}
                      {m.content ? (
                        <Markdown text={m.content} />
                      ) : status && i === messages.length - 1 ? (
                        <div className="research-status">
                          <span className="spinner" /> {status.message}
                        </div>
                      ) : (
                        <span className="typing">
                          <i></i>
                          <i></i>
                          <i></i>
                        </span>
                      )}
                      {m.learned?.chars > 0 && (
                        <div className="learned-chip" title="Xenara trained on this exchange">
                          🧠 Learned from this exchange
                          {m.learned.loss != null ? ` · loss ${m.learned.loss.toFixed(3)}` : ''}
                        </div>
                      )}
                      {m.content && !streaming && (
                        <div className="msg-actions">
                          <button onClick={() => copyMsg(m)} title="Copy">
                            {copiedId === m.id ? '✓ Copied' : '⧉ Copy'}
                          </button>
                          {i === lastAssistantIdx && (
                            <button onClick={regenerate} title="Regenerate">↻ Regenerate</button>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {editingId === m.id ? (
                        <div className="edit-box">
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            rows={3}
                            autoFocus
                          />
                          <div className="edit-actions">
                            <button className="mini-btn" onClick={() => saveEdit(m)}>Save &amp; resend</button>
                            <button className="mini-btn" onClick={() => setEditingId(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="user-text">{m.content}</div>
                          {!streaming && (
                            <div className="msg-actions">
                              <button onClick={() => copyMsg(m)} title="Copy">
                                {copiedId === m.id ? '✓ Copied' : '⧉ Copy'}
                              </button>
                              <button onClick={() => startEdit(m)} title="Edit">✎ Edit</button>
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-inner">
          <textarea
            ref={taRef}
            value={input}
            placeholder="Message Xenara…  (Enter to send, Shift+Enter for newline)"
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
            rows={1}
          />
          {streaming ? (
            <button className="send stop" onClick={stop} title="Stop generating">■</button>
          ) : (
            <button className="send" onClick={() => send()} disabled={!input.trim()}>↑</button>
          )}
        </div>
        <div className="composer-tools">
          <button
            className={`web-toggle ${webMode}`}
            onClick={cycleWeb}
            disabled={!webAvailable}
            title={
              webAvailable
                ? 'Toggle web access (Auto / On / Off)'
                : 'Web access is disabled on this server'
            }
          >
            {webAvailable ? webLabel : '🌐 Web: Unavailable'}
          </button>
          <span className="disclaimer muted small">
            Xenara can make mistakes. Verify important information.
          </span>
        </div>
      </div>
    </main>
  );
}
