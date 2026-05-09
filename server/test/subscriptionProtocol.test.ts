import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientMessageSchema, serverMessageSchema } from '@tui-serve/shared';

test('client protocol accepts dashboard and session subscriptions', () => {
  assert.equal(clientMessageSchema.safeParse({ v: 1, type: 'subscribe_dashboard' }).success, true);
  assert.equal(clientMessageSchema.safeParse({ v: 1, type: 'unsubscribe_dashboard' }).success, true);
  assert.equal(clientMessageSchema.safeParse({ v: 1, type: 'subscribe_session', sessionId: 'session-a' }).success, true);
  assert.equal(clientMessageSchema.safeParse({ v: 1, type: 'unsubscribe_session', sessionId: 'session-a' }).success, true);
});

test('server protocol accepts dashboard and participant updates', () => {
  const dashboard = serverMessageSchema.safeParse({ v: 1, type: 'dashboard_update', changedSessionIds: ['session-a'] });
  assert.equal(dashboard.success, true);

  const participants = serverMessageSchema.safeParse({
    v: 1,
    type: 'participant_update',
    sessionId: 'session-a',
    participants: [{ id: 'participant-1', clientId: 'client-1', capabilities: ['view', 'input'] }],
  });
  assert.equal(participants.success, true);
});
