import { useEffect, useState, useCallback } from 'react';
import Auth from './components/Auth.jsx';
import Sidebar from './components/Sidebar.jsx';
import Chat from './components/Chat.jsx';
import TrainPanel from './components/TrainPanel.jsx';
import ApiKeyPanel from './components/ApiKeyPanel.jsx';
import { api, clearToken } from './api.js';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [engineInfo, setEngineInfo] = useState(null);
  const [engine, setEngine] = useState('auto');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showTrain, setShowTrain] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('xenara_theme') || 'dark');

  useEffect(() => {
    document.body.classList.toggle('light', theme === 'light');
    localStorage.setItem('xenara_theme', theme);
  }, [theme]);

  const refreshEngine = useCallback(() => {
    api.get('/api/chat/engine').then(setEngineInfo).catch(() => {});
  }, []);

  // Bootstrap session.
  useEffect(() => {
    (async () => {
      try {
        const { user } = await api.get('/api/auth/me');
        setUser(user);
      } catch {
        /* not logged in */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const { conversations } = await api.get('/api/conversations');
      setConversations(conversations);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    loadConversations();
    refreshEngine();
  }, [user, loadConversations, refreshEngine]);

  async function openConversation(id) {
    setActiveId(id);
    setSidebarOpen(false);
    try {
      const { messages } = await api.get(`/api/conversations/${id}`);
      setMessages(messages);
    } catch {
      setMessages([]);
    }
  }

  function newChat() {
    setActiveId(null);
    setMessages([]);
    setSidebarOpen(false);
  }

  async function deleteConversation(id) {
    try {
      await api.del(`/api/conversations/${id}`);
      if (id === activeId) newChat();
      loadConversations();
    } catch {
      /* ignore */
    }
  }

  async function logout() {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* ignore */
    }
    clearToken();
    setUser(null);
    setConversations([]);
    setMessages([]);
    setActiveId(null);
  }

  function onConversationCreated(id) {
    setActiveId(id);
    loadConversations();
  }

  if (loading) {
    return (
      <div className="boot">
        <div className="brand-logo lg pulse">X</div>
      </div>
    );
  }

  if (!user) return <Auth onAuthed={setUser} />;

  return (
    <div className="layout">
      <Sidebar
        user={user}
        conversations={conversations}
        activeId={activeId}
        engine={engineInfo}
        onNew={newChat}
        onSelect={openConversation}
        onDelete={deleteConversation}
        onLogout={logout}
        onOpenApiKey={() => setShowApiKey(true)}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <Chat
        messages={messages}
        setMessages={setMessages}
        conversationId={activeId}
        onConversationCreated={onConversationCreated}
        onMenu={() => setSidebarOpen(true)}
        webAvailable={engineInfo?.web?.enabled !== false}
        engines={engineInfo?.engines || []}
        engine={engine}
        setEngine={setEngine}
        onOpenTrain={() => setShowTrain(true)}
      />
      {showTrain && (
        <TrainPanel onClose={() => setShowTrain(false)} onTrained={refreshEngine} />
      )}
      {showApiKey && (
        <ApiKeyPanel user={user} onClose={() => setShowApiKey(false)} />
      )}
    </div>
  );
}
