import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Session, Host, CommandInfo, SessionStatus } from '../lib/types';
import type { Session as DexieSession } from '../lib/db';
import { api } from '../lib/apiClient';

// Agent type badge colors & icons
const AGENT_COLORS: Record<string, { bg: string; text: string }> = {
  pi:      { bg: 'rgba(168,85,247,0.15)', text: '#c084fc' },
  claude:  { bg: 'rgba(234,179,8,0.15)',   text: '#facc15' },
  codex:   { bg: 'rgba(6,182,212,0.15)',    text: '#22d3ee' },
  opencode:{ bg: 'rgba(34,197,94,0.15)',    text: '#4ade80' },
};

const AGENT_ICONS: Record<string, string> = {
  pi:      '🟣',
  claude:  '🟡',
  codex:   '🔵',
  opencode:'🟢',
};

const STATUS_CONFIG: Record<SessionStatus, { symbol: string; label: string; color: string }> = {
  running:  { symbol: '●', label: 'Running',  color: '#22c55e' },
  starting: { symbol: '◐', label: 'Starting', color: '#eab308' },
  stopped:  { symbol: '■', label: 'Stopped',  color: '#94a3b8' },
  crashed:  { symbol: '▲', label: 'Crashed',  color: '#ef4444' },
  killed:   { symbol: '✕', label: 'Killed',   color: '#ef4444' },
  unknown:  { symbol: '◆', label: 'Unknown',  color: '#eab308' },
  disconnected: { symbol: '◇', label: 'Disconnected', color: '#64748b' },
};

// Long-press duration in ms
const LONG_PRESS_MS = 500;

interface DashboardProps {
  sessions: Session[];
  loading: boolean;
  onAttach: (session: Session, host: Host) => void;
  onRefresh: () => void;
  onCreateSession: (opts: { id?: string; title?: string; commandId: string; cwd: string; resumeFrom?: string }) => Promise<Session>;
  onKillSession: (id: string) => Promise<void>;
  onKillAndRemoveSession: (id: string) => Promise<void>;
  onRestartSession: (id: string) => Promise<void>;
  onDeleteSession: (id: string) => Promise<void>;
  onResumeSession?: (id: string) => Promise<Session | null>;
}

export default function Dashboard({
  sessions, loading, onAttach, onRefresh, onCreateSession, onKillSession, onKillAndRemoveSession, onRestartSession, onDeleteSession, onResumeSession,
}: DashboardProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [killConfirm, setKillConfirm] = useState<string | null>(null);

  // Multi-select state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Long-press refs
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    api.listHosts().then(setHosts).catch(() => {});
    api.listCommands().then(setCommands).catch(() => {});
  }, []);

  // Exit select mode on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectMode) {
        setSelectMode(false);
        setSelectedIds(new Set());
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectMode]);

  const localHost: Host = hosts[0] || { id: 'local', name: 'This Machine', address: window.location.hostname, port: 3000 };

  // Filter out killed sessions — they should be auto-deleted by the server,
  // but this is a safety net so they never appear in the dashboard.
  const activeSessions = sessions.filter(s => s.status !== 'killed' && s.commandId !== 'shell');

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(activeSessions.map(s => s.id)));
  };

  const clearSelection = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const killAndRemoveSelected = async () => {
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map(id => onKillAndRemoveSession(id)));
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  // Long-press handlers
  const handlePressStart = useCallback((sessionId: string, e?: React.MouseEvent | React.TouchEvent) => {
    longPressTriggeredRef.current = false;
    // Record touch start position for movement detection
    if (e && 'touches' in e) {
      const touch = e.touches[0];
      touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
    } else if (e && 'clientX' in e) {
      touchStartPosRef.current = { x: e.clientX, y: e.clientY };
    }

    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      // Haptic feedback if available
      if (navigator.vibrate) navigator.vibrate(30);
      if (!selectMode) {
        setSelectMode(true);
        setSelectedIds(new Set([sessionId]));
      } else {
        toggleSelect(sessionId);
      }
    }, LONG_PRESS_MS);
  }, [selectMode, toggleSelect]);

  const handlePressMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!longPressTimerRef.current) return;
    // If finger moved too far, cancel long press
    let currentX: number, currentY: number;
    if ('touches' in e) {
      const touch = e.touches[0];
      currentX = touch.clientX;
      currentY = touch.clientY;
    } else {
      currentX = e.clientX;
      currentY = e.clientY;
    }
    const startPos = touchStartPosRef.current;
    if (startPos) {
      const dist = Math.sqrt((currentX - startPos.x) ** 2 + (currentY - startPos.y) ** 2);
      if (dist > 10) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }
  }, []);

  const handlePressEnd = useCallback((session: Session) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    // If long press was triggered, don't handle as click
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }

    // Short click
    if (selectMode) {
      toggleSelect(session.id);
    } else {
      // Clickable sessions: attach if running, resume/recreate based on status
      if (session.status === 'running' || session.status === 'starting') {
        onAttach(session, localHost);
      } else if (session.status === 'crashed' || session.status === 'stopped') {
        // Crashed/stopped: the tmux session may still exist with a shell prompt.
        // Always try to attach first so user can see the terminal.
        // If agentSessionId exists, also offer resume via button.
        onAttach(session, localHost);
      } else if (session.status === 'disconnected') {
        // Disconnected: server has no knowledge of this session.
        // Re-create it with the same commandId and cwd.
        // If we have an agentSessionId, pass it as resumeFrom to auto-resume the agent.
        onCreateSession({
          commandId: session.commandId,
          cwd: session.cwd,
          title: session.title,
          resumeFrom: session.agentSessionId || undefined,
        }).then((newSession) => {
          if (newSession) onAttach(newSession, localHost);
        }).catch(console.error);
      }
    }
  }, [selectMode, onAttach, onRestartSession, onResumeSession, onCreateSession, localHost]);

  const sortedGroups = useMemo(() => {
    const grouped = activeSessions.reduce((acc, session) => {
      const cwd = session.cwd || '/';
      if (!acc[cwd]) acc[cwd] = [];
      acc[cwd].push(session);
      return acc;
    }, {} as Record<string, Session[]>);

    return Object.entries(grouped)
      .map(([cwd, groupSessions]) => {
        // Sort sessions within each group by createdAt descending (newest first)
        const sortedSessions = [...groupSessions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return [cwd, sortedSessions] as const;
      })
      // Sort groups by the createdAt of the most recently created session in each group
      .sort(([, aSessions], [, bSessions]) => new Date(bSessions[0].createdAt).getTime() - new Date(aSessions[0].createdAt).getTime());
  }, [activeSessions]);

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
            <div className="header-subtitle">{localHost.name} · {activeSessions.length} session{activeSessions.length !== 1 ? 's' : ''}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {selectMode && (
            <button className="btn btn-secondary btn-sm" onClick={selectAll}>
              Select All
            </button>
          )}
          {selectMode && (
            <button className="btn btn-ghost btn-sm" onClick={clearSelection}>
              ✕ Cancel
            </button>
          )}
          {!selectMode && (
            <>
              <button className="btn btn-secondary btn-sm" onClick={onRefresh}>
                ↻ Refresh
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
                + New Session
              </button>
            </>
          )}
        </div>
      </div>

      <div className="main-content">
        {loading && activeSessions.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⏳</div>
            <div className="empty-state-title">Loading sessions...</div>
          </div>
        ) : activeSessions.length === 0 ? (
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
                  const agentIcon = AGENT_ICONS[s.commandId] || '⚪';
                  const isSelected = selectedIds.has(s.id);
                  const isRunning = s.status === 'running' || s.status === 'starting';
                  const isInteractable = isRunning || s.status === 'crashed' || s.status === 'stopped' || s.status === 'disconnected';
                  const isResumable = (s.status === 'crashed' || s.status === 'disconnected') && s.agentSessionId;
                  const isRestartable = s.status === 'stopped' || (s.status === 'disconnected' && !s.agentSessionId);

                  return (
                    <div
                      key={s.id}
                      className={`session-tile ${isSelected ? 'session-tile-selected' : ''} ${selectMode ? 'session-tile-selectable' : ''} ${isRunning ? 'session-tile-attachable' : ''} ${isInteractable && !isRunning ? 'session-tile-actionable' : ''}`}
                      onTouchStart={(e) => handlePressStart(s.id, e)}
                      onTouchMove={handlePressMove}
                      onTouchEnd={() => handlePressEnd(s)}
                      onMouseDown={(e) => handlePressStart(s.id, e)}
                      onMouseMove={handlePressMove}
                      onMouseUp={() => handlePressEnd(s)}
                      onContextMenu={(e) => e.preventDefault()}
                    >
                      {/* Checkbox indicator in select mode */}
                      {selectMode && (
                        <div className={`tile-checkbox ${isSelected ? 'tile-checkbox-checked' : ''}`}>
                          {isSelected && <span>✓</span>}
                        </div>
                      )}

                      {/* Agent icon */}
                      <div className="tile-icon" style={{ background: agentColor.bg }}>
                        <span style={{ fontSize: 24 }}>{agentIcon}</span>
                      </div>

                      {/* Card body */}
                      <div className="tile-body">
                        <div className="tile-title">{s.title || s.id}</div>
                        <div className="tile-tags">
                          <span className="tile-tag" style={{ background: `rgba(${hexToRgb(cfg.color)},0.15)`, color: cfg.color }}>
                            {cfg.label}
                          </span>
                          <span className="tile-tag" style={{ background: agentColor.bg, color: agentColor.text }}>
                            {s.commandId}
                          </span>
                          {s.attachedClients > 0 && (
                            <span className="tile-tag" style={{ background: 'rgba(59,130,246,0.15)', color: '#93c5fd' }}>
                              👁 {s.attachedClients}
                            </span>
                          )}
                        </div>
                        <div className="tile-meta">
                          {formatTime(s.createdAt)} · {shortCwd(s.cwd)}
                        </div>
                        {/* Action hint for non-running sessions */}
                        {!isRunning && isInteractable && (
                          s.status === 'crashed' ? (
                            <div style={{ fontSize: 10, color: '#f97316', marginTop: 2 }}>
                              ▶ Tap to attach
                            </div>
                          ) : s.status === 'stopped' ? (
                            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                              ▶ Tap to attach
                            </div>
                          ) : isResumable ? (
                            <div style={{ fontSize: 10, color: '#a78bfa', marginTop: 2 }}>
                              ▶ Tap to reconnect
                            </div>
                          ) : s.status === 'disconnected' ? (
                            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                              ▶ Tap to reconnect
                            </div>
                          ) : null
                        )}
                        {/* Resume button for crashed sessions with agent session ID */}
                        {s.status === 'crashed' && s.agentSessionId && onResumeSession && (
                          <div style={{ marginTop: 6 }}>
                            <button
                              className="btn btn-primary btn-sm"
                              style={{ fontSize: 11, padding: '2px 8px' }}
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  await onResumeSession(s.id);
                                } catch (err: any) {
                                  console.error('Resume failed:', err);
                                }
                              }}
                            >
                              🔄 Resume Session
                            </button>
                          </div>
                        )}
                        {/* Crash count warning */}
                        {(s as any).crashCount > 0 && (
                          <div style={{ fontSize: 10, color: '#ef4444', marginTop: 2 }}>
                            ⚠ Crashed {(s as any).crashCount}x
                          </div>
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

      {/* Fixed bottom selection bar */}
      {selectMode && (
        <div className="selection-bar">
          <div className="selection-bar-info">
            {selectedIds.size} session{selectedIds.size !== 1 ? 's' : ''} selected
          </div>
          <div className="selection-bar-actions">
            <button className="btn btn-secondary btn-sm" onClick={clearSelection}>
              Cancel
            </button>
            {selectedIds.size > 0 && (
              <button className="btn btn-danger btn-sm" onClick={() => setKillConfirm('__multi__')}>
                ☠ Kill and remove ({selectedIds.size})
              </button>
            )}
          </div>
        </div>
      )}

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
            <div className="modal-title">⚠️ {killConfirm === '__multi__' ? 'Kill and remove sessions' : 'Kill Session'}</div>
            <p style={{ color: '#94a3b8', marginBottom: 16 }}>
              {killConfirm === '__multi__'
                ? `Kill ${selectedIds.size} session${selectedIds.size !== 1 ? 's' : ''} and remove them from this browser database? This removes the reconnect card too.`
                : 'Kill this session? The process will stop, but the card stays so you can reconnect/resume later.'
              }
            </p>
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setKillConfirm(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={async () => {
                if (killConfirm === '__multi__') {
                  await killAndRemoveSelected();
                } else {
                  await onKillSession(killConfirm);
                }
                setKillConfirm(null);
              }}>
                {killConfirm === '__multi__' ? 'Kill and remove' : 'Kill Session'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Helper: hex color to "r,g,b" string for rgba */
function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r},${g},${b}`;
}

function CreateSessionModal({ commands, onCreate, onClose, onCreated }: {
  commands: CommandInfo[];
  onCreate: (opts: { id?: string; title?: string; commandId: string; cwd: string }) => Promise<Session>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const agentCommands = useMemo(() => commands.filter((command) => command.id !== 'shell'), [commands]);
  const defaultCwdForCommand = (command?: CommandInfo) => {
    const roots = command?.allowedCwdRoots || [];
    return roots.find(root => root.startsWith('/home/') && root !== '/home/pi') || roots[0] || '/home';
  };
  const [commandId, setCommandId] = useState(agentCommands[0]?.id || 'claude');
  const [cwd, setCwd] = useState(() => {
    const selected = agentCommands.find(c => c.id === commandId);
    return defaultCwdForCommand(selected);
  });
  const [cwdTouched, setCwdTouched] = useState(false);
  const [title, setTitle] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const selected = agentCommands.find(c => c.id === commandId) || agentCommands[0];
    if (!selected) return;
    if (selected.id !== commandId) {
      setCommandId(selected.id);
      return;
    }
    if (!cwdTouched) setCwd(defaultCwdForCommand(selected));
  }, [agentCommands, commandId, cwdTouched]);

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
          <select className="form-select" value={commandId} onChange={(e) => {
            const nextCommandId = e.target.value;
            setCommandId(nextCommandId);
            const selected = agentCommands.find(c => c.id === nextCommandId);
            setCwd(defaultCwdForCommand(selected));
            setCwdTouched(false);
          }}>
            {agentCommands.map((c) => (
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
            onChange={(e) => {
              setCwdTouched(true);
              setCwd(e.target.value);
            }}
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