// Authentication middleware for Fastify
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from './config.js';

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // Skip auth for health endpoint
  if (request.url === '/api/health' && request.method === 'GET') {
    return;
  }

  // If no auth token is configured, skip authentication entirely.
  // This is intentional for trusted/private networks (Tailscale, LAN, localhost).
  // Set AUTH_TOKEN in env to enforce authentication.
  if (!config.authRequired) {
    return;
  }

  // Serve static assets (SPA shell) without auth so the browser can load
  // the login form. API endpoints and WebSocket connections still require auth.
  if (
    request.method === 'GET' &&
    !request.url.startsWith('/api/') &&
    !request.url.startsWith('/ws')
  ) {
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'AUTH_REQUIRED', message: 'Authorization header required' });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== config.authToken) {
    reply.code(401).send({ error: 'AUTH_REQUIRED', message: 'Invalid auth token' });
    return;
  }
}

// WebSocket auth — called on upgrade or first message
export function authenticateWs(token: string | undefined): boolean {
  // If no auth token is configured, accept all connections
  if (!config.authRequired) {
    return true;
  }

  if (!token) return false;
  return token === config.authToken;
}