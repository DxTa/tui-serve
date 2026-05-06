import { useState, useEffect } from 'react';
import type { Session, Host, CommandInfo, SessionStatus } from '../lib/types';
import { api } from '../lib/apiClient';

// Agent type badge colors
const AGENT_COLORS: Record<string, { bg: string; text: string }> = {
  pi:      { bg: 'rgba(168,85,247,0.15)', text: '#c084fc' },
  claude:  { bg: 'rgba(234,179,8,0.15)',   text: '#facc15' },
  codex:   { bg: 'rgba(6,182,212,0.15)',    text: '#22d3ee' },
  opencode:{ bg: 'rgba(34,197,94,0.15)',    text: '#4ade80' },
  shell:   { bg: 'rgba(148,163,184,0.15)',  text: '#94a3b8' },
};

const STATUS_CONFIG: Record<SessionStatus, { symbol: string; label: string }> = {
  running:  { symbol: '●', label: 'Running' },
  starting: { symbol: '◐', label: 'Starting' },
  stopped:  { symbol: '■', label: 'Stopped' },
  crashed:  { symbol: '▲', label: 'Crashed' },
  killed:   { symbol: '✕', label: 'Killed' },
  unknown:  { symbol: '◆', label: 'Unknown' },
};

interface DashboardProps {
  sessions: Session[];
  loading: boolean;
  onAttach: (session: Session, host: Host) => void;
  onRefresh: () => void;
  onCreateSession: (opts: { id?: string; title?: string; commandId: string; cwd: string }) => Promise<Session>;
  onKillSession: (id: string) => Promise<void>;
  onRestartSession: (id: string) => Promise<void>;
  onDeleteSession: (id: string) => Promise<void>;
}

export default function Dashboard({
  sessions, loading, onAttach, onRefresh, onCreateSession, onKillSession, onRestartSession, onDeleteSession,
}: DashboardProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [killConfirm, setKillConfirm] = useState<string | null>(null);

  useEffect(() => {
    api.listHosts().then(setHosts).catch(() => {});
    api.listCommands().then(setCommands).catch(() => {});
  }, []);

  const localHost: Host = hosts[0] || { id: 'local', name: 'This Machine', address: window.location.hostname, port: 3000 };

  // Group sessions by working directory
  const grouped = sessions.reduce((acc, s) => {
    const cwd = s.cwd || '/';
    if (!acc[cwd]) acc[cwd] = [];
    acc[cwd].push(s);
    return acc;
  }, {} as Record<string, Session[]>);

  // Sort groups: directories with running sessions first
  const sortedGroups = Object.entries(grouped).sort((a, b) => {
    const aRunning = a[1].some(s => s.status === 'running' || s.status === 'starting');
    const bRunning = b[1].some(s => s.status === 'running' || s.status === 'starting');
    if (aRunning !== bRunning) return bRunning ? 1 : -1;
    return a[0].localeCompare(b[0]);
  });

  const formatTime = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 60000) return 'just now';
    if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
    if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
    return d.toLocaleDateString();
  };

  // Shorten cwd for group header
  const shortCwd = (cwd: string) => {
    const home = '/home';
    if (cwd.startsWith(home)) return '~' + cwd.substring(home.length);
    return cwd;
  };

  return (
    <div className="app-layout">
      <div className="header">
        <div className="header-left">
          <span style={{ fontSize: 20 }}>🖥️</span>
          <div>
            <div className="header-title">Agent Sessions</div>
            <div className="header-subtitle">{localHost.name} · {sessions.length} session{sessions.length !== 1 ? 's' : ''}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-secondary btn-sm" onClick={onRefresh}>
            ↻ Refresh
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
            + New Session
          </button>
        </div>
      </div>

      <div className="main-content">
        {loading && sessions.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⏳</div>
            <div className="empty-state-title">Loading sessions...</div>
          </div>
        ) : sessions.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🖥️</div>
            <div className="empty-state-title">No active sessions</div>
            <div className="empty-state-desc">Create a new session to start a coding agent</div>
            <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
              + New Session
            </button>
          </div>
        ) : (
          sortedGroups.map(([cwd, groupSessions]) => (
            <div key={cwd} style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 14 }}>📁</span>
                <span style={{ fontFamily: '"JetBrains Mono", monospace', color: '#64748b' }}>{shortCwd(cwd)}</span>
                <span style={{ fontSize: 11, color: '#475569' }}>({groupSessions.length})</span>
              </div>
              <div className="session-grid">
                {groupSessions.map((s) => {
                  const cfg = STATUS_CONFIG[s.status] || STATUS_CONFIG.unknown;
                  const agentColor = AGENT_COLORS[s.commandId] || { bg: 'rgba(148,163,184,0.15)', text: '#94a3b8' };
                  return (
                    <div key={s.id} className="session-card">
                      <div className="session-card-header">
                        <div className="session-title">
                          <span className={`status-badge status-${s.status}`}>
                            <span className="status-dot" />
                            {cfg.label}
                          </span>
                          {s.title || s.id}
                        </div>
                        <span className="agent-badge" style={{ background: agentColor.bg, color: agentColor.text }}>
                          {s.commandId}
                        </span>
                      </div>
                      {s.attachedClients > 0 && (
                        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>👁 {s.attachedClients} viewer{s.attachedClients > 1 ? 's' : ''}</div>
                      )}
                      {s.exitCode !== null && (
                        <div style={{ fontSize: 11, color: '#ef4444', marginBottom: 4 }}>exit code: {s.exitCode}</div>
                      )}
                      <div className="session-meta" style={{ fontSize: 11 }}>
                        Last active: {formatTime(s.lastAttachedAt || s.updatedAt)}
                      </div>
                      <div className="session-actions" style={{ marginTop: 8 }}>
                        {(s.status === 'running' || s.status === 'starting') && (
                          <button className="btn btn-primary btn-sm" onClick={() => onAttach(s, localHost)}>
                            Attach
                          </button>
                        )}
                        {(s.status === 'stopped' || s.status === 'crashed') && (
                          <button className="btn btn-secondary btn-sm" onClick={() => onRestartSession(s.id)}>
                            Restart
                          </button>
                        )}
                        {s.status !== 'killed' && (
                          <button className="btn btn-danger btn-sm" onClick={() => setKillConfirm(s.id)}>
                            Kill
                          </button>
                        )}
                        {s.status === 'killed' && (
                          <button className="btn btn-ghost btn-sm" onClick={() => onDeleteSession(s.id)}>
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Create Session Modal */}
      {showCreate && (
        <CreateSessionModal
          commands={commands}
          onCreate={onCreateSession}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); onRefresh(); }}
        />
      )}

      {/* Kill Confirmation */}
      {killConfirm && (
        <div className="modal-overlay" onClick={() => setKillConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">⚠️ Kill Session</div>
            <p style={{ color: '#94a3b8', marginBottom: 16 }}>
              Are you sure you want to kill this session? The process will be terminated and this cannot be undone.
            </p>
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setKillConfirm(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={async () => {
                await onKillSession(killConfirm);
                setKillConfirm(null);
              }}>
                Kill Session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateSessionModal({ commands, onCreate, onClose, onCreated }: {
  commands: CommandInfo[];
  onCreate: (opts: { id?: string; title?: string; commandId: string; cwd: string }) => Promise<Session>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [commandId, setCommandId] = useState(commands[0]?.id || 'claude');
  const [cwd, setCwd] = useState(() => {
    // Use the first allowed cwd root from the selected command as default
    const selected = commands.find(c => c.id === commandId);
    return selected?.allowedCwdRoots?.[0] || '/home';
  });
  const [title, setTitle] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setError('');
    setCreating(true);
    try {
      const opts: any = { commandId, cwd };
      if (title) opts.title = title;
      if (sessionId) opts.id = sessionId;
      await onCreate(opts);
      onCreated();
    } catch (err: any) {
      setError(err.message || 'Failed to create session');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Create New Session</div>

        <div className="form-group">
          <label className="form-label">Agent Type</label>
          <select className="form-select" value={commandId} onChange={(e) => setCommandId(e.target.value)}>
            {commands.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}{c.requiresConfirmation ? ' ⚠️' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Working Directory</label>
          <input
            className="form-input"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/home/pi/projects/my-app"
          />
        </div>

        <div className="form-group">
          <label className="form-label">Title (optional)</label>
          <input
            className="form-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="My coding agent"
          />
        </div>

        <div className="form-group">
          <label className="form-label">Session ID (optional)</label>
          <input
            className="form-input"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="auto-generated"
          />
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Lowercase letters, numbers, and hyphens only. Must start with a letter or number.
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleCreate} disabled={creating || !cwd}>
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}