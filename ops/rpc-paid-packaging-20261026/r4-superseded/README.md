# paid-derived-adapter-stage

This stage gives paid wg-provider sends finality at L1-finalized derived Base blocks. It is an explicit opt-in, `cfg.paidFinality: "derived"`, and it is NOT production-verified.

## Frozen contents (`SHA256SUMS` covers everything the job reads)

| file | what |
|---|---|
| `patches/paid-derived-adapter.patch` | The minimal patch: 8 files. The 4 changed files are `onchain-qualification.mjs` (+6/-3), `wg-provider/attested-authority.mjs` (+46/-6), `wg-provider/attested-submission.mjs` (+4/-3) and `wg-provider/main.mjs` (+32/-8). The 4 new files are `wg-provider/derived-submission.mjs`, `wg-provider/derived-anchor-floor.mjs`, `network/op-receipts-root.mjs` (vendored, `36c34dad…`) and `test/paid-derived-adapter.test.mjs`. |
| `BASE-PINS.txt` | Baseline blobs of the 4 changed files. Baseline is `rpc-final-candidate-20261026/tree` at HEAD `64156dcd91ff1e769e74f9c26a846be19254c716`. |
| `PATCHED-PINS.sha256` | sha256 of the 8 patched files (the reviewed bytes). |
| `INPUT-PINS.sha256` + `inputs/kvm/` | The KVM reader at commit `c66b087acca2bed00e0232f97f990a201852faea`: `git archive` of `network/derived-reader/**` and `network/lifecycle-finality-bridge.mjs` only. No lifecycle contracts. |
| `inputs/receipts/` | `op-receipts-root.mjs` `36c34dad…` (finality-stage/op-receipts-root: 35/35 tests and 14/14 mutants on real Base vectors). |
| `inputs/kvm.prestaged-0336/` | The earlier uncommitted snapshot. Kept for provenance only and not used. |
| `jobs/paid-derived-adapter-tests.sh`, `jobs/mutants.json` | The root job (12 mutants). |
| `config/*.example.json` | Executable provider configurations (local-verifier executor, attested-verifier executor). |
| `receipts/` | Every queue receipt so far, failed ones included, with `RECEIPTS.tsv`. None of them qualifies the current freeze. |

## Root-owned commands (Claude has NOT run these on the current freeze)

```sh
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh paid-derived-adapter-r4-quick   512 unshare -Urn bash paid-derived-adapter-stage/jobs/paid-derived-adapter-tests.sh quick
bash jobs/q-exit-status.sh paid-derived-adapter-r4-mutants 512 unshare -Urn bash paid-derived-adapter-stage/jobs/paid-derived-adapter-tests.sh mutants
bash jobs/q-exit-status.sh paid-derived-adapter-r4-full    512 unshare -Urn bash paid-derived-adapter-stage/jobs/paid-derived-adapter-tests.sh full
```

What the job does:
- It refuses to run if any of these is off: network routes present, `SHA256SUMS`, the input pins, baseline HEAD or the base blobs.
- It composes `git archive` of HEAD with the pinned KVM inputs, twice: once **pristine** and once **patched** (the patch applied, then checked against `PATCHED-PINS`).
- node_modules are symlinks to the baseline tree's.
- Each node test file has a 420 s bound. Outputs go to `runs/<ts>-<mode>-<pid>/` (`verdict.json`, `logs/`), and the composed trees are removed afterwards.

PASS criteria, per mode:

- **quick:**
  - `test/paid-derived-adapter.test.mjs` passes **15/15** with 0 fail, skip, todo or cancelled.
  - Five regression files run pristine and patched with identical counts: stack-provider-authority, attested-provider-collateral, wg-provider, paid-network, verified-chain. The last root-reviewed run (quick-2, older bytes) gave 4+8+10+5+9 = 36 on each side.
  - The actual entrypoint `node network/wg-provider/main.mjs --check-config` must give:
    - patched/valid: exit 0, printing `"paidFinality":"derived"`;
    - patched/no-optin: refuses with `derivedFinality is set but paidFinality is not "derived"`;
    - patched/quorum: refuses with `needs a proof executor`;
    - patched/public-history: refuses with `historyUrl: must be a loopback or private IPv4`;
    - pristine/valid: refuses with `txBackend is only used with chainAuthority "attested-verifier"`. This is the control showing that the baseline lacks the mode.
- **mutants:**
  - The unmutated new suite must pass 15/15 first. A failed baseline invalidates the run.
  - Then each of the 12 mutants in `jobs/mutants.json` must be killed: the file loads, 15 tests run, and at least one fails.
  - Each mutant removes one check, in this order: tx-root, ancestry hash, receipts root, consumed-nonce off-chain hint, journal gap at the proven nonce, nonce-consumed reported as success, foreign-pending gate, pending costs, duplicate call, backend binding hash, journal-load gap, lost-bytes re-broadcast.
  - `nonce-from-backend-pending` was dropped: under the equality gate it is equivalent by construction.
- **full:** quick, plus four anvil-backed suites: service-index, attested-paid-provider, attested-route-composition and attested-chain-verifier. They use `~/.foundry/bin/anvil`, which is a prebuilt binary, not a build. quick-1 showed service-index with two anvils reaching 521 MiB, which hit the 512 MiB cap. If full trips the guard, root decides the cap. The floor is never bypassed.

## Entrypoints and executable configuration

- **Process:** `node network/wg-provider/main.mjs /etc/enclave-network/provider.json`. Under `paidFinality "derived"` it does three things:
  1. starts the in-process reader `runDerivedReader(readerConfig)` from `network/derived-reader/main.mjs` (`derivedFinality.readerConfigFile`, which is KVM's config: `config.example.json` for v2, `config.v3.example.json` in KVM's uncommitted v3, same shape). Its loopback witness API is for the untrusted witness producer only and is never authority;
  2. opens the anchor floor `openDerivedAnchorFloor(floorFile || <stateDir>/derived-anchor-floor.json)`;
  3. builds `createDerivedSubmitter`. Its executor is `cfg.chainVerifier` (local loopback verifier) under `chainAuthority "verifier"`, or the branded attested client under `"attested-verifier"`. Broadcast goes to `cfg.txBackend` only. History comes from `derivedFinality.historyUrl` (private read-only eth source) if set, otherwise from the txBackend's eth namespace.
- No paid read or send uses `cfg.rpc` under derived mode. RPC clients are built only on the `rpc` send path.
- **Backend methods:**
  - broadcast backend: `eth_chainId`, `eth_getBlockByNumber`, `eth_getTransactionCount(pending)`, `eth_maxPriorityFeePerGas`, `eth_sendRawTransaction`;
  - history source: `eth_chainId`, `eth_getTransactionReceipt` (hint only), `eth_getBlockByNumber(M, true)`, `eth_getBlockReceipts`.
  - No `debug_*`.
- **Examples:** `config/provider.derived-local-verifier.example.json` (the job `--check-config`s a copy of it) and `config/provider.derived-attested-verifier.example.json` (needs real replica, collateral and measurement values; not checked here).

## Checks preserved and added (unchanged code paths elsewhere)

- **Derived anchor:** the KVM bridge requires all of the following, and the adapter re-checks the bridge's evidence tier, authority and hash:
  - tier `l1-finalized-derived`, with outputRoot, stateRoot and hash present;
  - the age bound (`maxAnchorAgeSec`);
  - the durable floor (no rollback or same-height contradiction);
  - the executor's header at the derived number equal to the derived hash, state root and timestamp, before and after the read.
- **State:** every eth_call, balance, nonce and storage read is pinned to `{blockHash: derived hash}`.
- **Backend binding:** `keccak(RLP(backend header at B)) == derived hash`.
- **Receipt:**
  1. the block hash is proven at B through the EIP-2935 history slot `M % 8191` (or M = B itself);
  2. `keccak(RLP(header M))` equals that hash;
  3. each re-encoded body hashes to its hash;
  4. the bodies' trie equals `transactionsRoot`;
  5. `verifyBlockReceipts` passes: receipts trie = `receiptsRoot`, blooms, gas total, tx-hash binding;
  6. the signer is the operator.
- Controls, custody, lease writer, lease reader and host policy are untouched, and so is their freshness.

## Nonce journal: recovery and rollback limits

- **Durability:** `<stateDir>/onchain-send.json`, written with temp + fsync + rename + directory fsync BEFORE each broadcast.
  - 0 or 1 entries use the legacy single-record format, which `attested-submission` can read.
  - 2 or more use `enclave-provider-send-journal/v1`, which attested mode refuses ("settle it by hand"). So switching derived → attested requires at most 1 open entry.
  - Bounds: at most 1 MiB, `maxPending` 1..64 (default 8).
- **Ownership:** a kernel flock on `<stateDir>/onchain-send.json.lock` (`network/runtime-lock.mjs`, `/usr/bin/flock`). A second owner is refused. Never delete or replace the lock file.
- **Restart:** entries are checked for chain, nonce, signer and contiguity, then restored. Bytes the pool lost are re-broadcast unchanged, in nonce order. New signing waits until the pool holds them.
- **Refused (fail closed, settle by hand):** a gap inside the journal; a first open entry above the proven nonce; a pool nonce above P + own entries (an unknown external user of the key); a corrupt or foreign-signed journal or floor.
- **Not proven success:**
  - an entry whose nonce is proven used but has no provable receipt resolves "nonce consumed": either another transaction used it or the history showed none. That is never success;
  - a receipt more than 8191 blocks below the derived block is not provable here: same outcome.
  - A history location that contradicts the proven nonce refuses: off-chain, above B, or a block without the transaction.
- **Disk rollback:** an older journal or floor restored from backup is not detected by these files alone.
  - With the journal rolled back, a lost own transaction appears as foreign: pending → refused; finalized → its nonce is skipped and no success is claimed.
  - The floor is only as strong as the disk under it. As in KVM's README, rollback resistance needs the accepted domain's protected recovery floor.
- **Tradeoffs:**
  - Final success waits for derived L1 finality (about 15-30 min).
  - Simulation and balance are checked at B and ignore the effects of own pending transactions. The balance covers all pending maximum costs; dependent later transactions can still revert, and a revert is reported as reverted.
  - The max fee is the operator cap, because B's base fee is only a floor.

## Stand-in tests versus actual proof

`test/paid-derived-adapter.test.mjs` uses a STAND-IN reader (`readAnchor` that labels synthetic blocks `l1-finalized-derived`) and a STAND-IN executor (no Merkle proofs; branded programmatically for the attested cases). Its chain is synthetic but byte-exact:
- real signatures;
- keccak(RLP) headers;
- tx and receipt tries;
- deposits.

There was no real Base full-body vector offline for the body re-encoder. It proves the adapter's logic and refusals, NOT a derivation, an attested channel or Base consensus. Still pending:
- real positive Base derivation through the native reader (KVM: v3 `49f4d7e3…`, uncommitted, not used here);
- SNP image qualification;
- a live self-hosted RPC.

There is no claim of self-hosted RPC production.

## Composition note

The patch applies only to the candidate lineage (`64156dc`). Root source `3a0179647` (branch `fix/rpc-production-bootstrap-20261025`) is not its descendant (merge-base `5ca9e61dd`). It lacks the modules extended here (attested-authority, attested-submission, verified-chain, runtime-lock, chain-authority, the attested brand, the bridge), and its wg-provider sends paid transactions through `createWalletClient(http(cfg.rpc[0]))`. Composing it there needs root's choice of lineage. This patch is not rebased onto it.
