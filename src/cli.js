#!/usr/bin/env node
// bsc-mint-lane-auditor — CLI: probe a contract's mint lanes and report
// whether a free mint is open, and what blocks it when it is not.
// Exit codes: 0 = free mint open · 1 = blocked / paid-only / no lane · 2 = error.
'use strict';

const { auditContract, isAddress, DEFAULT_RPC, DEFAULT_RPCS, ZERO_ADDRESS } = require('./audit');

const VERSION = '1.0.0';

const VERDICT_LABEL = {
  FREE_MINT_OPEN: '✅ FREE MINT OPEN',
  FREE_MINT_BLOCKED: '🔒 FREE MINT BLOCKED',
  PAID_ONLY: '💰 PAID ONLY',
  NO_MINT_LANE: '🚫 NO MINT LANE',
  NOT_A_CONTRACT: '❓ NOT A CONTRACT',
  RPC_ERROR: '⚠️ RPC ERROR',
};

function usage() {
  return `bsc-mint-lane-auditor v${VERSION} — probe a contract's mint lanes (BSC by default, any EVM RPC works)

Usage:
  bsc-mint-lane-auditor <contract-address> [options]

Options:
  --wallet <address>   wallet to simulate from (default: zero address — triages
                       the lane's gates for free; pass a real wallet to also
                       read per-wallet claimed/cap state)
  --quantity <n>       mint quantity to simulate (default: 1)
  --rpc <url>          JSON-RPC endpoint (default: built-in BSC failover list,
                       starting at ${DEFAULT_RPC})
  --timeout <ms>       RPC timeout per call (default: 15000)
  --json               print the full report as JSON instead of the table
  --help               show this help

Examples:
  bsc-mint-lane-auditor 0x55d398326f99059fF775485246999027B319F
  bsc-mint-lane-auditor 0x... --wallet 0x... --json
`;
}

function parseArgs(argv) {
  const opts = { wallet: ZERO_ADDRESS, quantity: 1, rpc: DEFAULT_RPCS, timeoutMs: 15000, json: false };
  let contract = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--wallet') { opts.wallet = argv[++i]; continue; }
    if (arg === '--quantity') { opts.quantity = Number(argv[++i]); continue; }
    if (arg === '--rpc') { opts.rpc = argv[++i]; continue; }
    if (arg === '--timeout') { opts.timeoutMs = Number(argv[++i]); continue; }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    if (!contract) { contract = arg; continue; }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return { contract, opts };
}

function formatWei(wei) {
  if (wei === null || wei === undefined) return '—';
  const n = BigInt(wei);
  if (n === 0n) return '0 (free)';
  // Show in BNB when it divides cleanly enough to read; always show raw wei.
  const bnb = Number(n) / 1e18;
  return bnb >= 0.000001 ? `${bnb} BNB (${n} wei)` : `${n} wei`;
}

function printReport(report) {
  const lines = [];
  lines.push('');
  lines.push(`${VERDICT_LABEL[report.verdict] || report.verdict}`);
  lines.push(`  ${report.reason}`);
  lines.push('');
  lines.push(`  contract   ${report.contract}`);
  lines.push(`  wallet     ${report.wallet}`);
  lines.push(`  rpc        ${report.rpc}`);
  lines.push(`  block      ${report.blockNumber} (all reads pinned to this block)`);
  if (report.repinned) lines.push(`  note       block re-pinned ${report.repinned}x — RPC nodes disagreed on the tip`);
  lines.push(`  bytecode   ${report.bytecodeLength} bytes`);
  lines.push('');
  const cats = Object.entries(report.selectors);
  if (cats.length) {
    lines.push('  selectors present in bytecode:');
    for (const [cat, sigs] of cats) {
      lines.push(`    ${cat.padEnd(8)} ${sigs.join(', ')}`);
    }
  } else {
    lines.push('  selectors present in bytecode: none of the known mint/price/supply signatures');
  }
  lines.push('');
  lines.push(`  price      ${formatWei(report.priceWei)}${report.priceSource ? `  (via ${report.priceSource})` : ''}`);
  const supply = Object.entries(report.supply);
  lines.push(`  supply     ${supply.length ? supply.map(([k, v]) => `${k} = ${v}`).join(', ') : '—'}`);
  const walletState = Object.entries(report.walletState);
  if (walletState.length) {
    lines.push(`  wallet     ${walletState.map(([k, v]) => `${k} = ${v}`).join(', ')}`);
  }
  if (report.paused !== null) lines.push(`  paused     ${report.paused}`);
  if (report.saleActive !== null) lines.push(`  sale       active = ${report.saleActive}`);
  if (report.sim) {
    if (report.sim.ok) {
      lines.push(`  sim        ${report.sim.function} value-0 — OK`);
    } else {
      lines.push(`  sim        ${report.sim.function} value-0 — REVERTED (${report.sim.revert.kind}: ${report.sim.revert.message})`);
    }
  } else {
    lines.push('  sim        not run (no mint candidate in bytecode)');
  }
  lines.push('');
  lines.push(`  checked at ${report.checkedAt}`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}\n`);
    console.error(usage());
    process.exit(2);
  }
  if (parsed.help || !parsed.contract) {
    console.log(usage());
    process.exit(parsed.help ? 0 : 2);
  }
  const { contract, opts } = parsed;
  if (!isAddress(contract)) {
    console.error(`error: invalid contract address: ${contract}`);
    process.exit(2);
  }
  if (!isAddress(opts.wallet)) {
    console.error(`error: invalid wallet address: ${opts.wallet}`);
    process.exit(2);
  }
  if (!Number.isInteger(opts.quantity) || opts.quantity < 1) {
    console.error('error: --quantity must be a positive integer');
    process.exit(2);
  }

  let report;
  try {
    report = await auditContract({ contract, ...opts });
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(printReport(report));
  }
  process.exit(report.verdict === 'FREE_MINT_OPEN' ? 0 : 1);
}

if (require.main === module) main();

module.exports = { parseArgs, printReport, formatWei };
