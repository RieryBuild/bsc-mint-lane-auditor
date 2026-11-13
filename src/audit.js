// audit.js — the audit itself: bytecode scan, getter reads, value-0 sim, verdict.
// Order matters (cheap verification first):
//   1. bytecode exists? (eth_getCode)
//   2. which mint/price/supply selectors are actually deployed? (bytecode scan)
//   3. what do the getters say? (eth_call, all pinned to ONE block number —
//      a `latest` read can return a hard fake 0x0, so the block is pinned)
//   4. value-0 eth_call sim of the best mint candidate from the wallet
//      (blank-wallet first: a revert names the missing gate for free)
// A passing sim is a timestamp, not a reservation — the report carries the
// block number so the reader knows exactly when it was true.
'use strict';

const { scanBytecode, mintCalldata, walletCalldata, lookup, calldata0 } = require('./selectors');
const { decodeRevert, decodeUint256, decodeBool } = require('./revert');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// Default endpoints, tried in order. Public BSC nodes rate-limit and
// disagree on the tip; rotating on transport errors keeps an audit alive.
const DEFAULT_RPCS = [
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
];
const DEFAULT_RPC = DEFAULT_RPCS[0];
const DEFAULT_TIMEOUT_MS = 15000;

// Preferred mint candidates, best free lane first.
const MINT_PREFERENCE = [
  'freeMint()',
  'freeMint(address)',
  'freeMint(uint256)',
  'mintFree()',
  'claim()',
  'claim(uint256)',
  'mint(uint256)',
  'mint(uint256,address)',
  'mint(address,uint256)',
  'mint(address)',
  'publicMint(uint256)',
  'publicMint(uint256,address)',
  'mintPublic(uint256)',
  'claim(address,uint256)',
  'purchase(uint256)',
  'buy(uint256)',
  'airdropClaim()',
];

const VERDICTS = {
  FREE_MINT_OPEN: 'FREE_MINT_OPEN',
  FREE_MINT_BLOCKED: 'FREE_MINT_BLOCKED',
  PAID_ONLY: 'PAID_ONLY',
  NO_MINT_LANE: 'NO_MINT_LANE',
  NOT_A_CONTRACT: 'NOT_A_CONTRACT',
  RPC_ERROR: 'RPC_ERROR',
};

/** Minimal JSON-RPC client over fetch, with a hard timeout and endpoint
 *  failover: transport errors (HTTP 429/5xx, timeouts, network failures)
 *  rotate to the next endpoint, while RPC-level errors (e.g. a revert)
 *  are answers, not failures, and are thrown immediately. */
class Rpc {
  constructor(urls, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.urls = Array.isArray(urls) ? urls : [urls];
    this.timeoutMs = timeoutMs;
    this.id = 0;
    this.endpointIndex = 0;
  }

  get url() {
    return this.urls[this.endpointIndex];
  }

  async call(method, params) {
    let lastError = null;
    // One attempt per endpoint, in order, starting from the current one.
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      const url = this.urls[(this.endpointIndex + attempt) % this.urls.length];
      try {
        const result = await this.callOnce(url, method, params);
        this.endpointIndex = this.urls.indexOf(url);
        return result;
      } catch (err) {
        if (err.isRpcError) throw err; // an answer from the chain, not a transport failure
        lastError = err;
      }
    }
    throw lastError;
  }

  async callOnce(url, method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const json = await res.json();
      if (json.error) {
        // Keep the revert payload: it is the evidence. Public nodes return it
        // as error.data (sometimes nested under error.data.data).
        const data = json.error.data;
        const dataHex = typeof data === 'string' ? data
          : (data && typeof data.data === 'string' ? data.data : null);
        const suffix = dataHex ? ` | revert data: ${dataHex}` : '';
        const err = new Error(`RPC error ${json.error.code}: ${json.error.message}${suffix}`);
        err.isRpcError = true;
        throw err;
      }
      return json.result;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`RPC timeout after ${this.timeoutMs}ms (${url})`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  getCode(address, block) {
    return this.call('eth_getCode', [address, block]);
  }

  getBlockNumber() {
    return this.call('eth_blockNumber', []);
  }

  ethCall({ from, to, data, value = '0x0', block }) {
    return this.call('eth_call', [{ from, to, data, value }, block]);
  }
}

function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Pure verdict classifier — kept separate so it is unit-testable without a network.
 * Input: the evidence gathered by the audit. Output: { verdict, reason }.
 */
function classify(evidence) {
  const { hasCode, mintFound, price, sim, paused, saleActive, supply = {} } = evidence;

  if (!hasCode) {
    return { verdict: VERDICTS.NOT_A_CONTRACT, reason: 'no bytecode at this address — it is an EOA or an undeployed address' };
  }
  if (!mintFound.length) {
    return { verdict: VERDICTS.NO_MINT_LANE, reason: 'no known mint/claim selector in the deployed bytecode' };
  }
  // Sold out is terminal — it outranks pause / sale-state flags, which an
  // owner can flip back on.
  const minted = supply['totalSupply()'] !== undefined ? BigInt(supply['totalSupply()']) : null;
  const max = supply['maxSupply()'] !== undefined ? BigInt(supply['maxSupply()'])
    : supply['MAX_SUPPLY()'] !== undefined ? BigInt(supply['MAX_SUPPLY()']) : null;
  if (minted !== null && max !== null && max > 0n && minted >= max) {
    return { verdict: VERDICTS.FREE_MINT_BLOCKED, reason: `sold out — totalSupply (${minted}) has reached maxSupply (${max})` };
  }
  if (paused === true) {
    return { verdict: VERDICTS.FREE_MINT_BLOCKED, reason: 'contract reports paused() = true' };
  }
  if (saleActive === false) {
    return { verdict: VERDICTS.FREE_MINT_BLOCKED, reason: 'sale-state getter reports the sale is not active' };
  }
  if (!sim) {
    return { verdict: VERDICTS.FREE_MINT_BLOCKED, reason: 'no mint simulation could be run' };
  }
  if (sim.ok) {
    if (price !== null && price !== undefined && price > 0n) {
      return { verdict: VERDICTS.PAID_ONLY, reason: `value-0 sim passed but the price getter reports ${price} wei — this lane is paid, not free` };
    }
    return { verdict: VERDICTS.FREE_MINT_OPEN, reason: `value-0 sim of ${sim.function} passed at the pinned block` };
  }
  // Sim reverted: the decoded reason is the evidence.
  const why = sim.revert && sim.revert.message ? ` — ${sim.revert.message}` : '';
  if (price !== null && price !== undefined && price > 0n) {
    return { verdict: VERDICTS.PAID_ONLY, reason: `mint costs ${price} wei and the value-0 sim reverted${why}` };
  }
  return { verdict: VERDICTS.FREE_MINT_BLOCKED, reason: `value-0 sim of ${sim.function} reverted${why}` };
}

/**
 * Run a full audit. Options:
 *   contract (required), wallet, rpc, quantity, timeoutMs
 * Returns a report object (never throws for on-chain findings; throws only
 * for bad input or a dead RPC).
 */
async function auditContract({ contract, wallet = ZERO_ADDRESS, rpc = DEFAULT_RPCS, quantity = 1, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!isAddress(contract)) throw new Error(`invalid contract address: ${contract}`);
  if (!isAddress(wallet)) throw new Error(`invalid wallet address: ${wallet}`);

  const client = new Rpc(rpc, timeoutMs);
  const report = {
    contract: contract.toLowerCase(),
    wallet: wallet.toLowerCase(),
    rpc: Array.isArray(rpc) ? rpc.join(', ') : rpc,
    quantity,
    blockNumber: null,
    hasCode: false,
    bytecodeLength: 0,
    selectors: {},
    priceWei: null,
    priceSource: null,
    supply: {},
    walletState: {},
    paused: null,
    saleActive: null,
    sim: null,
    verdict: VERDICTS.RPC_ERROR,
    reason: '',
    checkedAt: new Date().toISOString(),
  };

  // Pin one block for every read that follows. Public RPCs load-balance
  // across nodes that can disagree on the tip, so a pinned block can come
  // back "block not found" on a later call — re-pin once and retry.
  let blockHex = await client.getBlockNumber();
  report.blockNumber = parseInt(blockHex, 16);
  report.repinned = 0;
  const guarded = async (fn) => {
    try {
      return await fn(blockHex);
    } catch (err) {
      if (/block not found/i.test(err.message)) {
        blockHex = await client.getBlockNumber();
        report.blockNumber = parseInt(blockHex, 16);
        report.repinned += 1;
        return await fn(blockHex);
      }
      throw err;
    }
  };

  const code = await guarded((block) => client.getCode(contract, block));
  report.bytecodeLength = code === '0x' ? 0 : (code.length - 2) / 2;
  report.hasCode = report.bytecodeLength > 0;
  if (!report.hasCode) {
    const c = classify({ hasCode: false, mintFound: [] });
    report.verdict = c.verdict;
    report.reason = c.reason;
    return report;
  }

  const found = scanBytecode(code);
  report.selectors = Object.fromEntries(
    Object.entries(found).map(([cat, entries]) => [cat, entries.map((e) => e.signature)])
  );

  const callGetter = async (signature, data) => {
    try {
      const raw = await guarded((block) => client.ethCall({ from: ZERO_ADDRESS, to: contract, data, block }));
      return raw;
    } catch {
      return null; // a getter that reverts is treated as absent, not as evidence
    }
  };

  // Price getters — first one that returns a clean uint256 wins.
  for (const entry of found.price || []) {
    const raw = await callGetter(entry.signature, calldata0(entry.signature));
    const value = decodeUint256(raw);
    if (value !== null) {
      report.priceWei = value.toString();
      report.priceSource = entry.signature;
      break;
    }
  }

  // Supply counters.
  for (const entry of found.supply || []) {
    const raw = await callGetter(entry.signature, calldata0(entry.signature));
    const value = decodeUint256(raw);
    if (value !== null) report.supply[entry.signature] = value.toString();
  }

  // Pause / sale-state flags.
  for (const entry of found.state || []) {
    const raw = await callGetter(entry.signature, calldata0(entry.signature));
    const value = decodeBool(raw);
    if (value === null) continue;
    if (entry.signature === 'paused()') report.paused = value;
    else report.saleActive = value;
  }

  // Per-wallet state, only when a real wallet was given.
  if (wallet.toLowerCase() !== ZERO_ADDRESS) {
    for (const entry of found.wallet || []) {
      if (!entry.signature.includes('(address)')) continue;
      const raw = await callGetter(entry.signature, walletCalldata(entry.signature, wallet));
      const value = decodeUint256(raw);
      if (value !== null) report.walletState[entry.signature] = value.toString();
    }
  }

  // Value-0 sim of the best mint candidate actually present in the bytecode.
  const mintFound = found.mint || [];
  const candidate = MINT_PREFERENCE.find((sig) => mintFound.some((e) => e.signature === sig));
  if (candidate) {
    const data = mintCalldata(candidate, { quantity, to: wallet });
    try {
      const raw = await guarded((block) => client.ethCall({ from: wallet, to: contract, data, value: '0x0', block }));
      report.sim = { function: candidate, ok: true, returnData: raw };
    } catch (err) {
      // eth_call failures surface the revert payload in the message
      // (Rpc.call appends it as "revert data: 0x...").
      const tagged = String(err.message).match(/revert data: (0x[0-9a-fA-F]+)/);
      const fallback = String(err.message).match(/0x[0-9a-fA-F]{8,}/);
      const revertData = tagged ? tagged[1] : fallback ? fallback[0] : '0x';
      const decoded = decodeRevert(revertData);
      if (decoded.kind === 'empty') {
        // The selector WAS found in bytecode (we only sim what the scan found),
        // so this is a live gate with no reason string — not a missing function.
        decoded.message = `empty revert from ${candidate} — the selector is present in bytecode, so a live gate (often sold-out or whitelist) reverted with a bare revert() and no reason string`;
      }
      report.sim = { function: candidate, ok: false, revert: decoded, rawError: err.message };
    }
  }

  const priceBig = report.priceWei === null ? null : BigInt(report.priceWei);
  const c = classify({
    hasCode: true,
    mintFound,
    price: priceBig,
    sim: report.sim,
    paused: report.paused,
    saleActive: report.saleActive,
    supply: report.supply,
  });
  report.verdict = c.verdict;
  report.reason = c.reason;
  report.rpc = client.url; // the endpoint that actually served the audit
  return report;
}

module.exports = {
  auditContract,
  classify,
  Rpc,
  isAddress,
  ZERO_ADDRESS,
  DEFAULT_RPC,
  DEFAULT_RPCS,
  VERDICTS,
  MINT_PREFERENCE,
};
