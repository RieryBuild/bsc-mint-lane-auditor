// revert.test.js — revert payload decoding.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeRevert, decodeUint256, decodeBool } = require('../src/revert');

// "Free phase over" as Error(string): 0x08c379a0 + offset + length + utf8.
function errorStringPayload(reason) {
  const text = Buffer.from(reason, 'utf8');
  const len = text.length.toString(16).padStart(64, '0');
  const data = text.toString('hex').padEnd(Math.ceil(text.length / 32) * 64, '0');
  return '0x08c379a0' + '0'.repeat(62) + '20' + len + data;
}

test('decodes Error(string)', () => {
  const decoded = decodeRevert(errorStringPayload('Free phase over'));
  assert.equal(decoded.kind, 'string');
  assert.equal(decoded.reason, 'Free phase over');
});

test('decodes Panic(uint256) with a known code', () => {
  const payload = '0x4e487b71' + '0'.repeat(62) + '11'; // 0x11 = overflow
  const decoded = decodeRevert(payload);
  assert.equal(decoded.kind, 'panic');
  assert.match(decoded.message, /overflow/);
});

test('empty revert is classified as empty, not as lane-closed', () => {
  assert.equal(decodeRevert('0x').kind, 'empty');
  assert.equal(decodeRevert('').kind, 'empty');
  assert.match(decodeRevert('0x').message, /bare revert/);
});

test('unknown 4-byte selector is a custom error', () => {
  const decoded = decodeRevert('0x52df9fe5');
  assert.equal(decoded.kind, 'custom');
  assert.equal(decoded.selector, '0x52df9fe5');
});

test('decodeUint256 round-trips', () => {
  assert.equal(decodeUint256('0x' + '0'.repeat(62) + '2a'), 42n);
  assert.equal(decodeUint256('0x' + '0'.repeat(64)), 0n);
  assert.equal(decodeUint256('0x1234'), null); // wrong length
  assert.equal(decodeUint256(null), null);
});

test('decodeBool only trusts a clean 0/1', () => {
  assert.equal(decodeBool('0x' + '0'.repeat(64)), false);
  assert.equal(decodeBool('0x' + '0'.repeat(63) + '1'), true);
  assert.equal(decodeBool('0x' + '0'.repeat(63) + '2'), null);
});
