// Auth token management

const AUTH_TOKEN_KEY = 'remote-agent-tui-token';
const AUTH_REQUIRED_KEY = 'remote-agent-tui-auth-required';

export function getAuthToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

export function hasAuthToken(): boolean {
  return !!getAuthToken();
}

// Track whether the server requires auth (learned from /api/health)
export function setAuthRequired(required: boolean): void {
  localStorage.setItem(AUTH_REQUIRED_KEY, required ? 'true' : 'false');
}

export function isAuthRequired(): boolean {
  return localStorage.getItem(AUTH_REQUIRED_KEY) === 'true';
}