// revert.js — decode an eth_call revert payload into something a human can act on.
// A string revert ("Free phase over") means the lane closed by rule; a
// custom-error selector means contract logic refused; an EMPTY 0x revert
// means your selector was never deployed — not that the lane is shut.
'use strict';

const PANIC_CODES = {
  0x00: 'generic panic',
  0x01: 'assert(false)',
  0x11: 'arithmetic overflow / underflow',
  0x12: 'division or modulo by zero',
  0x21: 'enum value out of bounds',
  0x22: 'storage byte array badly encoded',
  0x31: 'pop() on an empty array',
  0x32: 'array index out of bounds',
  0x41: 'too much memory / zero-length array allocation',
  0x51: 'function called on a zero-initialised variable',
};

/**
 * Decode revert returndata (hex string with 0x prefix, or '0x').
 * Returns { kind, message, ... } where kind is one of:
 *   'ok' | 'string' | 'panic' | 'custom' | 'empty' | 'raw'
 */
function decodeRevert(data) {
  if (!data || data === '0x' || data === '0X') {
    return {
      kind: 'empty',
      message: 'empty revert — no returndata (a bare revert() with no reason string, or a call that never reached contract logic)',
    };
  }
  const hex = data.toLowerCase().replace(/^0x/, '');

  // Error(string) — selector 0x08c379a0
  if (hex.startsWith('08c379a0') && hex.length >= 8 + 64 + 64) {
    try {
      const len = parseInt(hex.slice(8 + 64, 8 + 128), 16);
      const strHex = hex.slice(8 + 128, 8 + 128 + len * 2);
      const reason = Buffer.from(strHex, 'hex').toString('utf8');
      return { kind: 'string', message: reason, reason };
    } catch {
      return { kind: 'raw', message: `undecodable Error(string) payload: ${data}` };
    }
  }

  // Panic(uint256) — selector 0x4e487b71
  if (hex.startsWith('4e487b71') && hex.length >= 8 + 64) {
    const code = parseInt(hex.slice(8, 8 + 64), 16);
    const label = PANIC_CODES[code] || `unknown panic code 0x${code.toString(16)}`;
    return { kind: 'panic', message: `Panic(0x${code.toString(16).padStart(2, '0')}): ${label}`, code };
  }

  // Anything else with a 4-byte selector is a custom error.
  if (hex.length >= 8) {
    return {
      kind: 'custom',
      selector: '0x' + hex.slice(0, 8),
      message: `custom error 0x${hex.slice(0, 8)} (look the selector up on the contract source / 4byte.directory)`,
    };
  }

  return { kind: 'raw', message: `short revert payload: ${data}` };
}

/**
 * Decode a uint256 return value from eth_call ('0x...' 32 bytes) to BigInt,
 * or null when the payload is not a clean uint256.
 */
function decodeUint256(data) {
  if (!data || typeof data !== 'string') return null;
  const hex = data.replace(/^0x/, '');
  if (hex.length !== 64) return null;
  try {
    return BigInt('0x' + hex);
  } catch {
    return null;
  }
}

/** Decode a bool return value (uint256 0/1) to true/false, or null. */
function decodeBool(data) {
  const v = decodeUint256(data);
  if (v === null) return null;
  if (v === 0n) return false;
  if (v === 1n) return true;
  return null; // non-bool payload — a bool read of a missing function returns true, so never trust this alone
}

module.exports = { decodeRevert, decodeUint256, decodeBool, PANIC_CODES };
