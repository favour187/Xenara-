export default function Sidebar({
  user,
  conversations,
  activeId,
  engine,
  onNew,
  onSelect,
  onDelete,
  onLogout,
  onOpenApiKey,
  theme,
  onToggleTheme,
  open,
  onClose,
}) {
  return (
    <>
      <div className={open ? 'sidebar-backdrop show' : 'sidebar-backdrop'} onClick={onClose} />
      <aside className={open ? 'sidebar open' : 'sidebar'}>
        <div className="sidebar-top">
          <div className="brand-row">
            <div className="brand-logo sm">X</div>
            <span>Xenara</span>
          </div>
          <button className="new-chat" onClick={onNew}>
            + New chat
          </button>
        </div>

        <nav className="convo-list">
          {conversations.length === 0 && <p className="muted small pad">No conversations yet.</p>}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={c.id === activeId ? 'convo active' : 'convo'}
              onClick={() => onSelect(c.id)}
            >
              <span className="convo-title">{c.title}</span>
              <button
                className="convo-del"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-actions-row">
            <button className="apikey-btn" onClick={onOpenApiKey} title="Your personal API key">
              🔑 API key
            </button>
            <button className="theme-btn" onClick={onToggleTheme} title="Toggle light/dark theme">
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
          {engine && (
            <div className="engine-badge" title="Active engine">
              <span className={engine.mode === 'connected' ? 'dot on' : 'dot'} />
              {engine.mode === 'connected' ? `Model: ${engine.model}` : 'Xenara Core'}
            </div>
          )}
          {engine?.web && (
            <div className="engine-badge" title="Web research provider">
              <span className={engine.web.enabled ? 'dot on' : 'dot'} />
              {engine.web.enabled ? `Web: ${engine.web.provider}` : 'Web: off'}
            </div>
          )}
          <div className="user-row">
            <div className="avatar">{(user?.name || '?')[0].toUpperCase()}</div>
            <div className="user-meta">
              <div className="user-name">{user?.name}</div>
              <div className="muted small">{user?.email}</div>
            </div>
            <button className="logout" onClick={onLogout} title="Sign out">
              ⎋
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
