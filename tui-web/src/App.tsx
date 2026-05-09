import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './lib/apiClient';
import { setAuthToken } from './lib/auth';
import { syncFromServer, requestPersistentStorage } from './lib/sync';
import { db } from './lib/db';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Session, Host } from './lib/types';
import Dashboard from './components/Dashboard';
import TerminalView from './components/TerminalView';
import { useAuthProbe } from './hooks/useAuthProbe';
import { useHashRoute } from './hooks/useHashRoute';

export default function App() {
  const { authed, setAuthed, token, setToken, authError, setAuthError, checkingAuth } = useAuthProbe();
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [selectedHost, setSelectedHost] = useState<Host | null>(null);
  const [loading, setLoading] = useState(false);
  const { sessionId: currentSessionId, view, setHash } = useHashRoute();

  // Prevent loadSessions from re-setting selectedSession after the user
  // has navigated back to the dashboard (e.g. after killing a session).
  // Without this guard, the in-flight fetch may find the old session in the
  // server list and call setSelectedSession, which then interferes with the
  // navigation back to dashboard.
  const navigatedBackRef = useRef(false);

  // Use Dexie's useLiveQuery for reactive session list
  const localSessions = useLiveQuery(() => db.sessions.orderBy('createdAt').reverse().toArray(), []) || [];

  // Request persistent storage on first load
  useEffect(() => {
    requestPersistentStorage();
  }, []);

  // Prevent accidental window/tab close, especially in PWA standalone mode
  // where Ctrl+W closes the window without warning.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers require returnValue to be set
      return (e.returnValue = '');
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true);
      const list = await api.listSessions();
      // Sync server data into Dexie
      await syncFromServer(list);

      // If we're on a terminal view and the session was killed/removed,
      // redirect back to dashboard
      if (currentSessionId && !list.find((s) => s.id === currentSessionId)) {
        setHash('/');
      }

      // Keep the selected session data fresh — but skip if we've navigated
      // back to the dashboard after a kill so the stale session isn't re-set.
      if (currentSessionId && !navigatedBackRef.current) {
        const fresh = list.find((s) => s.id === currentSessionId);
        if (fresh) {
          setSelectedSession(fresh);
        }
      }
      // Clear the navigation-back flag after processing
      navigatedBackRef.current = false;
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

  // Auto-refresh sessions every 5 seconds on the dashboard only.
  // Terminal view has a hot xterm render/input path; polling here caused
  // visible jank every 5s by fetching sessions, syncing Dexie, and updating
  // selectedSession while the user was typing. Terminal state is kept fresh via
  // WebSocket events instead.
  useEffect(() => {
    if (!authed || currentSessionId) return;
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [authed, currentSessionId, loadSessions]);

  // On initial load, if we have a session ID in the URL, fetch that session
  useEffect(() => {
    if (!authed || !currentSessionId) return;
    const fetchSession = async () => {
      try {
        const s = await api.getSession(currentSessionId);
        setSelectedSession(s);
        setSelectedHost({ id: 'local', name: 'This Machine', address: 'localhost', port: window.location.port ? parseInt(window.location.port) : 5555 });
      } catch {
        // Session not found, go back to dashboard
        setHash('/');
      }
    };
    if (!selectedSession || selectedSession.id !== currentSessionId) {
      fetchSession();
    }
  }, [authed, currentSessionId]);

  // Clear selected terminal state when routing back to dashboard.
  useEffect(() => {
    if (!currentSessionId) {
      setSelectedSession(null);
      setSelectedHost(null);
    }
  }, [currentSessionId]);

  // Stable callback to update session state without re-creating
  // the function on every render. Prevents TerminalView re-renders
  // caused by a new onSessionUpdate reference on each App render.
  const handleSessionUpdate = useCallback((updated: Session) => {
    const updatedId = updated.id || (updated as any).sessionId;
    if (currentSessionId && updatedId && updatedId !== currentSessionId) {
      console.debug('Ignoring foreign session_update in terminal route', { currentSessionId, updatedId });
      return;
    }
    setSelectedSession((prev) => {
      if (prev && updatedId && prev.id !== updatedId) return prev;
      return updated;
    });
  }, [currentSessionId]);

  // Loading probe
  if (checkingAuth) {
    return (
      <div className="auth-screen">
        <div className="auth-form" style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>🖥️ TUI Serve</h1>
          <p style={{ color: '#94a3b8', fontSize: 14 }}>Connecting...</p>
        </div>
      </div>
    );
  }

  // Auth screen — only shown when server requires auth and no valid token stored
  if (!authed) {
    return (
      <div className="auth-screen">
        <div className="auth-form">
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>🖥️ TUI Serve</h1>
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
    navigatedBackRef.current = true;
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
        onSessionUpdate={handleSessionUpdate}
      />
    );
  }

  return (
    <Dashboard
      sessions={localSessions}
      loading={loading}
      onAttach={handleAttach}
      onRefresh={loadSessions}
      onCreateSession={async (opts) => {
        const s = await api.createSession(opts);
        await loadSessions();
        return s;
      }}
      onKillSession={async (id) => {
        // Kill process/session, but keep local Dexie record as disconnected
        // so user can reconnect/resume later.
        const killed = await api.killSession(id);
        const existing = await db.sessions.get(id);
        if (existing) {
          await db.sessions.put({
            ...existing,
            ...killed,
            status: 'disconnected',
            isTombstone: true,
            attachedClients: 0,
            agentSessionId: killed.agentSessionId || existing.agentSessionId || null,
            lastServerSync: new Date().toISOString(),
          });
        }
        await loadSessions();
      }}
      onKillAndRemoveSession={async (id) => {
        // Multi-select destructive action: kill server session if present,
        // then remove from browser DB too.
        try {
          await api.killSession(id);
        } catch {
          // Already disconnected / missing on server. Still remove locally.
        }
        await db.sessions.delete(id);
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
      onResumeSession={async (id) => {
        const result = await api.resumeAgentSession(id);
        await loadSessions();
        return result;
      }}
    />
  );
}