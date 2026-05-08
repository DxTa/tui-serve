import { isIP } from 'node:net';

const WEAK_TOKENS = new Set([
  'password',
  'password123',
  'changeme',
  'change-me',
  'secret',
  'token',
  'auth_token',
  'tui-serve',
  '123456',
  '123456789',
]);

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost') return true;
  if (normalized === '::1') return true;
  if (normalized.startsWith('127.')) return true;

  // IPv4-mapped loopback, e.g. ::ffff:127.0.0.1
  if (normalized.startsWith('::ffff:127.')) return true;

  return false;
}

export function isNetworkBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '*') return true;
  if (isLoopbackBindHost(normalized)) return false;

  // Any explicit non-loopback IP is network-reachable for this safety check.
  if (isIP(normalized)) return true;

  // Unknown hostnames may resolve to non-loopback. Fail closed.
  return true;
}

export function isStrongAuthToken(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length < 32) return false;
  if (WEAK_TOKENS.has(trimmed.toLowerCase())) return false;
  if (/^(.)\1+$/.test(trimmed)) return false;
  if (/^(1234567890|0123456789)+$/.test(trimmed)) return false;
  return true;
}

export function assertSafeBindAuthConfig(input: {
  bindHost: string;
  authToken: string;
  nodeEnv?: string;
  insecureAllowNetworkNoAuthForTests?: boolean;
}): void {
  const networkBind = isNetworkBindHost(input.bindHost);
  if (!networkBind) return;

  if (input.authToken && isStrongAuthToken(input.authToken)) return;

  const testOverride = input.insecureAllowNetworkNoAuthForTests && input.nodeEnv !== 'production';
  if (testOverride) return;

  if (!input.authToken) {
    throw new Error(
      `Unsafe configuration: BIND_HOST=${input.bindHost} is network-reachable, but AUTH_TOKEN is empty. ` +
      'Set a strong AUTH_TOKEN (32+ chars) or bind to 127.0.0.1 for local-only mode.',
    );
  }

  throw new Error(
    `Unsafe configuration: BIND_HOST=${input.bindHost} is network-reachable, but AUTH_TOKEN is too weak. ` +
    'Use a generated random token with at least 32 characters.',
  );
}
