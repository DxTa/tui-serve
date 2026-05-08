import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalSocket } from '../lib/terminalSocket';
import { api } from '../lib/apiClient';
import { requestWakeLock, releaseWakeLock, setupWakeLockRecovery, onVisibilityChange, onConnectionChange } from '../lib/pwa-utils';
import type { Session, Host, SessionStatus } from '../lib/types';

interface TerminalViewProps {
  session: Session;
  host: Host;
  onBack: () => void;
  onSessionUpdate: (session: Session) => void;
}

export default function TerminalView({ session, host, onBack, onSessionUpdate }: TerminalViewProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<TerminalSocket | null>(null);
  const [connectionState, setConnectionState] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  const [currentSession, setCurrentSession] = useState(session);
  const [fontSize, setFontSize] = useState(14);
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [visualViewportHeight, setVisualViewportHeight] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null;
    return window.visualViewport?.height ?? window.innerHeight;
  });
  const fitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSessionIdRef = useRef(session.id);
  const attachedSessionIdRef = useRef(session.id);

  // When host is 'localhost' (the server that served this page), always use
  // window.location.origin — this works correctly regardless of access method
  // (localhost, LAN IP, Tailscale hostname, etc.). Only remote hosts need
  // an explicit URL constructed from their address/port.
  const hostUrl = host.address === 'localhost'
    ? window.location.origin
    : `${window.location.protocol}//${host.address}:${host.port}`;

  // Update session from parent
  useEffect(() => {
    setCurrentSession(session);
  }, [session]);

  const fitAndResize = useCallback(() => {
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const socket = socketRef.current;

    if (!term || !fitAddon) return;

    try {
      fitAddon.fit();
      socket?.resize(currentSessionIdRef.current, term.cols, term.rows);
    } catch {
      // FitAddon can throw while container is detached/hidden during route changes.
    }
  }, []);

  const scheduleFitAndResize = useCallback((delay = 100) => {
    if (fitTimeoutRef.current) clearTimeout(fitTimeoutRef.current);
    fitTimeoutRef.current = setTimeout(fitAndResize, delay);
  }, [fitAndResize]);

  // Chrome Android does not always resize the layout viewport when the soft
  // keyboard opens. The visual viewport does shrink, so pin the terminal layout
  // to that height; otherwise the keyboard covers the bottom half of xterm.
  useEffect(() => {
    const updateVisualViewportHeight = () => {
      setVisualViewportHeight(window.visualViewport?.height ?? window.innerHeight);
      scheduleFitAndResize(50);
    };

    updateVisualViewportHeight();
    window.visualViewport?.addEventListener('resize', updateVisualViewportHeight);
    window.visualViewport?.addEventListener('scroll', updateVisualViewportHeight);
    window.addEventListener('resize', updateVisualViewportHeight);

    return () => {
      window.visualViewport?.removeEventListener('resize', updateVisualViewportHeight);
      window.visualViewport?.removeEventListener('scroll', updateVisualViewportHeight);
      window.removeEventListener('resize', updateVisualViewportHeight);
    };
  }, [scheduleFitAndResize]);

  useEffect(() => {
    const previousSessionId = attachedSessionIdRef.current;
    currentSessionIdRef.current = session.id;

    if (previousSessionId === session.id) return;

    socketRef.current?.detach(previousSessionId);
    terminalRef.current?.clear();
    socketRef.current?.attach(session.id);
    attachedSessionIdRef.current = session.id;
    terminalRef.current?.focus();
    scheduleFitAndResize(0);
  }, [session.id, scheduleFitAndResize]);

  // Initialize terminal + socket
  useEffect(() => {
    if (!termRef.current) return;

    // Create terminal
    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'DejaVu Sans Mono', 'Liberation Mono', 'Ubuntu Mono', monospace",
      lineHeight: 1.15,
      letterSpacing: 0,
      theme: {
        background: '#0f172a',
        foreground: '#f1f5f9',
        cursor: '#3b82f6',
        selectionBackground: 'rgba(59,130,246,0.3)',
        selectionForeground: '#f1f5f9',
        black: '#1e293b',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#f1f5f9',
        brightBlack: '#475569',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#f8fafc',
      },
      allowProposedApi: false,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    term.focus();

    // Wait for font to load before fitting — prevents spacing issues
    document.fonts.ready.then(() => {
      fitAndResize();
      requestAnimationFrame(() => {
        fitAndResize();
        term.focus();
      });
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Create socket
    const socket = new TerminalSocket();
    socketRef.current = socket;

    socket.onConnectionChange = (state) => {
      setConnectionState(state);
    };

    socket.onOutput = (sessionId, data) => {
      if (sessionId !== currentSessionIdRef.current) return;
      term.write(data);
    };

    socket.onSnapshot = (sessionId, data) => {
      if (sessionId !== currentSessionIdRef.current) return;
      term.clear();
      term.write(data);
    };

    socket.onStatus = (sessionId, status, _pid, exitCode) => {
      if (sessionId !== currentSessionIdRef.current) return;
      const newStatus = status as SessionStatus;
      setCurrentSession((prev) => {
        const updated = { ...prev, status: newStatus, exitCode };
        onSessionUpdate(updated);
        return updated;
      });
      if (newStatus === 'running') {
        setRestarting(false);
      }
    };

    socket.onSessionUpdate = (updated) => {
      setCurrentSession((prev) => ({ ...prev, ...updated }));
      onSessionUpdate({ ...currentSession, ...updated } as Session);
    };

    socket.onKilled = () => {
      setCurrentSession((prev) => ({ ...prev, status: 'killed' as SessionStatus }));
    };

    // Connect and attach (attach is queued until connection opens)
    socket.connect(hostUrl);
    socket.attach(currentSessionIdRef.current);
    attachedSessionIdRef.current = currentSessionIdRef.current;

    // Input handler
    const inputData = term.onData((data) => {
      socket.sendInput(currentSessionIdRef.current, data);
    });

    // Resize handler with debounce. Browser zoom and app font zoom both change
    // character-cell geometry, so always propagate new cols/rows to PTY.
    const handleResize = () => {
      scheduleFitAndResize(100);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(termRef.current);
    window.addEventListener('resize', handleResize);

    // Re-fit on browser zoom changes
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
    }

    // Wake-lock: keep screen on while terminal is visible
    requestWakeLock();
    const releaseWakeLockCleanup = setupWakeLockRecovery();

    // Visibility change: reconnect when page becomes visible again
    const visibilityCleanup = onVisibilityChange((visible) => {
      if (visible && socket.connectionState !== 'connected') {
        // Reconnect and re-attach
        socket.connect(hostUrl);
        socket.attach(currentSessionIdRef.current);
      }
    });

    // Online/offline events
    const connCleanup = onConnectionChange((online) => {
      if (online && socket.connectionState !== 'connected') {
        socket.connect(hostUrl);
        socket.attach(currentSessionIdRef.current);
      }
    });

    return () => {
      inputData.dispose();
      window.removeEventListener('resize', handleResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize);
      }
      resizeObserver.disconnect();
      visibilityCleanup();
      connCleanup();
      releaseWakeLockCleanup();
      releaseWakeLock();
      if (fitTimeoutRef.current) clearTimeout(fitTimeoutRef.current);
      socket.detach(attachedSessionIdRef.current);
      socket.disconnect();
      term.dispose();
    };
  }, [fitAndResize, scheduleFitAndResize, hostUrl]);

  // Keep latest session id available to stable terminal callbacks.
  useEffect(() => {
    currentSessionIdRef.current = currentSession.id;
  }, [currentSession.id]);

  // Update font size and notify PTY. Do one immediate fit plus a next-frame fit
  // because xterm measures cell dimensions after DOM/font style flush.
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;

    term.options.fontSize = fontSize;
    fitAndResize();
    const frame = requestAnimationFrame(fitAndResize);

    return () => cancelAnimationFrame(frame);
  }, [fontSize, fitAndResize]);

  const changeFontSize = (delta: number) => {
    setFontSize((size) => Math.max(8, Math.min(24, size + delta)));
    requestAnimationFrame(() => {
      fitAndResize();
      terminalRef.current?.focus();
    });
  };

  const keepTerminalFocus = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  };

  const handleKill = async () => {
    await api.killSession(currentSession.id);
    socketRef.current?.kill(currentSession.id);
    setShowKillConfirm(false);
    setCurrentSession((prev) => ({ ...prev, status: 'killed' as SessionStatus }));
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      const updated = await api.restartSession(currentSession.id);
      setCurrentSession(updated);
      onSessionUpdate(updated);

      // Wait a moment for tmux session to create, then re-attach
      setTimeout(() => {
        if (socketRef.current) {
          socketRef.current.connect(hostUrl);
          socketRef.current.attach(currentSession.id);
        }
      }, 1500);
    } catch {
      setRestarting(false);
    }
  };

  const sendKey = (data: string) => {
    socketRef.current?.sendInput(currentSessionIdRef.current, data);
  };

  const connClass = connectionState === 'connected' ? 'conn-connected' :
    connectionState === 'reconnecting' ? 'conn-reconnecting' : 'conn-disconnected';
  const connLabel = connectionState === 'connected' ? 'Connected' :
    connectionState === 'reconnecting' ? 'Reconnecting...' : 'Disconnected';

  const isRunning = currentSession.status === 'running' || currentSession.status === 'starting';
  const isStopped = currentSession.status === 'stopped' || currentSession.status === 'crashed';

  return (
    <div className="app-layout" style={visualViewportHeight ? { height: visualViewportHeight } : undefined}>
      {/* Terminal header */}
      <div className="terminal-header">
        <div className="header-left">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back</button>
          <div>
            <div className="header-title" style={{ fontSize: 14 }}>{currentSession.title}</div>
            <div className="header-subtitle">{currentSession.commandId} · {currentSession.cwd}</div>
          </div>
        </div>
        <div className="terminal-actions">
          <div className={`conn-indicator ${connClass}`}>
            <span className="conn-dot" />
            {connLabel}
          </div>

          {isRunning && !restarting && (
            <button className="btn btn-danger btn-sm" onClick={() => setShowKillConfirm(true)}>Kill</button>
          )}
          {(isStopped || currentSession.status === 'killed') && !restarting && (
            <button className="btn btn-primary btn-sm" onClick={handleRestart} disabled={restarting}>
              Restart
            </button>
          )}
          {restarting && (
            <button className="btn btn-secondary btn-sm" disabled>Restarting...</button>
          )}
          <button className="btn btn-ghost btn-sm" onMouseDown={keepTerminalFocus} onClick={() => changeFontSize(2)}>A+</button>
          <button className="btn btn-ghost btn-sm" onMouseDown={keepTerminalFocus} onClick={() => changeFontSize(-2)}>A-</button>
        </div>
      </div>

      {/* Terminal */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
        <div className="terminal-container" ref={termRef} />
        {!isRunning && !isStopped && currentSession.status !== 'killed' && currentSession.status !== 'crashed' && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{ color: '#94a3b8', fontSize: 14 }}>Starting session...</div>
          </div>
        )}
        {currentSession.status === 'killed' && !restarting && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 12,
          }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Session Killed</div>
            <div style={{ color: '#94a3b8', fontSize: 14 }}>This session has been terminated</div>
            <button className="btn btn-primary" onClick={handleRestart}>Restart Session</button>
          </div>
        )}
        {isStopped && !restarting && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 12,
          }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>
              Session {currentSession.status === 'crashed' ? 'Crashed' : 'Stopped'}
            </div>
            {currentSession.exitCode !== null && (
              <div style={{ color: '#94a3b8', fontSize: 14 }}>Exit code: {currentSession.exitCode}</div>
            )}
            <button className="btn btn-primary" onClick={handleRestart}>Restart Session</button>
          </div>
        )}
        {restarting && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 12,
          }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Restarting...</div>
            <div style={{ color: '#94a3b8', fontSize: 14 }}>Reconnecting to session</div>
          </div>
        )}
        {currentSession.status === 'crashed' && !restarting && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 12,
          }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: '#ef4444' }}>Session Crashed</div>
            {currentSession.exitCode !== null && currentSession.exitCode !== undefined && (
              <div style={{ color: '#94a3b8', fontSize: 14 }}>Exit code: {currentSession.exitCode}</div>
            )}
            <button className="btn btn-primary" onClick={handleRestart}>Restart Session</button>
          </div>
        )}
      </div>

      {/* Mobile key bar */}
      <MobileKeyBar onKey={sendKey} />

      {/* Kill confirm modal */}
      {showKillConfirm && (
        <div className="modal-overlay" onClick={() => setShowKillConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">⚠️ Kill Session</div>
            <p style={{ color: '#94a3b8', marginBottom: 16 }}>
              Kill "{currentSession.title}"? The agent process will be terminated. This cannot be undone.
            </p>
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setShowKillConfirm(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleKill}>Kill Session</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MobileKeyBar({ onKey }: { onKey: (data: string) => void }) {
  const keys: Array<{ label: string; data: string; title: string; group?: string }> = [
    // Control keys
    { label: 'Esc',  data: '\x1b',   title: 'Escape — cancel current input or action',            group: 'ctrl' },
    { label: 'Tab',  data: '\t',     title: 'Tab — autocomplete or next field',                      group: 'ctrl' },
    // Arrow keys
    { label: '↑', data: '\x1b[A', title: 'Arrow Up — previous command / move up',    group: 'arrow' },
    { label: '↓', data: '\x1b[B', title: 'Arrow Down — next command / move down',    group: 'arrow' },
    { label: '←', data: '\x1b[D', title: 'Arrow Left — move cursor left',             group: 'arrow' },
    { label: '→', data: '\x1b[C', title: 'Arrow Right — move cursor right',            group: 'arrow' },
    // Special characters
    { label: '/', data: '/',     title: 'Slash — start Pi command (e.g., /help)',     group: 'char' },
    { label: '~', data: '~',     title: 'Tilde — home directory shortcut (~/)',         group: 'char' },
    { label: '|', data: '|',     title: 'Pipe — chain commands (cmd1 | cmd2)',         group: 'char' },
    // Enter keys
    { label: '⇧ Enter', data: '\x1b\r', title: 'Shift+Enter — new line without submitting',  group: 'enter' },
    { label: 'Enter', data: '\r', title: 'Enter — submit command / newline',             group: 'enter' },
  ];

  return (
    <div className="mobile-keybar">
      {keys.map((k) => (
        <button
          key={k.label}
          className={`btn key-${k.group || 'default'}`}
          onClick={() => onKey(k.data)}
          title={k.title}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}