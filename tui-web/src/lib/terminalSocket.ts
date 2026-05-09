// WebSocket client with full protocol support
// Binary (0x00) for terminal I/O, JSON (0x01) for control

import { PROTOCOL_VERSION, clientMessageSchema, serverMessageSchema, type ClientMessage, type ServerMessage } from '@tui-serve/shared';
import type { Session, SessionStatus, ConnectionState } from './types';
import { getAuthToken } from './auth';
const FRAME_BINARY = 0x00;
const FRAME_CONTROL = 0x01;

type OutputCallback = (sessionId: string, data: Uint8Array) => void;
type SnapshotCallback = (sessionId: string, data: string) => void;
type StatusCallback = (sessionId: string, status: SessionStatus, pid: number | null, exitCode: number | null) => void;
type SessionUpdateCallback = (session: Session) => void;
type ErrorCallback = (code: string, message: string) => void;
type ConnectionCallback = (state: ConnectionState) => void;
type AttachedCallback = (sessionId: string) => void;
type DetachedCallback = (sessionId: string) => void;
type KilledCallback = (sessionId: string) => void;
type DashboardUpdateCallback = (changedSessionIds?: string[]) => void;
type ParticipantUpdateCallback = (sessionId: string, participants: Array<{ id: string; clientId: string | null; capabilities: string[] }>) => void;

function getTabClientId(): string {
  const key = 'tui-serve-client-id';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const generated = crypto.randomUUID();
    sessionStorage.setItem(key, generated);
    return generated;
  } catch {
    return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export class TerminalSocket {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private hostUrl = '';
  private token = '';
  private _connectionState: ConnectionState = 'disconnected';
  private pendingAttach: string | null = null; // session to attach once connected
  private desiredSessionId: string | null = null;
  private attachedSessions = new Set<string>();
  private intentionallyClosed = false;
  private socketGeneration = 0;
  private clientId = getTabClientId();
  private readonly encoder = new TextEncoder();
  private inputFramePrefixSessionId = '';
  private inputFramePrefix: Uint8Array | null = null;
  private readonly perfEnabled = (() => {
    try {
      return new URLSearchParams(window.location.search).has('perf');
    } catch {
      return false;
    }
  })();

  // Callbacks
  onOutput: OutputCallback = () => {};
  onSnapshot: SnapshotCallback = () => {};
  onStatus: StatusCallback = () => {};
  onSessionUpdate: SessionUpdateCallback = () => {};
  onError: ErrorCallback = () => {};
  onConnectionChange: ConnectionCallback = () => {};
  onAttached: AttachedCallback = () => {};
  onDetached: DetachedCallback = () => {};
  onKilled: KilledCallback = () => {};
  onDashboardUpdate: DashboardUpdateCallback = () => {};
  onParticipantUpdate: ParticipantUpdateCallback = () => {};

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  private setConnectionState(state: ConnectionState) {
    if (this._connectionState !== state) {
      this._connectionState = state;
      this.onConnectionChange(state);
    }
  }

  connect(hostUrl: string, token?: string): void {
    // Defensive normalization: a "localhost" backend URL from bundled config
    // means "same origin as the loaded app", not the browser device itself.
    // This matters for phones/tablets accessing the server via LAN/Tailscale.
    const normalizedHostUrl = (() => {
      try {
        const url = new URL(hostUrl);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
          return window.location.origin;
        }
      } catch {
        // Keep original value if parsing fails; WebSocket will surface error.
      }
      return hostUrl;
    })();

    this.hostUrl = normalizedHostUrl;
    this.token = token || getAuthToken() || '';
    this.intentionallyClosed = false;

    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    if (this.ws) {
      this.ws.close(1000, 'Replacing stale socket');
      this.ws = null;
    }

    const wsUrl = normalizedHostUrl
      .replace(/^https/, 'wss')
      .replace(/^http/, 'ws');

    const url = `${wsUrl}/ws`;

    this.setConnectionState('reconnecting');

    try {
      const generation = ++this.socketGeneration;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (generation !== this.socketGeneration || this.ws !== ws) return;
        this.sendControl({ v: PROTOCOL_VERSION, type: 'auth', token: this.token, clientId: this.clientId });
        this.setConnectionState('connected');
        this.reconnectDelay = 1000;
        this.startHeartbeat();

        // Send pending attach if one was queued, or restore the desired
        // attachment after reconnecting a dropped socket.
        const sessionToAttach = this.pendingAttach || this.desiredSessionId;
        if (sessionToAttach) {
          this.doAttach(sessionToAttach);
          this.pendingAttach = null;
        }
      };

      ws.onmessage = (event) => {
        if (generation !== this.socketGeneration || this.ws !== ws) return;
        this.handleMessage(event);
      };

      ws.onclose = () => {
        if (generation !== this.socketGeneration || this.ws !== ws) return;
        this.ws = null;
        this.attachedSessions.clear();
        this.setConnectionState('disconnected');
        this.stopHeartbeat();
        if (!this.intentionallyClosed) this.scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    } catch (err) {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.pendingAttach = null;
    this.desiredSessionId = null;
    this.attachedSessions.clear();
    this.intentionallyClosed = true;
    this.socketGeneration++;
    this.stopHeartbeat();
    this.clearReconnect();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.setConnectionState('disconnected');
  }

  attach(sessionId: string): void {
    this.desiredSessionId = sessionId;
    // If not yet connected, queue the attach for when connection opens
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAttach = sessionId;
      return;
    }
    this.doAttach(sessionId);
  }

  subscribeDashboard(): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'subscribe_dashboard' });
  }

  unsubscribeDashboard(): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'unsubscribe_dashboard' });
  }

  subscribeSession(sessionId: string): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'subscribe_session', sessionId });
  }

  unsubscribeSession(sessionId: string): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'unsubscribe_session', sessionId });
  }

  private doAttach(sessionId: string): void {
    this.subscribeSession(sessionId);
    this.sendControl({ v: PROTOCOL_VERSION, type: 'attach', sessionId, mode: 'auto' });
  }

  sendInput(sessionId: string, data: string): void {
    // Hot path — use binary framing to bypass per-keystroke JSON serialization,
    // Zod validation, and repeated session-id encoding. Frame format:
    // [0x00] [1-byte sessionId length] [sessionId UTF-8] [raw terminal data]
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (!this.inputFramePrefix || this.inputFramePrefixSessionId !== sessionId) {
      const sessionIdBytes = this.encoder.encode(sessionId);
      if (sessionIdBytes.length > 255) return;
      const prefix = new Uint8Array(2 + sessionIdBytes.length);
      prefix[0] = FRAME_BINARY;
      prefix[1] = sessionIdBytes.length;
      prefix.set(sessionIdBytes, 2);
      this.inputFramePrefix = prefix;
      this.inputFramePrefixSessionId = sessionId;
    }

    const start = this.perfEnabled ? performance.now() : 0;
    const dataBytes = this.encodeTerminalInput(data);
    const frame = new Uint8Array(this.inputFramePrefix.length + dataBytes.length);
    frame.set(this.inputFramePrefix);
    frame.set(dataBytes, this.inputFramePrefix.length);
    this.ws.send(frame);

    if (this.perfEnabled) {
      const perf = ((window as any).__terminalPerf ||= { inputFrames: 0, inputBytes: 0, inputEncodeMs: 0 });
      perf.inputFrames += 1;
      perf.inputBytes += dataBytes.length;
      perf.inputEncodeMs += performance.now() - start;
    }
  }

  private encodeTerminalInput(data: string): Uint8Array {
    // Common typing path: single printable/control ASCII char.
    // Avoid TextEncoder overhead for the frequent one-char case.
    if (data.length === 1) {
      const code = data.charCodeAt(0);
      if (code <= 0x7f) return Uint8Array.of(code);
    }

    // Fast path for short all-ASCII sequences (arrows, escape sequences,
    // paste chunks without unicode). Falls back to TextEncoder for UTF-8.
    let ascii = true;
    for (let i = 0; i < data.length; i++) {
      if (data.charCodeAt(i) > 0x7f) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i);
      return out;
    }

    return this.encoder.encode(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (!this.attachedSessions.has(sessionId)) return;
    this.sendControl({ v: PROTOCOL_VERSION, type: 'resize', sessionId, cols, rows });
  }

  detach(sessionId: string): void {
    if (this.desiredSessionId === sessionId) this.desiredSessionId = null;
    if (this.pendingAttach === sessionId) this.pendingAttach = null;
    this.attachedSessions.delete(sessionId);
    this.unsubscribeSession(sessionId);
    this.sendControl({ v: PROTOCOL_VERSION, type: 'detach', sessionId });
  }

  kill(sessionId: string): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'kill', sessionId, confirm: true });
  }

  restart(sessionId: string): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'restart', sessionId });
  }

  // ── Internal ──

  private sendControl(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const parsed = clientMessageSchema.safeParse(msg);
      if (!parsed.success) {
        console.error('Invalid client WebSocket message', parsed.error);
        return;
      }
      const prefix = new Uint8Array([FRAME_CONTROL]);
      const json = new TextEncoder().encode(JSON.stringify(msg));
      const combined = new Uint8Array(prefix.length + json.length);
      combined.set(prefix);
      combined.set(json, prefix.length);
      this.ws.send(combined);
    }
  }

  private handleMessage(event: MessageEvent): void {
    const data = event.data;

    if (data instanceof ArrayBuffer) {
      this.handleBinaryFrame(new Uint8Array(data));
    } else if (typeof data === 'string') {
      // Fallback: plain JSON (for dev or servers that don't use binary prefix)
      try {
        const msg = JSON.parse(data);
        const parsed = serverMessageSchema.safeParse(msg);
        if (parsed.success) this.handleControlMessage(parsed.data);
      } catch {}
    }
  }

  private handleBinaryFrame(buf: Uint8Array): void {
    if (buf.length < 3) return;

    if (buf[0] === FRAME_BINARY) {
      // Binary terminal output
      const sessionIdLen = buf[1];
      if (buf.length < 2 + sessionIdLen) return;
      const sessionId = new TextDecoder().decode(buf.subarray(2, 2 + sessionIdLen));
      const outputData = buf.subarray(2 + sessionIdLen);
      this.onOutput(sessionId, outputData);
    } else if (buf[0] === FRAME_CONTROL) {
      // JSON control message with binary prefix
      try {
        const json = new TextDecoder().decode(buf.subarray(1));
        const msg = JSON.parse(json);
        const parsed = serverMessageSchema.safeParse(msg);
        if (parsed.success) this.handleControlMessage(parsed.data);
      } catch {}
    }
  }

  private handleControlMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'pong':
        break;
      case 'attached':
        this.attachedSessions.add(msg.sessionId);
        this.onAttached(msg.sessionId);
        break;
      case 'snapshot':
        this.onSnapshot(msg.sessionId, msg.data);
        break;
      case 'status':
        this.onStatus(msg.sessionId, msg.status, msg.pid, msg.exitCode);
        break;
      case 'session_update':
        this.onSessionUpdate(msg as unknown as Session);
        break;
      case 'error':
        this.onError(msg.code, msg.message);
        break;
      case 'kill_ack':
        this.onKilled(msg.sessionId);
        break;
      case 'detach_ack':
        this.attachedSessions.delete(msg.sessionId);
        this.onDetached(msg.sessionId);
        break;
      case 'dashboard_update':
        this.onDashboardUpdate(msg.changedSessionIds);
        break;
      case 'participant_update':
        this.onParticipantUpdate(msg.sessionId, msg.participants);
        break;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendControl({ v: PROTOCOL_VERSION, type: 'ping' });
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    this.clearReconnect();
    this.setConnectionState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.connect(this.hostUrl, this.token);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }, this.reconnectDelay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelay = 1000;
  }
}