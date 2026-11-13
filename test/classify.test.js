// classify.test.js — the verdict logic, without any network.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../src/audit');

const base = {
  hasCode: true,
  mintFound: [{ signature: 'freeMint()' }],
  price: 0n,
  sim: { ok: true, function: 'freeMint()' },
  paused: false,
  saleActive: null,
};

test('free lane + passing sim = FREE_MINT_OPEN', () => {
  assert.equal(classify(base).verdict, 'FREE_MINT_OPEN');
});

test('no bytecode = NOT_A_CONTRACT', () => {
  assert.equal(classify({ ...base, hasCode: false, mintFound: [] }).verdict, 'NOT_A_CONTRACT');
});

test('no mint selector in bytecode = NO_MINT_LANE', () => {
  assert.equal(classify({ ...base, mintFound: [], sim: null }).verdict, 'NO_MINT_LANE');
});

test('paused contract is blocked even when the sim would pass', () => {
  const result = classify({ ...base, paused: true });
  assert.equal(result.verdict, 'FREE_MINT_BLOCKED');
  assert.match(result.reason, /paused/);
});

test('sale-state getter reporting inactive blocks the lane', () => {
  assert.equal(classify({ ...base, saleActive: false }).verdict, 'FREE_MINT_BLOCKED');
});

test('sim revert with a string reason is blocked, with the reason kept', () => {
  const result = classify({
    ...base,
    sim: { ok: false, function: 'freeMint()', revert: { kind: 'string', message: 'Free phase over' } },
  });
  assert.equal(result.verdict, 'FREE_MINT_BLOCKED');
  assert.match(result.reason, /Free phase over/);
});

test('a price above zero makes a passing sim PAID_ONLY, not free', () => {
  const result = classify({ ...base, price: 500000000000000n });
  assert.equal(result.verdict, 'PAID_ONLY');
});

test('price above zero + reverting value-0 sim = PAID_ONLY', () => {
  const result = classify({
    ...base,
    price: 1000000000000000n,
    sim: { ok: false, function: 'mint(uint256)', revert: { kind: 'string', message: 'Wrong value' } },
  });
  assert.equal(result.verdict, 'PAID_ONLY');
});

test('no sim at all is blocked, not open', () => {
  assert.equal(classify({ ...base, sim: null }).verdict, 'FREE_MINT_BLOCKED');
});

test('totalSupply at maxSupply is sold out, even with a free price', () => {
  const result = classify({
    ...base,
    supply: { 'totalSupply()': '1000', 'maxSupply()': '1000' },
  });
  assert.equal(result.verdict, 'FREE_MINT_BLOCKED');
  assert.match(result.reason, /sold out/);
});

test('totalSupply below maxSupply does not trigger sold out', () => {
  const result = classify({
    ...base,
    supply: { 'totalSupply()': '999', 'maxSupply()': '1000' },
  });
  assert.equal(result.verdict, 'FREE_MINT_OPEN');
});
