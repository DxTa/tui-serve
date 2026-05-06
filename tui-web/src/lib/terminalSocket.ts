// WebSocket client with full protocol support
// Binary (0x00) for terminal I/O, JSON (0x01) for control

import type { Session, SessionStatus, ConnectionState } from './types';
import { getAuthToken } from './auth';

const PROTOCOL_VERSION = 1;
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
    this.hostUrl = hostUrl;
    this.token = token || getAuthToken() || '';

    const wsUrl = hostUrl
      .replace(/^http/, 'ws')
      .replace(/^https/, 'wss');

    const url = `${wsUrl}/ws?token=${encodeURIComponent(this.token)}`;

    this.setConnectionState('reconnecting');

    try {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.setConnectionState('connected');
        this.reconnectDelay = 1000;
        this.startHeartbeat();

        // Send pending attach if one was queued
        if (this.pendingAttach) {
          this.doAttach(this.pendingAttach);
          this.pendingAttach = null;
        }
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event);
      };

      this.ws.onclose = () => {
        this.setConnectionState('disconnected');
        this.stopHeartbeat();
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };
    } catch (err) {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.pendingAttach = null;
    this.stopHeartbeat();
    this.clearReconnect();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.setConnectionState('disconnected');
  }

  attach(sessionId: string): void {
    // If not yet connected, queue the attach for when connection opens
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAttach = sessionId;
      return;
    }
    this.doAttach(sessionId);
  }

  private doAttach(sessionId: string): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'attach', sessionId });
  }

  sendInput(sessionId: string, data: string): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'input', sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'resize', sessionId, cols, rows });
  }

  detach(sessionId: string): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'detach', sessionId });
  }

  kill(sessionId: string): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'kill', sessionId, confirm: true });
  }

  restart(sessionId: string): void {
    this.sendControl({ v: PROTOCOL_VERSION, type: 'restart', sessionId });
  }

  // ── Internal ──

  private sendControl(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
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
        this.handleControlMessage(msg);
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
        this.handleControlMessage(msg);
      } catch {}
    }
  }

  private handleControlMessage(msg: Record<string, any>): void {
    switch (msg.type) {
      case 'pong':
        break;
      case 'attached':
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
        this.onDetached(msg.sessionId);
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