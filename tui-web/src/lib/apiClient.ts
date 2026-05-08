// REST API client

import type { Session, Host, CommandInfo, HealthStatus } from './types';
import { getAuthToken } from './auth';

const BASE_URL = window.location.origin;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };
  // Only send auth header if a token is stored
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (res.status === 401) throw new Error('Unauthorized');
  if (res.status === 204) return null as T;
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message || body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  health(): Promise<HealthStatus> {
    return request('/api/health');
  },

  listSessions(): Promise<Session[]> {
    return request('/api/sessions');
  },

  getSession(id: string): Promise<Session> {
    return request(`/api/sessions/${id}`);
  },

  createSession(opts: { id?: string; title?: string; commandId: string; cwd: string; resumeFrom?: string }): Promise<Session> {
    return request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(opts),
    });
  },

  updateSession(id: string, opts: { title?: string; restartPolicy?: string }): Promise<Session> {
    return request(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(opts),
    });
  },

  killSession(id: string): Promise<Session> {
    return request(`/api/sessions/${id}/kill`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
  },

  restartSession(id: string): Promise<Session> {
    return request(`/api/sessions/${id}/restart`, {
      method: 'POST',
    });
  },

  resumeAgentSession(id: string): Promise<Session> {
    return request(`/api/sessions/${id}/resume`, {
      method: 'POST',
    });
  },

  deleteSession(id: string): Promise<void> {
    return request(`/api/sessions/${id}`, { method: 'DELETE' });
  },

  listHosts(): Promise<Host[]> {
    return request('/api/hosts');
  },

  listCommands(): Promise<CommandInfo[]> {
    return request('/api/commands');
  },
};