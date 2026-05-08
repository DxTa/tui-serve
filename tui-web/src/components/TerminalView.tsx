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
  const scrollProxyRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const proxySyncingFromTermRef = useRef(false);
  const proxySyncingFromProxyRef = useRef(false);
  const proxyPointerStartYRef = useRef<number | null>(null);
  const [isMobileTerminal, setIsMobileTerminal] = useState(false);

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
    const update = () => setIsMobileTerminal(isTouchDevice());
    update();
    const media = window.matchMedia('(pointer: coarse)');
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  const getMobileScrollMaxLine = useCallback(() => {
    const term = terminalRef.current;
    return Math.max(0, term?.buffer.active.baseY || 0);
  }, []);

  const lineToProxyTop = useCallback((line: number) => {
    const proxy = scrollProxyRef.current;
    const content = scrollContentRef.current;
    const maxLine = getMobileScrollMaxLine();
    if (!proxy || !content || maxLine <= 0) return 0;
    const maxTop = Math.max(0, content.scrollHeight - proxy.clientHeight);
    return Math.round((Math.max(0, Math.min(maxLine, line)) / maxLine) * maxTop);
  }, [getMobileScrollMaxLine]);

  const proxyTopToLine = useCallback((scrollTop: number) => {
    const proxy = scrollProxyRef.current;
    const content = scrollContentRef.current;
    const maxLine = getMobileScrollMaxLine();
    if (!proxy || !content || maxLine <= 0) return 0;
    const maxTop = Math.max(1, content.scrollHeight - proxy.clientHeight);
    return Math.round((Math.max(0, Math.min(maxTop, scrollTop)) / maxTop) * maxLine);
  }, [getMobileScrollMaxLine]);

  const syncMobileScrollProxyToTerm = useCallback(() => {
    const term = terminalRef.current;
    const proxy = scrollProxyRef.current;
    if (!term || !proxy || proxySyncingFromProxyRef.current) return;

    proxySyncingFromTermRef.current = true;
    proxy.scrollTop = lineToProxyTop(term.buffer.active.viewportY);
    requestAnimationFrame(() => {
      proxySyncingFromTermRef.current = false;
    });
  }, [lineToProxyTop]);

  useEffect(() => {
    const previousSessionId = attachedSessionIdRef.current;
    currentSessionIdRef.current = session.id;

    if (previousSessionId === session.id) return;

    socketRef.current?.detach(previousSessionId);
    terminalRef.current?.clear();
    socketRef.current?.attach(session.id);
    attachedSessionIdRef.current = session.id;
    if (!isTouchDevice()) terminalRef.current?.focus();
    scheduleFitAndResize(0);
  }, [session.id, scheduleFitAndResize]);

  // Initialize terminal + socket
  useEffect(() => {
    if (!termRef.current) return;

    let disposed = false;

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
    if (isTouchDevice()) suppressMobileTerminalInput(termRef.current);

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

    if (!isTouchDevice()) term.focus();

    // Wait for font to load before fitting — prevents spacing issues
    document.fonts.ready.then(() => {
      if (disposed) return;
      fitAndResize();
      requestAnimationFrame(() => {
        if (disposed) return;
        fitAndResize();
        if (!isTouchDevice()) term.focus();
        else suppressMobileTerminalInput(termRef.current);
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
      term.write(merged, () => requestAnimationFrame(syncMobileScrollProxyToTerm));
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
      term.write(data, () => requestAnimationFrame(syncMobileScrollProxyToTerm));
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

    const scrollData = term.onScroll(() => {
      syncMobileScrollProxyToTerm();
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
      disposed = true;
      inputData.dispose();
      scrollData.dispose();
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
      socketRef.current = null;
      fitAddonRef.current = null;
      terminalRef.current = null;
      try {
        term.dispose();
      } catch (error) {
        // xterm WebGL renderer can throw during teardown after route changes
        // if its internal atlas was already disposed. Cleanup must never crash
        // React navigation; resources are being released as part of unmount.
        console.warn('Terminal disposal failed during unmount:', error);
      }
    };
  }, [fitAndResize, scheduleFitAndResize, hostUrl, syncMobileScrollProxyToTerm]);

  // Keep mobile scroll proxy aligned after it mounts or viewport size changes.
  useEffect(() => {
    if (!isMobileTerminal) return;
    const frame = requestAnimationFrame(syncMobileScrollProxyToTerm);
    return () => cancelAnimationFrame(frame);
  }, [isMobileTerminal, visualViewportHeight, fontSize, syncMobileScrollProxyToTerm]);

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
    const shouldRestoreTerminalFocus = isSoftKeyboardOpen();
    setFontSize((size) => Math.max(8, Math.min(24, size + delta)));
    requestAnimationFrame(() => {
      fitAndResize();
      if (shouldRestoreTerminalFocus) terminalRef.current?.focus();
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

  const getTerminalTextarea = (root: ParentNode | null = document) =>
    root?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea') || null;

  const suppressMobileTerminalInput = (root: ParentNode | null = document) => {
    const textarea = getTerminalTextarea(root);
    if (!textarea) return;
    textarea.inputMode = 'none';
    textarea.blur();
  };

  const allowMobileTerminalInput = (root: ParentNode | null = document) => {
    const textarea = getTerminalTextarea(root);
    if (!textarea) return;
    textarea.inputMode = 'text';
  };

  const blurTerminalIfKeyboardClosed = () => {
    // Android Chrome can reopen the soft keyboard when a touch/click happens
    // while xterm's hidden textarea remains focused. If keyboard is already
    // closed, blur that textarea before handling toolbar controls.
    if (isSoftKeyboardOpen()) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.classList.contains('xterm-helper-textarea')) {
      active.blur();
      if (isTouchDevice()) active.setAttribute('inputmode', 'none');
    }
  };

  const preventButtonFocus = (event: React.MouseEvent<HTMLButtonElement> | React.PointerEvent<HTMLButtonElement>) => {
    blurTerminalIfKeyboardClosed();
    // Mobile Chrome: prevent button focus transfer on pointer down. Actions run
    // from pointerup instead of click to avoid Android synthetic-click focus quirks.
    event.preventDefault();
  };

  const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

  const isSoftKeyboardOpen = () => {
    if (!window.visualViewport) return false;
    return window.innerHeight - window.visualViewport.height > 120;
  };

  const toggleMobileKeyboard = () => {
    const term = terminalRef.current;
    if (!term) return;
    const textarea = getTerminalTextarea();
    if (!textarea) return;

    if (document.activeElement === textarea && isSoftKeyboardOpen()) {
      // Keyboard is visible: dismiss it
      textarea.setAttribute('inputmode', 'none');
      textarea.blur();
    } else {
      // Keyboard is hidden: show it
      textarea.setAttribute('inputmode', 'text');
      term.focus();
    }
  };

  const handleKill = async () => {
    try {
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
    } catch (err) {
      console.error('Kill failed:', err);
      // Even if the server kill fails, still mark locally and navigate back
      try {
        const existing = await db.sessions.get(currentSession.id);
        if (existing) {
          await db.sessions.update(currentSession.id, {
            status: 'disconnected',
            isTombstone: true,
            attachedClients: 0,
            lastServerSync: new Date().toISOString(),
          });
        }
      } catch (dbErr) {
        console.error('Failed to update local session state:', dbErr);
      }
    } finally {
      setShowKillConfirm(false);
      // Navigate back immediately — don't show "killed" overlay
      // which blocks the user from returning to the dashboard.
      onBack();
    }
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

  const scrollTerminal = (amount: 'wheelUp' | 'wheelDown') => {
    blurTerminalIfKeyboardClosed();

    // Agent TUIs use the alternate screen, so xterm scrollback APIs
    // don't move the app viewport. Send mouse wheel SGR input instead.
    const dataByAction: Record<typeof amount, string> = {
      wheelUp: '\x1b[<64;10;10M',
      wheelDown: '\x1b[<65;10;10M',
    };

    socketRef.current?.sendInput(currentSessionIdRef.current, dataByAction[amount]);
  };

  const handleMobileProxyScroll = () => {
    const term = terminalRef.current;
    const proxy = scrollProxyRef.current;
    if (!term || !proxy || proxySyncingFromTermRef.current) return;

    proxySyncingFromProxyRef.current = true;
    term.scrollToLine(proxyTopToLine(proxy.scrollTop));
    requestAnimationFrame(() => {
      proxySyncingFromProxyRef.current = false;
    });
  };

  const handleMobileProxyPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return;
    proxyPointerStartYRef.current = event.clientY;
    blurTerminalIfKeyboardClosed();
  };

  const handleMobileProxyPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || proxyPointerStartYRef.current === null) return;
    const movement = Math.abs(event.clientY - proxyPointerStartYRef.current);
    proxyPointerStartYRef.current = null;
    if (movement > 8) return;

    allowMobileTerminalInput(termRef.current);
    terminalRef.current?.focus();
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
          <button type="button" tabIndex={-1} className="btn btn-ghost btn-sm" onPointerDown={preventButtonFocus} onMouseDown={preventButtonFocus} onPointerUp={() => changeFontSize(2)}>A+</button>
          <button type="button" tabIndex={-1} className="btn btn-ghost btn-sm" onPointerDown={preventButtonFocus} onMouseDown={preventButtonFocus} onPointerUp={() => changeFontSize(-2)}>A-</button>
        </div>
      </div>

      {/* Terminal */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
        <div className="terminal-container" ref={termRef} />
        {isMobileTerminal && isRunning && (
          <div
            ref={scrollProxyRef}
            className="mobile-scroll-proxy"
            onScroll={handleMobileProxyScroll}
            onPointerDown={handleMobileProxyPointerDown}
            onPointerUp={handleMobileProxyPointerUp}
            onPointerCancel={() => { proxyPointerStartYRef.current = null; }}
          >
            <div ref={scrollContentRef} className="mobile-scroll-content" />
          </div>
        )}
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
      <MobileKeyBar onKey={sendKey} onScroll={scrollTerminal} showScrollControls={isMobileTerminal} onToggleKeyboard={toggleMobileKeyboard} />

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

function MobileKeyBar({
  onKey,
  onScroll,
  showScrollControls,
  onToggleKeyboard,
}: {
  onKey: (data: string) => void;
  onScroll: (amount: 'wheelUp' | 'wheelDown') => void;
  showScrollControls: boolean;
  onToggleKeyboard: () => void;
}) {
  const controlKeys: Array<{ label: string; data: string; title: string; group?: string }> = [
    { label: 'Esc',  data: '\x1b',   title: 'Escape — cancel current input or action', group: 'ctrl' },
    { label: 'Tab',  data: '\t',     title: 'Tab — autocomplete or next field', group: 'ctrl' },
  ];

  const arrowKeys: Array<{ label: string; data: string; title: string; group?: string }> = [
    { label: '↑', data: '\x1b[A', title: 'Arrow Up — previous command / move up', group: 'arrow' },
    { label: '↓', data: '\x1b[B', title: 'Arrow Down — next command / move down', group: 'arrow' },
    { label: '←', data: '\x1b[D', title: 'Arrow Left — move cursor left', group: 'arrow' },
    { label: '→', data: '\x1b[C', title: 'Arrow Right — move cursor right', group: 'arrow' },
  ];

  const charKeys: Array<{ label: string; data: string; title: string; group?: string }> = [
    { label: '/', data: '/', title: 'Slash — start Pi command (e.g., /help)', group: 'char' },
    { label: '~', data: '~', title: 'Tilde — home directory shortcut (~/)', group: 'char' },
    { label: '|', data: '|', title: 'Pipe — chain commands (cmd1 | cmd2)', group: 'char' },
  ];

  const enterKeys: Array<{ label: string; data: string; title: string; group?: string }> = [
    { label: '⇧ Enter', data: '\x1b[13;2u', title: 'Shift+Enter — new line without submitting', group: 'enter' },
    { label: 'Enter', data: '\r', title: 'Enter — submit command / newline', group: 'enter' },
  ];

  const scrollButtons: Array<{ label: string; action: 'wheelUp' | 'wheelDown'; title: string }> = [
    { label: '▲', action: 'wheelUp', title: 'Scroll up (mouse wheel up)' },
    { label: '▼', action: 'wheelDown', title: 'Scroll down (mouse wheel down)' },
  ];

  const preventMobileButtonFocus = (event: React.PointerEvent<HTMLButtonElement>) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.classList.contains('xterm-helper-textarea')) {
      const viewport = window.visualViewport;
      if (!viewport || window.innerHeight - viewport.height <= 120) active.blur();
    }
    event.preventDefault();
  };

  const renderKeyButton = (k: { label: string; data: string; title: string; group?: string }) => (
    <button
      key={k.label}
      type="button"
      tabIndex={-1}
      className={`btn key-${k.group || 'default'}`}
      onPointerDown={preventMobileButtonFocus}
      onMouseDown={(e) => e.preventDefault()}
      onPointerUp={() => onKey(k.data)}
      title={k.title}
    >
      {k.label}
    </button>
  );

  return (
    <div className="mobile-keybar">
      {showScrollControls && (
        <div className="mobile-keybar-group mobile-keybar-scroll" aria-label="Scroll controls">
          {scrollButtons.map((button) => (
            <button
              key={button.action}
              type="button"
              tabIndex={-1}
              className="btn key-scroll"
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onPointerUp={() => onScroll(button.action)}
              title={button.title}
            >
              {button.label}
            </button>
          ))}
        </div>
      )}
      <div className="mobile-keybar-group mobile-keyboard-toggle" aria-label="Keyboard toggle">
        <button
          type="button"
          tabIndex={-1}
          className="btn key-keyboard"
          onPointerDown={preventMobileButtonFocus}
          onMouseDown={(e) => e.preventDefault()}
          onPointerUp={() => onToggleKeyboard()}
          title="Toggle on-screen keyboard"
        >
          ⌨
        </button>
      </div>
      <div className="mobile-keybar-group mobile-keybar-control" aria-label="Control keys">
        {controlKeys.map(renderKeyButton)}
      </div>
      <div className="mobile-keybar-group mobile-keybar-arrows" aria-label="Arrow keys">
        {arrowKeys.map(renderKeyButton)}
      </div>
      <div className="mobile-keybar-group mobile-keybar-chars" aria-label="Common characters">
        {charKeys.map(renderKeyButton)}
      </div>
      <div className="mobile-keybar-group mobile-keybar-enter" aria-label="Enter keys">
        {enterKeys.map(renderKeyButton)}
      </div>
    </div>
  );
}