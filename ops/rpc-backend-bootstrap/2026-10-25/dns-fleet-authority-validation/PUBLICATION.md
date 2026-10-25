# DNS-relay fleet reads through the relay chain authority: validated source (root r3 PASS 28/28); NOT deployed, NO cutover

## What changed (product)
- **Commit:** root committed this change to `relay-consumer-source` as **`bf77da364`** ("Route DNS fleet reads through the
  selected relay chain authority"). The GitHub push was in progress at publication time (`root-push-dns-consumer-2311`).
- **Byte-identity:** the 4 published candidate files are byte-identical to that commit (sha256 checked against
  `git show bf77da364:<path>`).
- **Base:** `e78a764d1df935fbc74b27348b82115803b885ce` (`source/base/`, `source/BASE`).
- **`relay/fleet.mjs`:** a single `chainClient()` serves both client sites (the registry/book reader and the
  deployments/runner ledger reader).
  - It uses an injected `cfg.chainClient` when one is given.
  - Otherwise it uses the legacy `BASE_RPC` client, unchanged (default `https://mainnet.base.org`).
- **`relay/dns-relay.js`:** `relayChainAuthority(process.env)` from the generated network runtime bundle.
  - Unset gives the legacy path.
  - `ENCLAVE_CHAIN_AUTHORITY=verifier` injects the ONE local-verifier client.
  - A mixed or invalid selection (e.g. `BASE_RPC` set) is fatal at startup, before any listener.
- **Patch:** `source/patches/consumer-remaining.r2.patch`, 4 files, `4f7f7d36…`. History is kept alongside: the r1 patch
  `6f5ae99e…` and the r1 test.

## Actual results (root r3, `evidence/root-r3-2309-pass/`, rc 0, cap 512, peak 264 MiB)
- **Tree verification:** **8481** tracked source entries (9 symlinks) were verified exact by content/target, both pre and
  post. That covers 2 overlaid files, 2 added tests, 2 `node_modules` links, and (post) the 2 generated files; 0 failures;
  `execBitMismatch` 0.
- **Bundle:** built in the private tree. sha256 `36cc949f0eb7cf5969e5b74b25f5d39bf4574bf8ee9c2bc4f699a7c8fb89a189`. **Only
  its manifest and hash are published** (`run/network-runtime.bundle.mjs.manifest.json`, `run/bundle.sha256`), not the
  binary.
- **Tests: 28/28 pass, 0 failed, 0 skipped, 0 todo, 0 cancelled.**

  | suite | result |
  |---|---|
  | `test/fleet.test.mjs` (unchanged baseline) | 7/7 |
  | `test/relay-chain-authority.test.mjs` (unchanged) | 11/11 |
  | `test/relay-fleet-chain-authority.test.mjs` (new) | 6/6 |
  | `test/dns-relay-chain-authority.smoke.test.mjs` (new, real generated bundle) | 4/4 |

## What the tests establish, and what they do not
**Established**
- **Injected authority:**
  - Registry, address-book and deployments-ledger reads go through the injected authority.
  - **No public RPC is contacted** (`fetch` spy).
  - **No public fallback**, either at startup or during an outage after a healthy refresh.
- **Startup outage:** the fleet is **empty** (no routing, no operator answers).
- **Outage AFTER a healthy refresh (inherited, unchanged `fleet.mjs` behaviour):** this is **not fail-closed for an
  existing fleet.**
  - The **last known fleet is kept indefinitely**, with no expiry; `origins()` and `operatorForEndpoint()` keep the
    pre-outage answer.
  - The ledger runner answer is cached for **10 s**, then `null`.
  - The last known book addresses are kept.
- **Real `dns-relay.js` + real generated bundle, loopback only:**
  - **mixed** verifier + `BASE_RPC` → exit 1 (`fatal: chain authority …BASE_RPC`), with no listener and no chain request;
  - **clean verifier** → the registry `count()` read reaches the local verifier and the daemon stays up;
  - **legacy** → the same read reaches `BASE_RPC`.
- **Legacy default:** unchanged.

**Not established**
- **Proof and finality:** the fake verifier and mocks prove nothing about proof or finality. The local verifier's own
  properties (sequencer-signed **unsafe** tier, no L1 finality, logs prove inclusion only) are separate.
- **Untested paths:**
  - viem ABI decoding of real registry/ledger rows;
  - the app-challenge, attested and read-only `dns-relay` modes;
  - `fleet.mjs` users outside this repo;
  - any other `dns-relay` startup read of a public default. Such a read would just fail inside `unshare -rn`; no
    assertion catches it.
- **No deployment, live check or cutover.**

## Failure history (kept)
**`evidence/root-r2-2300-failed/`: harness failure (exit 2) before the bundle and tests.**
- **The cause is file modes, not a read-only tree.** `git archive` writes tar modes **664/775** (default `tar.umask`
  0002). The tree was extracted under umask **022**, giving **644/755**. `tar -d` reported "Mode differs" for every
  entry, and r2 filtered only Uid/Gid.
- **The tree was not read-only.** The earlier read-only assumption was incorrect.

**Fix (r3 harness, `jobs/verify_tree.py` + `jobs/tree-pins.json`).**
- Content and symlink-target verification of every tracked entry against `git ls-tree`/`cat-file` of the pinned rev.
- Exact allowances for the overlay, the added tests and the links; any other file fails.
- Permission bits are deliberately not compared.

**`evidence/claude-prechecks-not-root/`: Claude's read-only verifier runs. NOT root evidence.**
- A clean `pre` run.
- 3 tampered-pin negatives, all rc 1.
- The first attempt deadlocked in `git cat-file --batch`; fixed with a writer thread before root's run.

## Contents
- `source/`: base, candidate and patches.
- `jobs/`: `root-dns-review.sh`, `verify_tree.py`, `tree-pins.json`, `stage-MANIFEST.sha256`.
- `evidence/`: root r3 pass, root r2 failure, Claude pre-checks.
- `reports/`:
  - `claude-consumer-remaining-audit-result.md`: the bounded, read-only source inventory of remaining public-RPC
    consumers (site, mobile, bootstrap, API relay);
  - `claude-consumer-dns-review-result.md`;
  - `claude-consumer-dns-harness-repair-result.md`.

  Earlier status lines in these reports (e.g. "not run") are superseded by this file.
- `SHA256SUMS`.
- **Excluded:** no bundle binary, no `node_modules`, no build cache, no full tree, no git objects.

## Deployment prerequisites (none claimed met)
1. **Own Base node and verifier:** the node is synced, the A2–A4/bytecode gates are closed, and the local verifier is
   qualified on it.
2. **Bundle and deploy:** a reviewed bundle build for the deployment, then deploy `dns-relay` with:
   - `ENCLAVE_CHAIN_AUTHORITY=verifier`;
   - a loopback `ENCLAVE_CHAIN_VERIFIER`;
   - `BASE_RPC` and all other provider settings unset.
3. **Live checks:**
   - the startup log;
   - zero connections to public RPC hosts;
   - stop the verifier and confirm no fallback.
4. **Operator decision:** accept or change the inherited stale-fleet behaviour.
5. **Remaining consumers** are listed in the audit report (site, dashboard, credit page, API relay location, Windows,
   custody v2). Custody v2 verifier mode stays refused.

## Publication annotation

The source copy and patch add a `gitleaks:allow` comment only on the fixed synthetic DNS smoke-test value. This is not a credential and is used only by the isolated local test daemon. The tested and committed runtime/test source is `bf77da364`; its original hashes remain in the test evidence. The publication-only comment does not change test behavior. No scanner was disabled.
