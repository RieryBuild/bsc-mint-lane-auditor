// selectors.test.js — bytecode scan and calldata builders.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  lookup, byCategory, bytecodeHasSelector, scanBytecode,
  mintCalldata, walletCalldata, calldata0,
} = require('../src/selectors');
const { selector } = require('../src/keccak');

test('every table entry carries the keccak selector of its signature', () => {
  for (const entry of Object.values(require('../src/selectors').TABLE)) {
    assert.equal(entry.selector, selector(entry.signature));
  }
});

test('bytecode scan finds selectors and ignores absent ones', () => {
  // Fake bytecode containing only the freeMint() and mintPrice() selectors.
  const fake = '0x6080604052' + lookup('freeMint()').selector.slice(2) + '6000' + lookup('mintPrice()').selector.slice(2);
  const found = scanBytecode(fake);
  assert.deepEqual(found.mint.map((e) => e.signature), ['freeMint()']);
  assert.deepEqual(found.price.map((e) => e.signature), ['mintPrice()']);
  assert.equal(found.supply, undefined);
});

test('bytecodeHasSelector is case-insensitive and rejects empty code', () => {
  assert.equal(bytecodeHasSelector('0x', lookup('mint(uint256)').selector), false);
  assert.equal(bytecodeHasSelector('', lookup('mint(uint256)').selector), false);
  const upper = '0x' + lookup('mint(uint256)').selector.slice(2).toUpperCase();
  assert.equal(bytecodeHasSelector(upper, lookup('mint(uint256)').selector), true);
});

test('mintCalldata encodes quantity and address correctly', () => {
  const wallet = '0x288c7AedbA182246A04430d88470BeF37C40c312';
  const qty1 = mintCalldata('mint(uint256)', { quantity: 1 });
  assert.equal(qty1, lookup('mint(uint256)').selector + '0'.repeat(63) + '1');
  const qty2 = mintCalldata('mint(uint256,address)', { quantity: 2, to: wallet });
  assert.equal(
    qty2,
    lookup('mint(uint256,address)').selector + '0'.repeat(63) + '2' + wallet.slice(2).toLowerCase().padStart(64, '0')
  );
  assert.equal(mintCalldata('freeMint()', {}), lookup('freeMint()').selector);
  assert.equal(
    mintCalldata('mint(address,uint256)', { quantity: 3, to: wallet }),
    lookup('mint(address,uint256)').selector
      + wallet.slice(2).toLowerCase().padStart(64, '0')
      + '0'.repeat(63) + '3'
  );
});

test('walletCalldata encodes a per-wallet getter', () => {
  const wallet = '0x288c7AedbA182246A04430d88470BeF37C40c312';
  assert.equal(
    walletCalldata('freeMinted(address)', wallet),
    lookup('freeMinted(address)').selector + wallet.slice(2).toLowerCase().padStart(64, '0')
  );
});

test('calldata0 is just the selector', () => {
  assert.equal(calldata0('mintPrice()'), lookup('mintPrice()').selector);
});

test('byCategory returns entries for a category', () => {
  assert.ok(byCategory('price').some((e) => e.signature === 'mintPrice()'));
  assert.ok(byCategory('mint').length > 10);
});
