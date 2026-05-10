import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import WebSocket from 'ws';
import { serverMessageSchema } from '@tui-serve/shared';
import { FRAME_CONTROL, PROTOCOL_VERSION } from '../src/protocol.ts';

function clientControl(message: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from([FRAME_CONTROL]), Buffer.from(JSON.stringify(message), 'utf-8')]);
}

async function startServer() {
  process.env.AUTH_TOKEN = '0123456789abcdef0123456789abcdef';
  const app = Fastify();
  const { setupWebSocket } = await import('../src/ws.ts');
  const wss = setupWebSocket(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.equal(typeof address, 'object');
  assert.ok(address);
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      wss.close();
      await app.close();
    },
  };
}

test('WebSocket ignores query token and requires auth frame', async () => {
  const server = await startServer();
  try {
    const ws = new WebSocket(`${server.url}/ws?token=0123456789abcdef0123456789abcdef`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(clientControl({ v: PROTOCOL_VERSION, type: 'ping' }));
      });
      ws.once('close', (code) => resolve(code));
      ws.once('error', reject);
    });
    assert.equal(closeCode, 4001);
  } finally {
    await server.close();
  }
});

test('WebSocket accepts first-message auth frame', async () => {
  const server = await startServer();
  try {
    const ws = new WebSocket(`${server.url}/ws`);
    const pong = await new Promise<any>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(clientControl({ v: PROTOCOL_VERSION, type: 'auth', token: '0123456789abcdef0123456789abcdef', clientId: 'test-client' }));
        ws.send(clientControl({ v: PROTOCOL_VERSION, type: 'ping', requestId: 'r1' }));
      });
      ws.on('message', (raw) => {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        if (buf[0] !== FRAME_CONTROL) return;
        const parsed = serverMessageSchema.safeParse(JSON.parse(buf.subarray(1).toString('utf-8')));
        if (parsed.success && parsed.data.type === 'pong') resolve(parsed.data);
      });
      ws.once('close', (code) => reject(new Error(`closed before pong: ${code}`)));
      ws.once('error', reject);
    });
    assert.equal(pong.type, 'pong');
    assert.equal(pong.requestId, 'r1');
    ws.close();
  } finally {
    await server.close();
  }
});
