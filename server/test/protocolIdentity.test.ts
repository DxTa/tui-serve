import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientMessageSchema } from '@tui-serve/shared';

test('auth accepts tab client identity', () => {
  const parsed = clientMessageSchema.safeParse({
    v: 1,
    type: 'auth',
    token: 'secret',
    clientId: 'tab-1',
    clientName: 'Laptop tab',
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.type, 'auth');
    assert.equal(parsed.data.clientId, 'tab-1');
  }
});

test('attach accepts collaboration mode and requested capabilities', () => {
  const parsed = clientMessageSchema.safeParse({
    v: 1,
    type: 'attach',
    sessionId: 'session-a',
    mode: 'viewer',
    requestedCapabilities: ['view'],
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.type, 'attach');
    assert.equal(parsed.data.mode, 'viewer');
    assert.deepEqual(parsed.data.requestedCapabilities, ['view']);
  }
});

test('attach rejects unknown participant capabilities', () => {
  const parsed = clientMessageSchema.safeParse({
    v: 1,
    type: 'attach',
    sessionId: 'session-a',
    mode: 'controller',
    requestedCapabilities: ['view', 'sudo'],
  });

  assert.equal(parsed.success, false);
});
