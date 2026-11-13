# bsc-mint-lane-auditor

Before you ape into a "free mint", check whether the free lane is actually
open. This CLI probes a contract's mint lanes on BSC (or any EVM chain) and
reports a verdict with the evidence behind it — no wallet connection, no
gas, no transaction. Everything is read-only `eth_call`s.

```
$ bsc-mint-lane-auditor 0x7ea4514264795982f1cf91072f115619879e1236

🔒 FREE MINT BLOCKED
  sold out — totalSupply (88) has reached maxSupply (88)

  contract   0x7ea4514264795982f1cf91072f115619879e1236
  ...
  price      0 (free)  (via MINTING_PRICE())
  supply     totalSupply() = 88, MAX_SUPPLY() = 88
  sale       active = true
  sim        mint(uint256,address) value-0 — REVERTED (string: Amount would exceed max supply.)
```

## Why this exists

Free-mint hunting has a recurring failure mode: the site says "free mint",
the preview passes, and the transaction still reverts — or worse, the lane
was never there at all. The checks that actually answer the question are
cheap, but they have to run in the right order:

1. **Bytecode first.** A revert alone cannot tell "lane closed" from
   "function never existed" — only the deployed bytecode can. The audit
   scans for known mint/claim/price/supply selectors before it calls
   anything.
2. **Getters second.** Price, remaining supply, pause flags, and (with
   `--wallet`) per-wallet claimed/cap state.
3. **Value-0 sim last.** One `eth_call` of the best mint candidate from
   your wallet, with 0 value. A revert names the missing gate for free;
   a pass means the lane is open *at the pinned block* — a passing sim is
   a timestamp, not a reservation.

Three more rules baked in from experience:

- A **bool read of a missing function returns true**, so a `paused()` check
  is never trusted unless the selector is in the bytecode.
- An `eth_call` with tag `latest` can return a **hard fake `0x0`**, so
  every read is pinned to one block number (the report prints it).
- A **sold-out check beats a sim**: if `totalSupply` already equals
  `maxSupply`, no sim can pass, and the verdict says so directly.

## Install

Requires Node.js 18+ (uses the built-in `fetch` and `node:test`). Zero
runtime dependencies — the Keccak-256 used for function selectors is
implemented in [`src/keccak.js`](src/keccak.js) and cross-checked against
ethers in the test suite.

```bash
git clone https://github.com/RieryBuild/bsc-mint-lane-auditor.git
cd bsc-mint-lane-auditor
npm test          # 33 tests, no network needed
```

No install step is needed to run it:

```bash
node src/cli.js <contract-address> [options]
# or, once linked: npm link && bsc-mint-lane-auditor <contract-address>
```

## Usage

```
bsc-mint-lane-auditor <contract-address> [options]

  --wallet <address>   wallet to simulate from (default: zero address —
                       triages the lane's gates for free; pass a real wallet
                       to also read per-wallet claimed/cap state)
  --quantity <n>       mint quantity to simulate (default: 1)
  --rpc <url>          JSON-RPC endpoint (default: built-in BSC failover list)
  --timeout <ms>       RPC timeout per call (default: 15000)
  --json               print the full report as JSON instead of the table
```

Exit codes: **0** = free mint open · **1** = blocked / paid-only / no lane ·
**2** = error (bad address, dead RPC).

## Verdicts

| Verdict | Meaning |
|---|---|
| `FREE_MINT_OPEN` | A free lane exists, price is 0, and the value-0 sim passed |
| `FREE_MINT_BLOCKED` | A lane exists but is closed — sold out, paused, sale inactive, or the sim reverted (reason included) |
| `PAID_ONLY` | The mint lane exists but costs > 0 (price quoted in the report) |
| `NO_MINT_LANE` | No known mint/claim selector in the deployed bytecode |
| `NOT_A_CONTRACT` | No bytecode at the address |
| `RPC_ERROR` | The RPC could not be reached (the CLI exits 2 instead) |

## Real examples

All three ran live against BSC on 2026-11-13; the full JSON reports are in
[`examples/`](examples/).

**1. Sold out, free price, string revert — Lucky888**
(`0x7ea4514264795982f1cf91072f115619879e1236`, block 133272030)

```
🔒 FREE MINT BLOCKED
  sold out — totalSupply (88) has reached maxSupply (88)
  price      0 (free)  (via MINTING_PRICE())
  supply     totalSupply() = 88, MAX_SUPPLY() = 88
  sale       active = true
  sim        mint(uint256,address) value-0 — REVERTED (string: Amount would exceed max supply.)
```

**2. Sold out, free price, empty revert — Ultraverse City (Zone37)**
(`0xb9ec5608da9b4e9ebef82566affc509776ac6482`, block 133272025)

```
🔒 FREE MINT BLOCKED
  sold out — totalSupply (1000) has reached maxSupply (1000)
  price      0 (free)  (via cost())
  supply     totalSupply() = 1000, maxSupply() = 1000
  paused     false
  sim        mint(address,uint256) value-0 — REVERTED (empty: …the selector is present
             in bytecode, so a live gate reverted with a bare revert() and no reason string)
```

Note the difference: the same "sold out" fact produces a *string* revert on
one contract and an *empty* revert on the other. The tool does not treat an
empty revert as "function missing" when the selector is in the bytecode.

**3. No mint lane at all — WBNB**
(`0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`, block 133272043)

```
🚫 NO MINT LANE
  no known mint/claim selector in the deployed bytecode
  supply     totalSupply() = 1545807490616822185021281
```

## How it works

```
src/
  cli.js        argument parsing, human + JSON output, exit codes
  audit.js      the audit: pin block → getCode → scan → getters → value-0 sim → verdict
                + Rpc client with endpoint failover and block re-pinning
  selectors.js  signature table (mint / price / supply / wallet / state),
                bytecode scan, minimal ABI calldata encoding
  revert.js     revert decoding: Error(string), Panic(uint256), custom errors, empty
  keccak.js     pure-JS Keccak-256 (function selectors need it; Node has no built-in)
test/           33 tests with node:test — keccak vectors, selector table,
                revert decoding, verdict classification, RPC failover/re-pin (mocked)
```

**RPC resilience.** Public BSC nodes rate-limit (HTTP 429) and disagree on
the chain tip, so the client rotates across a failover list on transport
errors and re-pins the block once when a node answers "block not found".
RPC-level errors (a revert) are answers, not failures, and never trigger a
retry — the revert payload is the evidence.

## Limitations

- The selector table covers the common mint/claim shapes (`freeMint`,
  `mint(uint256[, address])`, `claim`, `publicMint`, …). An exotic lane
  with an unusual name reports `NO_MINT_LANE` — check the contract source
  and add the signature to `src/selectors.js`.
- A passing value-0 sim proves the call does not revert *at the pinned
  block*. It does not reserve a slot, and it cannot see gates that only
  trigger on a real transaction (e.g. a per-block mint cap shared with
  other callers).
- Per-wallet state is only read when `--wallet` names a real wallet; the
  default zero-address run triages the lane's global gates.

## License

MIT — see [LICENSE](LICENSE).
