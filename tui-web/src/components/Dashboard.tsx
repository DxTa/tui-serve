import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Session, Host, CommandInfo, SessionStatus } from '../lib/types';
import type { Session as DexieSession } from '../lib/db';
import { api } from '../lib/apiClient';
import { db } from '../lib/db';

// Agent type badge colors
const AGENT_COLORS: Record<string, { bg: string; text: string }> = {
  pi:      { bg: '#09090b', text: '#c084fc' },
  claude:  { bg: 'rgba(217,119,87,0.15)', text: '#D97757' },
  codex:   { bg: 'rgba(6,182,212,0.15)',   text: '#22d3ee' },
  opencode:{ bg: '#18181b', text: '#4ade80' },
};

// Agent logo SVG components
function PiLogo() {
  // Official pi.dev/favicon.svg — dark rounded-rect with white Pi lettermark
  return (
    <svg viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="800" rx="120" fill="#09090b"/>
      <path fill="#fff" fillRule="evenodd" d="
        M165.29 165.29
        H517.36
        V400
        H400
        V517.36
        H282.65
        V634.72
        H165.29
        Z
        M282.65 282.65
        V400
        H400
        V282.65
        Z
      "/>
      <path fill="#fff" d="M517.36 400 H634.72 V634.72 H517.36 Z"/>
    </svg>
  );
}

function ClaudeLogo() {
  return (
    <svg viewBox="0 0 16 16" fill="#D97757" xmlns="http://www.w3.org/2000/svg">
      <path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z" />
    </svg>
  );
}

function CodexLogo() {
  // OpenAI mark (used by Codex CLI) with explicit fill for dark background
  return (
    <svg viewBox="0 0 16 16" fill="#fff" xmlns="http://www.w3.org/2000/svg">
      <path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z" />
    </svg>
  );
}

function OpenCodeLogo() {
  // Official opencode.ai brand Mark — pixel O on rounded dark background
  return (
    <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="20" height="20" rx="4" fill="#18181b"/>
      <g transform="translate(2, 0)">
        <path d="M12 16H4V8H12V16Z" fill="#71717a" />
        <path d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="#4ade80" />
      </g>
    </svg>
  );
}

const AGENT_LOGOS: Record<string, React.FC> = {
  pi: PiLogo,
  claude: ClaudeLogo,
  codex: CodexLogo,
  opencode: OpenCodeLogo,
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
  const pressMovedRef = useRef(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  // Track whether a touch event was already handled so we can skip
  // the synthesized mouse events that browsers fire after touchend.
  // Without this guard, tap-to-select in multi-select mode toggles twice
  // (touch + mouse) which cancels itself out and appears as "not working".
  const touchHandledRef = useRef(false);

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
  const recentCwds = useMemo(() => {
    const seen = new Set<string>();
    return [...sessions]
      .sort((a, b) => new Date(b.lastAttachedAt || b.updatedAt || b.createdAt).getTime() - new Date(a.lastAttachedAt || a.updatedAt || a.createdAt).getTime())
      .map((session) => session.cwd)
      .filter((cwd) => {
        if (!cwd || seen.has(cwd)) return false;
        seen.add(cwd);
        return true;
      })
      .slice(0, 10);
  }, [sessions]);

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
    // If a touch event already started this press, skip the synthesized mousedown.
    if (touchHandledRef.current && e && !('touches' in e)) return;
    if (e && 'touches' in e) touchHandledRef.current = true;

    longPressTriggeredRef.current = false;
    pressMovedRef.current = false;
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
    // Skip synthesized mouse events after touch
    if (touchHandledRef.current && !('touches' in e)) return;
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
      const deltaX = currentX - startPos.x;
      const deltaY = currentY - startPos.y;
      const dist = Math.sqrt(deltaX ** 2 + deltaY ** 2);
      // Mobile list scroll: any meaningful drag must cancel both long-press and
      // eventual tap/attach. Use lower vertical threshold than horizontal so
      // swipe-to-scroll never accidentally opens a session on touchend.
      if (dist > 10 || Math.abs(deltaY) > 6) {
        pressMovedRef.current = true;
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }
  }, []);

  const handlePressEnd = useCallback((session: Session) => {
    // Skip synthesized mouse events after touch — on mobile, the browser fires
    // mousedown+mouseup after touchend, which would toggle selection a second
    // time, canceling the first toggle and making taps appear to do nothing.
    if (touchHandledRef.current) {
      // This is a mouseup from a touch sequence — skip it.
      // Reset the flag only on mouse events so the next pure-mouse press works.
      touchHandledRef.current = false;
      // Clear any lingering timer (safety)
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      longPressTriggeredRef.current = false;
      pressMovedRef.current = false;
      touchStartPosRef.current = null;
      return;
    }

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    // If long press or drag/scroll was triggered, don't handle as click.
    if (longPressTriggeredRef.current || pressMovedRef.current) {
      longPressTriggeredRef.current = false;
      pressMovedRef.current = false;
      touchStartPosRef.current = null;
      return;
    }

    touchStartPosRef.current = null;

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
        // Remove the stale local record first so reconnect doesn't
        // produce a duplicate card alongside the new one.
        db.sessions.delete(session.id).catch(() => {});
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
                  const AgentLogo = AGENT_LOGOS[s.commandId] || null;
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

                      {/* Agent logo */}
                      <div className="tile-icon" style={{ background: agentColor.bg }}>
                        {AgentLogo ? <AgentLogo /> : <span style={{ fontSize: 24, color: agentColor.text }}>◆</span>}
                      </div>

                      {/* Card body */}
                      <div className="tile-body">
                        <div className="tile-title">{s.title || s.id}</div>
                        <div className="tile-tags">
                          <span className="tile-tag" style={{ background: `rgba(${hexToRgb(cfg.color)},0.15)`, color: cfg.color }}>
                            {cfg.label}
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
          recentCwds={recentCwds}
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

function CreateSessionModal({ commands, recentCwds, onCreate, onClose, onCreated }: {
  commands: CommandInfo[];
  recentCwds: string[];
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
            list="recent-cwds"
            value={cwd}
            onChange={(e) => {
              setCwdTouched(true);
              setCwd(e.target.value);
            }}
            placeholder="/home/pi/projects/my-app"
          />
          {recentCwds.length > 0 && (
            <datalist id="recent-cwds">
              {recentCwds.map((recentCwd) => (
                <option key={recentCwd} value={recentCwd} />
              ))}
            </datalist>
          )}
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