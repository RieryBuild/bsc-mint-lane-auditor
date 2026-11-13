// selectors.js — the function-signature table a free-mint lane audit checks.
// A revert alone cannot tell "lane closed" from "function never existed", so
// the audit scans deployed bytecode for these selectors FIRST, then only
// calls/simulates the ones that are actually there.
//
// Categories:
//   mint   — entry points that can mint/claim (checked for a free lane)
//   price  — getters that report what a mint costs
//   supply — getters that report how much is left / how many exist
//   wallet — per-wallet getters (already claimed? per-wallet cap?)
//   state  — pause / sale-state flags
'use strict';

const { selector } = require('./keccak');

const SIGNATURES = {
  mint: [
    'freeMint()',
    'freeMint(address)',
    'freeMint(uint256)',
    'mint(uint256)',
    'mint(uint256,address)',
    'mint(address,uint256)',
    'mint(address)',
    'claim()',
    'claim(uint256)',
    'claim(address,uint256)',
    'publicMint(uint256)',
    'publicMint(uint256,address)',
    'mintPublic(uint256)',
    'purchase(uint256)',
    'buy(uint256)',
    'mintFree()',
    'airdropClaim()',
  ],
  price: [
    'mintPrice()',
    'price()',
    'cost()',
    'PUBLIC_PRICE()',
    'publicPrice()',
    'mintCost()',
    'salePrice()',
    'MINTING_PRICE()',
    'MINT_PRICE()',
  ],
  supply: [
    'totalSupply()',
    'maxSupply()',
    'MAX_SUPPLY()',
    'publicRemaining()',
    'remaining()',
    'maxMintable()',
    'availableSupply()',
    'totalMinted()',
  ],
  wallet: [
    'freeMinted(address)',
    'hasMinted(address)',
    'minted(address)',
    'claimed(address)',
    'freeClaimed(address)',
    'maxMintPerWallet()',
    'maxPerWallet()',
    'walletMinted(address)',
    'balanceOf(address)',
  ],
  state: [
    'paused()',
    'saleActive()',
    'isSaleActive()',
    'saleOpen()',
    'publicSaleActive()',
    'mintingEnabled()',
    'mintingActive()',
    'mintActive()',
  ],
};

// signature -> { signature, selector, category }
const TABLE = {};
for (const [category, sigs] of Object.entries(SIGNATURES)) {
  for (const sig of sigs) {
    TABLE[sig] = { signature: sig, selector: selector(sig), category };
  }
}

function lookup(signature) {
  return TABLE[signature] || null;
}

function byCategory(category) {
  return SIGNATURES[category].map((sig) => TABLE[sig]);
}

/** True when the deployed bytecode contains the 4-byte selector. */
function bytecodeHasSelector(bytecode, sel) {
  if (!bytecode || bytecode === '0x' || bytecode.length < 10) return false;
  return bytecode.toLowerCase().includes(sel.slice(2).toLowerCase());
}

/** Scan bytecode; returns { category: [entry, ...] } of selectors present. */
function scanBytecode(bytecode) {
  const found = {};
  for (const [category, sigs] of Object.entries(SIGNATURES)) {
    const hits = sigs.map((sig) => TABLE[sig]).filter((e) => bytecodeHasSelector(bytecode, e.selector));
    if (hits.length) found[category] = hits;
  }
  return found;
}

// --- minimal ABI encoding helpers (no ethers needed) -----------------------

function encodeUint256(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

function encodeAddress(addr) {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/** Calldata for a no-arg function. */
function calldata0(signature) {
  return lookup(signature).selector;
}

/** Calldata for mint-style functions, given quantity and (optionally) a to-address. */
function mintCalldata(signature, { quantity = 1, to = null } = {}) {
  const sel = lookup(signature).selector;
  if (signature === 'freeMint()' || signature === 'claim()' || signature === 'mintFree()' || signature === 'airdropClaim()') {
    return sel;
  }
  if (signature === 'freeMint(address)' || signature === 'mint(address)') {
    return sel + encodeAddress(to);
  }
  if (signature === 'freeMint(uint256)' || signature === 'mint(uint256)' ||
      signature === 'claim(uint256)' || signature === 'publicMint(uint256)' ||
      signature === 'mintPublic(uint256)' || signature === 'purchase(uint256)' ||
      signature === 'buy(uint256)') {
    return sel + encodeUint256(quantity);
  }
  if (signature === 'mint(uint256,address)' || signature === 'publicMint(uint256,address)' ||
      signature === 'claim(address,uint256)') {
    // claim(address,uint256) is (address, qty); the others are (qty, address).
    return signature.startsWith('claim(')
      ? sel + encodeAddress(to) + encodeUint256(quantity)
      : sel + encodeUint256(quantity) + encodeAddress(to);
  }
  if (signature === 'mint(address,uint256)') {
    return sel + encodeAddress(to) + encodeUint256(quantity);
  }
  throw new Error(`no calldata builder for ${signature}`);
}

/** Calldata for a per-wallet getter, e.g. freeMinted(address). */
function walletCalldata(signature, wallet) {
  return lookup(signature).selector + encodeAddress(wallet);
}

module.exports = {
  SIGNATURES,
  TABLE,
  lookup,
  byCategory,
  bytecodeHasSelector,
  scanBytecode,
  encodeUint256,
  encodeAddress,
  calldata0,
  mintCalldata,
  walletCalldata,
};
