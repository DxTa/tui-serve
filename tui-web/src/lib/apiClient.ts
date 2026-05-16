// REST API client

import type { Session, Host, CommandInfo, HealthStatus } from './types';
import { getAuthToken } from './auth';

const BASE_URL = window.location.origin;

const REQUEST_TIMEOUT_MS = 15000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method || 'GET').toUpperCase();
  const attempts = method === 'GET' ? 3 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const token = getAuthToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string>),
    };
    // Only send auth header if a token is stored
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${BASE_URL}${path}`, { ...options, headers, signal: controller.signal });
      if (res.status === 401) throw new Error('Unauthorized');
      if (res.status === 204) return null as T;
      if (!res.ok) {
        if (attempt < attempts - 1 && RETRYABLE_STATUS.has(res.status)) {
          await sleep(250 * Math.pow(2, attempt) + Math.random() * 250);
          continue;
        }
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(body.message || body.error || `HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts - 1) throw err;
      await sleep(250 * Math.pow(2, attempt) + Math.random() * 250);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
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

  listDirectory(path: string): Promise<{ directories: string[] }> {
    return request(`/api/fs/ls?path=${encodeURIComponent(path)}`);
  },
};