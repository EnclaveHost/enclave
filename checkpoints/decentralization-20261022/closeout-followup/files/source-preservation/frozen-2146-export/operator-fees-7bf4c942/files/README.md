# metal0 operator `proposeOwner` (root executes; nothing here was signed or sent)

**What it does.** One transaction, from the public simulated plan
`custody-v2-live-20261023/evidence/metal0-enrollment-unsigned-20261023.json` (sha256 `9f6eba17…`, tx 1):

`EnclaveHostOwnership(0xbbd885d3…).proposeOwner(metal0 0x4dde6d1b…, Enclave wallet 0x0b2d009c…)`

- **From:** the metal0 registry operator `0xc9d0835c…`.
- **Value 0.** The calldata is exactly the plan's `0x03ba33a4…`.
- **Not handled here:** `acceptOwner`, which is the Enclave admin wallet's (the wallet worker does it).
- **No arbitrary inputs:** no option or config can change the target, function, arguments, value or caps. The library
  refuses a config that differs from `PRODUCTION`; only the operator address, the RPC URLs and the polling may differ,
  and those for tests only.
- **Untouched:** contracts, the v2 committee/policy and the book.

**Pinned (checked at ONE block that both RPCs agree on).** `mainnet.base.org` and `base.public.blockpi.network`; any
disagreement or RPC error refuses, and an error is never read as "absent".
- Chain 8453.
- `EnclaveHostOwnership` runtime keccak `0xe38a0e16…`, and its `registry()` = `0x868eb7fc…` (registry code non-empty,
  hash recorded and re-checked at send).
- metal0's schema-4 entry:
  - active;
  - operator = `0xc9d0…`;
  - payoutWallet = `0x0b2d…` (owner and vault seat flag agree);
  - endpoint `https://api.enclave.host/t/metal0`.
- `authority(metal0)`:
  - owner 0 and pending 0 → ready;
  - pending `0x0b2d` with this tool's verified journal → done;
  - owner `0x0b2d` → already accepted;
  - anything else refuses.
- **The operator's code is EXACTLY the existing EIP-7702 delegation** `0xef0100‖0x8900baca…` (keccak `0xe2f1317f…`). The
  target's runtime keccak is `0xdd893cd4…` (`work/lease-enrollment-signing/trust.mjs`). A plain EOA, another target or
  other code refuses. The transaction never re-delegates (type 2, no authorization list).
- Nonce: agreed-block = latest = pending on both RPCs.
- The exact call simulates successfully; `eth_estimateGas` from both.
- **Fees and caps:**
  - gas = max estimate × 1.25 ≤ **150000**;
  - maxFee = 2 × base + max tip ≤ **0.1 gwei**;
  - **L1 data fee:** `GasPriceOracle.getL1FeeUpperBound(size)`, sized from the EXACT transaction (its real nonce, e.g.
    23759, not 0):
    - the oracle adds 68 signature bytes and assumes the worst fastlz case;
    - the code passes `max(unsigned, signedMax − 68)`, where `signedMax` is the encoding with yParity 1 and r = s = 2^256−1;
    - any smaller argument refuses (`l1_size`). The previous nonce-0 sizing passed 2 bytes too few and missed the
      signed maximum by 1 byte;
  - **Operator fee:** the oracle's own `getOperatorFee(gas limit)` (Isthmus predeploy; non-decreasing in gas used, so the
    gas limit bounds it). If `isIsthmus()` is not true, or either call fails or the RPCs disagree, the operator fee is
    undetermined and the plan and the send refuse (`operator_fee`). Sending stays blocked rather than claim a bound;
  - **Cap:** `fees.totalAtBlockWei` = L2 cap (gas × maxFee) + L1 bound + operator fee ≤ **0.000005 ETH** (cap unchanged).
    These are bounds at the agreed block's oracle parameters; `--send` re-reads them fresh. Later L1-fee or
    operator-parameter changes before inclusion are not covered;
  - balance ≥ that total (checked at send; prepare reports the exact funding gap).

## Commands (from this directory; `npm ci --offline --ignore-scripts` first)

```sh
# 1. prepare (default). Chain reads only; NO key. Writes prepared/<planHash>.json (public) and prepared/current.
node bin/operator-propose.mjs
# -> {"status":"prepared","planHash":"0x…","plan":{… "observed":{… "balanceSufficient":…,"fundingNeededWei":…}}}
#    Review plan.tx (nonce, gas, fees) and observed. If balanceSufficient is false, fund first (the approved
#    0.000005 ETH), then prepare AGAIN: a plan is valid for 1 h and only while its nonce and fees still hold.

# 2. send (explicit). It re-runs every check fresh. Only then does it read registryKey from
#    /home/steven/Projects/enclave/metal/config.json, derive the address (must be 0xc9d0…), sign the prepared fields,
#    journal, broadcast to both RPCs, and verify.
node bin/operator-propose.mjs --send --plan-hash 0x<prepared/current> --broadcast-propose-owner

# 3. after an "unknown" outcome, a timeout or a crash. NEVER signs; reads the journal's bytes.
node bin/operator-propose.mjs --resume --plan-hash 0x<h>               # checks the chain only
node bin/operator-propose.mjs --resume --plan-hash 0x<h> --rebroadcast # re-sends the SAME bytes, only while the nonce
                                                                       # is unused on both RPCs
node bin/operator-propose.mjs --status --plan-hash 0x<h>               # journal, public fields
```

Exit codes:
- 0: prepared, verified, accepted, proposed, or a status read;
- 2: refused (`{"refused":code,"message"}`);
- 3: unknown, pending, conflict or failed;
- 64: usage;
- 1: other error.

**Order with the funding.** Prepare once to read the exact `fundingNeededWei` and fee. Fund. Prepare again. Send within
the hour.

## Journal and outcome rules
- `journal/` is 0700; `journal/<planHash>.json` is 0600. It holds the signed raw transaction and its hash, written to a
  temp file, fsynced, linked exclusively and dir-fsynced BEFORE any broadcast. If the write fails, nothing is broadcast.
- Once any journal record exists, `--send` refuses: this tool never signs a second transaction. Unknown outcomes,
  timeouts, rejections and crashes go through `--resume`, which uses only the journaled bytes.
- `conflict` means the nonce was consumed by another transaction and this one never landed. It is final: nothing is
  re-signed, so root decides. There is no automatic replacement or fee bump.
- **Verified requires all of:**
  - both RPCs return the receipt with the same block hash and status 1;
  - at least 2 confirmations on both;
  - the mined transaction's from, to, value 0, input, nonce and block are exact;
  - then, at an agreed block at or after it, `pendingOwner = 0x0b2d` with owner 0, or owner `0x0b2d`.
- **Output:** the plan hash, tx hash, broadcast results and receipt summary only. The key is never printed, and a
  key-read error is replaced by a generic refusal. The raw signed transaction exists only in the private journal.
  `prepared/` and `journal/` are gitignored.

## Tests (`node --test test/proposer.test.mjs`; all through `work/claude-test-queue.py`, 256 MiB)

**Setup:** a two-RPC fake of Base (`test/helpers/fake-base.mjs`).
- It decodes signed transactions, recovers the signer and applies `proposeOwner` as the contract does.
- Tests use a fresh test key and a temp directory; no network, and the production key file is never read.
- The fake cannot hold the deployed ownership and executor bytecode, so a test-only `codeHashOf` seam maps the fake's
  code to the pinned hashes. The CLI never passes it, and the 7702 designator is always hashed with keccak256.

**Results:** 15/15, peak 196-205 MiB.

**Coverage:**
- the constants vs the public plan;
- un-configurable targets;
- wrong ownership code, registry, host entry (inactive, operator, payout, endpoint, registry code);
- authority (another owner, another pending, unverified pending, already accepted);
- operator code (delegation removed, re-delegated, other code, executor runtime changed);
- RPC disagreement and errors;
- fee, gas, L1 and total caps;
- L1 sizing with the real nonce (23759: 2 bytes more than nonce 0) and the maximum signed encoding (+67); nonce-0 or
  unsigned-only arguments refused;
- the operator fee for the gas limit in the total; refusal when undetermined (not Isthmus, reverting, RPC
  disagreement) at prepare AND at send (before any key read); refusal when it pushes the total over the cap;
- unsettled nonce;
- send refusals before any key read (flag, wrong or non-current hash, stale or tampered plan, moved nonce, fees, balance,
  authority);
- a wrong key;
- the journal written before broadcast (mode 0600/0700, same bytes to both RPCs) and verified, never twice;
- a journal write failure;
- a crash, then restart and rebroadcast of the same bytes;
- an unknown outcome that landed;
- a rejection, then a nonce conflict;
- rebroadcast refused while the RPCs disagree on the nonce;
- receipt disagreement, confirmations and a revert;
- CLI flags.

**Mutants (one change each in `lib/proposer.mjs`; the suite must fail; all 9 do):**
- broadcast before journal;
- sign twice;
- no conflict detection;
- unsettled nonce accepted;
- one RPC wins;
- rebroadcast at any nonce;
- key read before checks;
- any operator code;
- any executor code.

## Limits
- **Fresh state is at the agreed block** (latest − 2) and the RPCs' "latest/pending". A transaction from another holder of
  the operator key between the check and the broadcast is caught only as `conflict` afterwards.
- **The 7702 delegation stays executable.** Root says normal outgoing EOA signatures remain valid, and this tool does
  not change the delegation. Nothing here inspects the executor's storage.
- **The fake is not the chain.** These tests prove the tool's logic, not the live contracts. Root's preflight and the
  plan's 2-RPC simulation are the live evidence.
- `acceptOwner` (the admin wallet), the funding transaction and the canary custodian are outside this tool.
