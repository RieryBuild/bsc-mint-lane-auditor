// keccak.test.js — known vectors for the pure-JS Keccak-256.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, selector } = require('../src/keccak');

test('keccak256 of empty input', () => {
  assert.equal(
    keccak256(''),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
  );
});

test('keccak256 of "hello"', () => {
  assert.equal(
    keccak256('hello'),
    '1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8'
  );
});

test('keccak256 accepts Uint8Array', () => {
  assert.equal(
    keccak256(new TextEncoder().encode('hello')),
    '1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8'
  );
});

test('keccak256 of "abc"', () => {
  assert.equal(
    keccak256('abc'),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'
  );
});

test('keccak256 is deterministic and 32 bytes, even past one rate block', () => {
  const input = 'a'.repeat(200); // crosses the 136-byte rate boundary
  const digest = keccak256(input);
  assert.equal(digest.length, 64);
  assert.equal(digest, keccak256(input));
  assert.notEqual(digest, keccak256('a'.repeat(199)));
});

test('selectors match the well-known ERC-20 / ERC-721 values', () => {
  assert.equal(selector('transfer(address,uint256)'), '0xa9059cbb');
  assert.equal(selector('balanceOf(address)'), '0x70a08231');
  assert.equal(selector('totalSupply()'), '0x18160ddd');
  assert.equal(selector('approve(address,uint256)'), '0x095ea7b3');
  assert.equal(selector('owner()'), '0x8da5cb5b');
  assert.equal(selector('decimals()'), '0x313ce567');
  assert.equal(selector('symbol()'), '0x95d89b41');
  assert.equal(selector('name()'), '0x06fdde03');
});
