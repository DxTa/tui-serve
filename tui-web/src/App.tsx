import { useState, useEffect, useCallback } from 'react';
import { api } from './lib/apiClient';
import { getAuthToken, setAuthToken, hasAuthToken } from './lib/auth';
import type { Session, Host } from './lib/types';
import Dashboard from './components/Dashboard';
import TerminalView from './components/TerminalView';

// Simple hash-based routing:
//   /           → dashboard
//   /s/{id}     → terminal view for session {id}
function getSessionIdFromHash(): string | null {
  const hash = window.location.hash.replace('#', '');
  if (hash.startsWith('/s/')) {
    return hash.substring(3);
  }
  return null;
}

function setHash(hash: string) {
  window.location.hash = hash;
}

export default function App() {
  const [authed, setAuthed] = useState(hasAuthToken());
  const [token, setToken] = useState(getAuthToken() || '');
  const [authError, setAuthError] = useState('');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [selectedHost, setSelectedHost] = useState<Host | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);

  // Derive view from URL hash
  const currentSessionId = getSessionIdFromHash();
  const view: 'dashboard' | 'terminal' = currentSessionId ? 'terminal' : 'dashboard';

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true);
      const list = await api.listSessions();
      setSessions(list);

      // If we're on a terminal view and the session was killed/removed,
      // redirect back to dashboard
      if (currentSessionId && !list.find((s) => s.id === currentSessionId)) {
        setHash('/');
      }

      // Keep the selected session data fresh
      if (currentSessionId) {
        const fresh = list.find((s) => s.id === currentSessionId);
        if (fresh) {
          setSelectedSession(fresh);
        }
      }
    } catch (err: any) {
      if (err.message === 'Unauthorized') {
        setAuthed(false);
      }
    } finally {
      setLoading(false);
    }
  }, [currentSessionId]);

  useEffect(() => {
    if (authed) loadSessions();
  }, [authed, loadSessions]);

  // Auto-refresh sessions
  useEffect(() => {
    if (!authed) return;
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [authed, loadSessions]);

  // On initial load, if we have a session ID in the URL, fetch that session
  useEffect(() => {
    if (!authed || !currentSessionId) return;
    const fetchSession = async () => {
      try {
        const s = await api.getSession(currentSessionId);
        setSelectedSession(s);
        // Use local host by default
        setSelectedHost({ id: 'local', name: 'This Machine', address: 'localhost', port: window.location.port ? parseInt(window.location.port) : 3000 });
      } catch {
        // Session not found, go back to dashboard
        setHash('/');
      }
    };
    if (!selectedSession || selectedSession.id !== currentSessionId) {
      fetchSession();
    }
  }, [authed, currentSessionId]);

  // Handle browser back/forward
  useEffect(() => {
    const handleHashChange = () => {
      const sid = getSessionIdFromHash();
      if (!sid) {
        setSelectedSession(null);
        setSelectedHost(null);
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Auth screen
  if (!authed) {
    return (
      <div className="auth-screen">
        <div className="auth-form">
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>🖥️ Remote Agent TUI</h1>
          <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 24 }}>
            Enter your auth token to connect
          </p>
          <input
            className="form-input"
            type="password"
            placeholder="Auth token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setAuthToken(token);
                setAuthed(true);
                setAuthError('');
              }
            }}
          />
          {authError && <div className="form-error">{authError}</div>}
          <button
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 8 }}
            onClick={() => {
              setAuthToken(token);
              setAuthed(true);
              setAuthError('');
            }}
          >
            Connect
          </button>
        </div>
      </div>
    );
  }

  const handleAttach = (session: Session, host: Host) => {
    setSelectedSession(session);
    setSelectedHost(host);
    setHash(`/s/${session.id}`);
  };

  const handleBack = () => {
    setSelectedSession(null);
    setSelectedHost(null);
    setHash('/');
    loadSessions();
  };

  if (view === 'terminal' && selectedSession && selectedHost) {
    return (
      <TerminalView
        session={selectedSession}
        host={selectedHost}
        onBack={handleBack}
        onSessionUpdate={(updated) => {
          setSelectedSession(updated);
        }}
      />
    );
  }

  return (
    <Dashboard
      sessions={sessions}
      loading={loading}
      onAttach={handleAttach}
      onRefresh={loadSessions}
      onCreateSession={async (opts) => {
        const s = await api.createSession(opts);
        await loadSessions();
        return s;
      }}
      onKillSession={async (id) => {
        await api.killSession(id);
        await loadSessions();
      }}
      onRestartSession={async (id) => {
        await api.restartSession(id);
        await loadSessions();
      }}
      onDeleteSession={async (id) => {
        await api.deleteSession(id);
        await loadSessions();
      }}
    />
  );
}