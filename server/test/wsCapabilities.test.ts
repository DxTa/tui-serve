import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorCodeSchema } from '@tui-serve/shared';
import { ErrorCode } from '../src/protocol.ts';
import { resolveCapabilities } from '../src/ws.ts';

test('shared protocol accepts capability-required errors', () => {
  assert.equal(errorCodeSchema.safeParse('CAPABILITY_REQUIRED').success, true);
  assert.equal(ErrorCode.CAPABILITY_REQUIRED, 'CAPABILITY_REQUIRED');
});

test('auto attach does not grant lifecycle capabilities', () => {
  const capabilities = resolveCapabilities('auto', ['kill', 'restart', 'edit_metadata']);
  assert.equal(capabilities.has('view'), true);
  assert.equal(capabilities.has('input'), true);
  assert.equal(capabilities.has('kill'), false);
  assert.equal(capabilities.has('restart'), false);
  assert.equal(capabilities.has('edit_metadata'), false);
});

test('controller attach can request lifecycle capabilities', () => {
  const capabilities = resolveCapabilities('controller', ['kill', 'restart', 'edit_metadata']);
  assert.equal(capabilities.has('kill'), true);
  assert.equal(capabilities.has('restart'), true);
  assert.equal(capabilities.has('edit_metadata'), true);
});
