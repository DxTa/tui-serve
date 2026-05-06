// Authentication middleware for Fastify
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from './config.js';

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // Skip auth for health endpoint (optional, remove if you want auth there too)
  if (request.url === '/api/health' && request.method === 'GET') {
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
  if (!token) return false;
  return token === config.authToken;
}