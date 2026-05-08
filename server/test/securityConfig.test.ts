import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSafeBindAuthConfig, isLoopbackBindHost, isNetworkBindHost, isStrongAuthToken } from '../src/securityConfig.ts';

const strongToken = '0123456789abcdef0123456789abcdef';

test('loopback bind hosts are recognized', () => {
  assert.equal(isLoopbackBindHost('127.0.0.1'), true);
  assert.equal(isLoopbackBindHost('127.10.20.30'), true);
  assert.equal(isLoopbackBindHost('localhost'), true);
  assert.equal(isLoopbackBindHost('::1'), true);
  assert.equal(isLoopbackBindHost('::ffff:127.0.0.1'), true);
});

test('network bind hosts are recognized', () => {
  assert.equal(isNetworkBindHost('0.0.0.0'), true);
  assert.equal(isNetworkBindHost('::'), true);
  assert.equal(isNetworkBindHost('192.168.1.10'), true);
  assert.equal(isNetworkBindHost('example.local'), true);
  assert.equal(isNetworkBindHost('127.0.0.1'), false);
  assert.equal(isNetworkBindHost('::1'), false);
});

test('strong token requires at least 32 non-trivial characters', () => {
  assert.equal(isStrongAuthToken(strongToken), true);
  assert.equal(isStrongAuthToken('short'), false);
  assert.equal(isStrongAuthToken('password'), false);
  assert.equal(isStrongAuthToken('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false);
});

test('network bind rejects empty token', () => {
  assert.throws(() => assertSafeBindAuthConfig({ bindHost: '0.0.0.0', authToken: '' }), /AUTH_TOKEN is empty/);
});

test('network bind rejects weak token', () => {
  assert.throws(() => assertSafeBindAuthConfig({ bindHost: '0.0.0.0', authToken: 'short' }), /AUTH_TOKEN is too weak/);
});

test('loopback bind allows empty token', () => {
  assert.doesNotThrow(() => assertSafeBindAuthConfig({ bindHost: '127.0.0.1', authToken: '' }));
  assert.doesNotThrow(() => assertSafeBindAuthConfig({ bindHost: '::1', authToken: '' }));
});

test('wildcard IPv6 rejects empty token', () => {
  assert.throws(() => assertSafeBindAuthConfig({ bindHost: '::', authToken: '' }), /AUTH_TOKEN is empty/);
});

test('network bind accepts strong token', () => {
  assert.doesNotThrow(() => assertSafeBindAuthConfig({ bindHost: '0.0.0.0', authToken: strongToken }));
});
