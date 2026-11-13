// keccak.js — Keccak-256 (original Keccak padding, NOT SHA-3) in pure JS.
// Zero dependencies: Node has no built-in keccak, and function selectors are
// keccak256(signature)[0..4], so a mint-lane auditor needs one. BigInt lanes
// keep the code short and obviously correct; inputs here are tiny (a few
// dozen bytes), so speed is a non-issue.

'use strict';

const MASK = (1n << 64n) - 1n;

// Round constants for Keccak-f[1600] (24 rounds).
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets r[x][y].
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(x, n) {
  if (n === 0) return x;
  const b = BigInt(n);
  return ((x << b) | (x >> (64n - b))) & MASK;
}

function keccakF(state) {
  for (let round = 0; round < 24; round++) {
    // Theta
    const C = new Array(5);
    for (let x = 0; x < 5; x++) {
      C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    const D = new Array(5);
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] ^= D[x];
      }
    }
    // Rho + Pi
    const B = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROT[x][y]);
      }
    }
    // Chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] =
          B[x + 5 * y] ^ (~B[(x + 1) % 5 + 5 * y] & B[(x + 2) % 5 + 5 * y]);
      }
    }
    // Iota
    state[0] ^= RC[round];
  }
}

/**
 * Keccak-256 digest of a string or Uint8Array. Returns a lowercase hex string
 * without the 0x prefix.
 */
function keccak256(input) {
  const bytes = typeof input === 'string'
    ? new TextEncoder().encode(input)
    : input;
  // Keccak-256: rate 1088 bits = 136 bytes, suffix 0x01, pad10*1.
  const rate = 136;
  const state = new Array(25).fill(0n);

  const absorb = (block) => {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(block[i * 8 + b]) << BigInt(8 * b);
      }
      state[i] ^= lane;
    }
    keccakF(state);
  };

  let offset = 0;
  while (offset + rate <= bytes.length) {
    absorb(bytes.slice(offset, offset + rate));
    offset += rate;
  }
  const tail = new Uint8Array(rate);
  tail.set(bytes.slice(offset));
  tail[bytes.length - offset] = 0x01;
  tail[rate - 1] |= 0x80;
  absorb(tail);

  // Squeeze the first 32 bytes (lanes 0..3, little-endian).
  let out = '';
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let b = 0; b < 8; b++) {
      out += Number((lane >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
    }
  }
  return out;
}

/** 4-byte function selector for a canonical signature, e.g. "mint(uint256)". */
function selector(signature) {
  return '0x' + keccak256(signature).slice(0, 8);
}

module.exports = { keccak256, selector };
