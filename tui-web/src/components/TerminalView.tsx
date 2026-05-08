import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';
import { TerminalSocket } from '../lib/terminalSocket';
import { api } from '../lib/apiClient';
import { db } from '../lib/db';
import { requestWakeLock, releaseWakeLock, setupWakeLockRecovery, onVisibilityChange, onConnectionChange } from '../lib/pwa-utils';
import { useVisualViewportHeight } from '../hooks/useVisualViewportHeight';
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
  const [resuming, setResuming] = useState(false);
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

  const visualViewportHeight = useVisualViewportHeight(() => scheduleFitAndResize(50));

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

    // Renderer chain: WebGL (fastest) → Canvas → DOM fallback.
    // DOM renderer creates/manipulates many <span> nodes per frame; Canvas/WebGL
    // paint directly and are much better for rapid typing/output.
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
        try {
          term.loadAddon(new CanvasAddon());
        } catch (canvasError) {
          console.warn('Canvas renderer unavailable after WebGL context loss:', canvasError);
        }
      });
      term.loadAddon(webglAddon);
    } catch (webglError) {
      try {
        term.loadAddon(new CanvasAddon());
      } catch (canvasError) {
        console.warn('WebGL and Canvas renderers unavailable, falling back to DOM renderer:', webglError, canvasError);
      }
    }

    // Capture Ctrl+W/T/N before the browser closes tabs/opens windows.
    // xterm's custom key handler runs before xterm processes the key.
    // Returning true tells xterm to process the key AND call preventDefault()
    // on the original DOM event, which prevents the browser shortcut.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        switch (e.key) {
          case 'w':
          case 't':
          case 'n':
            return true; // let xterm process it → sends to PTY + preventDefault
        }
      }
      return true; // don't interfere with other keys
    });

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

    // Buffer terminal writes and flush once per animation frame.
    // Without this, every small WebSocket message triggers a separate
    // term.write() → parser → renderer cycle.  Batching collapses many
    // tiny writes (escape sequences, echo chunks) into a single render,
    // dramatically reducing jank when typing fast.
    let writeBuffer: Uint8Array[] = [];
    let writeRafId: number | null = null;
    const flushWrites = () => {
      writeRafId = null;
      if (writeBuffer.length === 0) return;
      // Concat all chunks into a single write so xterm parses and
      // renders in one pass.
      const totalLen = writeBuffer.reduce((s, b) => s + b.length, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of writeBuffer) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      writeBuffer = [];
      term.write(merged);
    };
    const scheduleWrite = (data: Uint8Array) => {
      writeBuffer.push(data);
      if (!writeRafId) {
        writeRafId = requestAnimationFrame(flushWrites);
      }
    };

    socket.onOutput = (sessionId, data) => {
      if (sessionId !== currentSessionIdRef.current) return;
      scheduleWrite(data);
    };

    socket.onSnapshot = (sessionId, data) => {
      if (sessionId !== currentSessionIdRef.current) return;
      // Flush any buffered writes first, then apply snapshot
      if (writeRafId) cancelAnimationFrame(writeRafId);
      writeBuffer = [];
      writeRafId = null;
      term.clear();
      term.write(data);
    };

    socket.onStatus = (sessionId, status, _pid, exitCode) => {
      if (sessionId !== currentSessionIdRef.current) return;
      const newStatus = status as SessionStatus;
      // Status changes are rare during active typing. Only propagate to
      // React state when the status ACTUALLY changes to avoid triggering
      // unnecessary re-renders of the component tree.
      setCurrentSession((prev) => {
        if (prev.status === newStatus && prev.exitCode === exitCode) return prev;
        const updated = { ...prev, status: newStatus, exitCode };
        onSessionUpdate(updated);
        return updated;
      });
      if (newStatus === 'running') {
        setRestarting(false);
      }
    };

    socket.onSessionUpdate = (updated) => {
      setCurrentSession((prev) => {
        const merged = { ...prev, ...updated };
        onSessionUpdate(merged);
        return merged;
      });
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
      if (writeRafId) cancelAnimationFrame(writeRafId);
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

  // Touch-to-scroll for mobile: xterm.js renders a canvas (.xterm-screen)
  // on top of the scrollable viewport (.xterm-viewport). Touch events hit
  // the screen layer first and are consumed for selection, so the viewport
  // never receives native touch-scroll events. This effect bridges the gap
  // by converting vertical touch swipes on the terminal container into
  // xterm scrollLines() calls that update both the viewport and canvas.
  useEffect(() => {
    const container = termRef.current;
    if (!container) return;

    let touchStartY = 0;
    let lastTouchY = 0;
    let isScrolling = false;
    // Threshold (px) to distinguish a scroll from a tap
    const SCROLL_THRESHOLD = 8;

    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0].clientY;
      touchStartY = lastTouchY;
      isScrolling = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      const touchY = e.touches[0].clientY;
      const deltaY = lastTouchY - touchY;
      lastTouchY = touchY;

      // Only activate scroll mode once the finger has moved past the threshold
      if (!isScrolling && Math.abs(touchY - touchStartY) > SCROLL_THRESHOLD) {
        isScrolling = true;
      }

      if (!isScrolling || deltaY === 0) return;

      const term = terminalRef.current;
      if (!term) return;

      // Use xterm's scrollLines to keep the internal buffer and canvas in sync.
      // A single touch-move event typically moves 1–3 px; scroll by 1 line per
      // event, and xterm will redraw the visible portion accordingly.
      const lines = deltaY > 0 ? 1 : -1;
      term.scrollLines(lines);

      // Prevent the page from also scrolling while the user is scrolling
      // the terminal. Without this the browser would try to scroll the
      // <html> element (which has overflow:hidden anyway), or on iOS the
      // entire viewport rubber-bands.
      e.preventDefault();
    };

    const onTouchEnd = () => {
      isScrolling = false;
    };

    // passive:false is required on touchmove so we can call preventDefault()
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

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

  // Belt-and-suspenders: window-level keydown capture to preventDefault browser
  // shortcuts when terminal is focused. xterm's attachCustomKeyEventHandler
  // handles the primary interception (above), this is defense-in-depth.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const textarea = document.querySelector('.xterm-helper-textarea');
      if (!textarea || document.activeElement !== textarea) return;
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        switch (e.key) {
          case 'w':
          case 't':
          case 'n':
            e.preventDefault();
            break;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const keepTerminalFocus = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  };

  const handleKill = async () => {
    const killed = await api.killSession(currentSession.id);
    const existing = await db.sessions.get(currentSession.id);
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
    socketRef.current?.kill(currentSession.id);
    setShowKillConfirm(false);
    setCurrentSession((prev) => ({ ...prev, status: 'killed' as SessionStatus }));
    onBack();
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

  const handleResumeAgent = async () => {
    setResuming(true);
    try {
      const updated = await api.resumeAgentSession(currentSession.id);
      setCurrentSession(updated);
      onSessionUpdate(updated);
    } catch (err: any) {
      console.error('Resume failed:', err);
      alert(`Resume failed: ${err.message}`);
    } finally {
      setResuming(false);
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
  const isStopped = currentSession.status === 'stopped';
  const isCrashed = currentSession.status === 'crashed';
  // If crashed but tmux session still exists, we can still attach and show the terminal
  // The user can see the shell prompt and resume from there
  const isCrashedButAttachable = isCrashed; // server keeps tmux session alive on crash

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
          {isCrashedButAttachable && !restarting && (
            <>
              {currentSession.agentSessionId && (
                <button className="btn btn-primary btn-sm" onClick={handleResumeAgent} disabled={resuming}>
                  {resuming ? 'Resuming...' : '🔄 Resume Agent'}
                </button>
              )}
              <button className="btn btn-secondary btn-sm" onClick={handleRestart} disabled={restarting}>
                Restart
              </button>
            </>
          )}
          {isStopped && !restarting && (
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
              Session Stopped
            </div>
            {currentSession.exitCode !== null && currentSession.exitCode !== undefined && (
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
            position: 'absolute', bottom: 0, left: 0, right: 0,
            background: 'rgba(239, 68, 68, 0.15)', borderTop: '1px solid rgba(239, 68, 68, 0.3)',
            padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            zIndex: 10,
          }}>
            <div>
              <span style={{ color: '#ef4444', fontWeight: 600 }}>⚠ Agent crashed</span>
              {(currentSession as any).crashCount > 0 && (
                <span style={{ color: '#f97316', marginLeft: 8, fontSize: 12 }}> {(currentSession as any).crashCount}x crashes</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {currentSession.agentSessionId && (
                <button className="btn btn-primary btn-sm" onClick={handleResumeAgent} disabled={resuming}>
                  {resuming ? 'Resuming...' : '🔄 Resume'}
                </button>
              )}
              <button className="btn btn-secondary btn-sm" onClick={handleRestart} disabled={restarting}>
                Restart
              </button>
            </div>
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
    { label: '⇧ Enter', data: '\x1b[13;2u', title: 'Shift+Enter — new line without submitting',  group: 'enter' },
    { label: 'Enter', data: '\r', title: 'Enter — submit command / newline',             group: 'enter' },
  ];

  return (
    <div className="mobile-keybar">
      {keys.map((k) => (
        <button
          key={k.label}
          className={`btn key-${k.group || 'default'}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onKey(k.data)}
          title={k.title}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}