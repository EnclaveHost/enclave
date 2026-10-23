# linux-rpc-consumer-closure: RESULT

(Finished 2026-10-23T18:45:13Z from `date -u`. Every time below is a git committer date or a queue-log time, all measured.)

**Status:** committed **source**, with tests on the final source.
- Nothing was deployed, pushed, imaged or measured.
- No SSH, production, VM restart, wallet, funds, contracts, mainnet writes, sync, disk or cache allocation.
- Other trees (E, A, F, P, S, D, root) were only read.
- **This is not provider independence in production:** that needs the production prerequisites in §7.

## 1. Source

- **Base:** root-accepted `673601e54f8fdcf2ea72d239c87d92b483ff231b` (tree `ea4b9cac`), branch
  `linux-rpc-consumer-closure`.
- **Final:** **`c08532b28238a24f517db1beb3b12614abd05a6c`** (tree `b578d56b81b16deeb62c239a4dab049a0c982ead`).

Commits (author and committer SteveDeFacto, on 673601e54):

- `1a6559a78` 2026-10-23T06:04:42-07:00 Legacy-identity test: compare gsup's legacy launch with the reviewed base, not with HEAD
- `70c6c2b81` 2026-10-23T06:04:59-07:00 Chain authority: a host's chain reads through its local verifier, submissions through its own backend, nothing else
- `03d504f49` 2026-10-23T06:05:08-07:00 Supervisor on the local verifier: every chain read, receipt, nonce and submission through the selected authority
- `6db741fbd` 2026-10-23T06:05:16-07:00 Direct control guests: the local chain verifier as a HOST_DATA-bound config member, started before the direct supervisor
- `502a93ee4` 2026-10-23T06:05:25-07:00 Rebuild the guest bundles whose inputs changed (existing builders, unchanged settings)
- `675a1a17b` 2026-10-23T10:32:50-07:00 Chain authority: what the end-to-end runs found on the real verifier
- `d2965749a` 2026-10-23T10:33:01-07:00 Tests: app-funded leases on the local verifier end to end; two test-environment fixes
- `98206e643` 2026-10-23T11:31:34-07:00 Chain authority: estimateGas answers a gas limit a verified execution succeeded with
- `c08532b28` 2026-10-23T11:31:34-07:00 Consumer E2E: the supervisor on the local verifier and own backend, with public origins recorded

## 2. What closes (the provider dependencies root named)

1. **The supervisor's own reads and writes** (claims, leases, receipts, nonces, renewals, releases, registry, settlement,
   prices, sessions, moderation, the admin AddressBook). Once the operator selects the local verifier, every one goes
   through `network/chain-authority.mjs`:
   - proven reads come from the local verifier, on the unsafe tier;
   - submission, the pending-pool nonce and fee hints go only to the operator's **own** Base backend (a loopback or
     private literal), bound to the verifier's chain before every send;
   - every other method refuses by name;
   - `BASE_RPC(S)` and the public defaults are never contacted.

   Before anything is signed, a fresh-head gate runs. App-funded lease reads and the owner nomination use the same
   **one** authority: never a quorum of aliases, and never mixed with RPCs. The full path inventory is in
   `docs/network/supervisor-chain-authority.md`.
2. **Direct control guests.**
   - `chainVerifier` is now a HOST_DATA-bound member of the direct config. Absent, every earlier digest is unchanged;
     its port is in 50000..57999, distinct from every other port.
   - `planDirectBoot` refuses to boot if the image lacks the runtime.
   - gsup's direct branch starts the verifier before the direct supervisor, whose authority names come only from that
     member.
   - The MCP adapter's profile gets the same verifier, and the statement names the runtime record.
   - The direct controller's identity and admission are unchanged, with no relay.
   - Both image builders already carry `chain-verifier.mjs` and the runtime closure (previous round), and copy staging
     is kept.
3. **The two baseline regressions:**
   - the MCP bundle was rebuilt with its builder (#26 passes);
   - the legacy-identity test now compares with the reviewed base `7752a423`, an asserted ancestor, instead of `HEAD`.
     The invariant holds byte-for-byte, and no expected text was changed (#63 passes).

4. **A defect found by the end-to-end test: the gas estimate.**
   - The pinned Helios answers `eth_estimateGas` with the gas *used after refunds*, and answers even for a failing
     call. With that limit, every operator `release` failed on chain (4 of 4).
   - The authority now searches the limit with verified `eth_call` executions at one numbered block. The answer is
     always a limit at which a verified execution succeeded (within 1.5% of the least), and a failing call answers with
     its revert.
   - Commit 98206e643. Unit #5 fails on the old code with "the limit 41600 succeeds (needs 52000)".
   - After the fix, the lost-answer + restart release case lands once.
5. **`eth_getTransactionByHash`** is routed to the verifier (the transaction from its validated block body), because
   the app-funded receipt check needs it. Without it, an app-paid landing was never verified.

**Trust labels (exact):**
- **Unsafe tier (sequencer-signed head chain):** everything. No supervisor path asks for safe or finalized, and none is
  claimed. L1 finality would come from E's in-process full-node adapters, which are not needed by any decision here.
- **Logs:** inclusion only.
- **Receipts:** checked against the receipts root. "Not found" is not evidence of absence; a release is decided by the
  proven nonce.
- **Gas limits:** searched over verified executions (above). Fees are the own backend's hints, so they affect cost,
  never validity.
- **The own backend:** submission and hints only, never state.

## 3. Remaining gates (precise, not closed here)

- **G1, payment events.** `pollPayments` relies on `eth_getLogs` completeness. A withheld `Paid`/`PaidEth` log cannot be
  detected, so a deployment would stay awaiting payment: a denial, never a forgery or double credit. The forwarder keeps
  no per-payment state to read instead. Closing it needs a log-completeness proof or a state-bearing payment record.
- **G2, finality.** There is no L1-final tier for receipts on the Linux host. It is not required by any supervisor
  decision; E's `createBaseNodeSource` + `createL1PairSource` are the route, with in-process evidence.
- **G3, submission.** Submission still goes through the operator's own Base node to the sequencer. E's forced-inclusion
  path is separate and not app-funded.
- **G4, platform API member.** The platform API member's `relayEnv` chain authority is the same on every member, so it
  is not per host: the owner sets it, as before.
- **G5, direct committed claim.** A committed `guestBootstrap` claim in a direct guest was not exercised end to end; it
  needs a direct-bootstrap guestd stand-in (§5).

## 4. Tests (all through `work/claude-test-queue.py`, in `unshare -r -n`; public origins recorded and refused)

Every run below went through `work/claude-test-queue.py` (16 GiB floor) and `jobs/tests.sh`, which runs them in
`unshare -r -n`: an empty network namespace, with external reachability checked unreachable first. The E2E runs used the
real pinned runtime (`rpc-runtime-final-integration/bin-release`), the reth `--dev` chain with the EIP-2935 genesis
(`test/fixtures/reth-dev-8453-genesis-2935.json`), and the actual `supervisor.js`. Public origins were recorded by a
preload, and any non-loopback attempt fails the case. The only exceptions are the supervisor's existing DNS-over-HTTPS
resolvers (`cloudflare-dns.com`, `dns.google`), which are listed apart: they are its DNS layer, not a chain provider.

**On the final source `c08532b28` (clean tree):**

| run | files | result | peak RSS | time |
|---|---|---|---|---|
| `e2e-consumer-final` (cap 1408) | `test/chain-consumer-closure.e2e.test.mjs` | **7/7** | 1132 MiB | 325 s |
| `e2e-leasegas-final` (1408) | `test/lease-gas-verifier.e2e.test.mjs` | **4/4** | 847 MiB | 171 s |
| `unit-final2` (1024) | chain-authority, owner-nomination, supervisor-wallet-real-lease-client, supervisor-wallet-unknown-hold, lease-gas-runtime, chain-verifier-guest | **61/61** | 529 MiB | 165 s |
| `bundles2` (768) | `tools/bundles.sh`: the builders, then every `--check` | the regenerated bundles are byte-identical to `502a93ee4`'s (no bundle embeds the authority module) | 447 MiB | |

What the consumer E2E shows, case by case (provider RPC and public origins never attempted in cases 1–5 and 7):

1. **Relay mode.** The host registers, claims and adopts on the **verified** claim receipt, then renews. Every write goes
   through the own backend. `/v1/health` reports `local-verifier`, the `unsafe` tier and inclusion-only logs.
2. **Proof-source outage.** New claims refuse and nothing is submitted, while the running app keeps serving. A
   **restart during the outage** keeps it (serving-first, chain-backed). Claims resume once proofs return.
3. **The release's answer is lost** (it reached the chain), then the process is killed and restarted. The restored
   intent is resolved from the verified receipt and nonce. **Exactly one** release was submitted, and one `Released`
   event emitted.
4. **Owner veto** (an on-chain policy hash plus the policy document) means the denied deployment is never claimed.
   **Admin delisting** (catalog `setActive false`) means the serving app is stopped. Both are decided on verified reads.
5. **Admin AddressBook migration** reaches a verifier host with no provider (book polling, not frozen pins).
6. **Positive control.** The same recorder sees the public defaults that a legacy host attempts, so the empty lists in
   the other cases mean something.
7. **Direct mode.** The supervisor is started with `planDirectBoot`'s environment for a bound `chainVerifier` and reads
   only through the verifier. An uncommitted deployment is refused (G5: no committed bootstrap claim).

The app-funded E2E covers:
- the one-authority lease reads;
- a claim through the real relay, verified and charged once to the app's reserve;
- a lost relay answer plus a restarted client: resolved as landed, nothing posted twice;
- no proof source: refused before anything is signed or posted.

**Negative controls:**
- `ca1neg`: the new unit #5 on the previous authority fails with "the limit 41600 succeeds (needs 52000)".
- Before the estimate fix, the same E2E case 3 failed with 4 of 4 releases at status 0 (`dbg6`, on `d2965749a` +
  the E2E).
- Before `eth_getTransactionByHash` was routed, the app-paid landing was never verified (`e2e-leasegas2`).

**Earlier runs on intermediate states** (not repeated where the final source does not change them):

| run | state | result | peak |
|---|---|---|---|
| `unit-a` (768): chain-authority, chain-verifier-guest, metal-measured-control, lease-gas-runtime, lease-authority, lease-authorization-nonce, owner-nomination-config/-journal, relay-policy-carriers, metal-lease-gas-conduit, mcp-guest-bundle, **mcp-hosted-control (#26)**, platform-api-config | 673601e54 + this work, before commit | 100/101. The only failure (#9) used a fixture image without binaries; it now reads the committed `metal/chain-verifier-image.json` and passes in `unit-final2` (#10). #26 (MCP bundle) and the legacy-identity test pass | 626 MiB |
| `wallet-head` (1024): supervisor-wallet-real-lease-client/-unknown-hold/-policy | 502a93ee4 | 33/33 | 204 MiB |
| `nom-base` (1024): owner-nomination | **the 673601e54 baseline** | 9/10. #8 fails on the baseline too: root in the user namespace ignores `chmod 0500`. Fixed in the test (the state path's parent is a regular file, so ENOTDIR), and passes in `unit-final2` | 510 MiB |
| `e2e-leasegas3` (1408) | before the estimate fix | 4/4 | 853 MiB |
| `diag6b` (1408, not committed) | reth chain with the 2935 genesis | every block and receipt (head, ancestry, and the transaction block) validated by the pinned Helios; the earlier head-2 failure was transient at startup | 809 MiB |

**Pre-existing `--check` failures** (both also on the 673601e54 worktree; not rebuilt here, handed off):
- `build-windows-lease-runtime.mjs`: "Windows shared lease bundle is stale" (F);
- `build-host-service-packages.mjs`: "directory-replica.mjs is stale" (host-services composition).

## 5. Not proven

- No SNP/VM boot.
- No mainnet.
- No real proof source or real own Base node: the backend is a recording proxy in front of the local chain.
- The sequencer key is a test key.
- Direct mode is shown up to proven ledger/registry reads and the refusal of an uncommitted deployment; a committed
  bootstrap claim was not run.
- The Windows node is F's.

## 6. Activation and rollback recipe (root executes; nothing here does it)

1. Review and pick `c08532b28238a24f517db1beb3b12614abd05a6c`. It is a new image measurement: build per the previous `RECIPE-IMAGE.md`, with this
   commit and `--chain-verifier-dir`.
2. **Prerequisites, all production- or hardware-side:**
   - the operator's own Base node (base-reth + base-consensus), reachable from the guest at a loopback or private
     literal (for a guest, the host link `10.0.2.2:<port>`), and synced. For the L1 pair, see S's holder package and P's
     L1 pair;
   - at least one reachable proof source (the same node can serve proofs);
   - the administrator's sequencer pin;
   - an allowlist entry for the new measurement.
3. **Relay mode:** add `"chainVerifier": {..., "txBackend": "http://10.0.2.2:<port>/"}` to the host's `config.json`
   and relaunch the guest.

   **Direct mode:** add the same member to the owner's bound direct config. This changes the config digest and HOST_DATA,
   so relaunch with the new config.
4. **Watch:**
   - the `[chain] authority: local verifier ... own backend` line;
   - `/v1/health` `chainAuthority.lastGate.ok`;
   - claims and renewals landing; no non-loopback provider traffic.
5. **Rollback:** remove `chainVerifier` (in direct mode, the previous bound config, i.e. the previous HOST_DATA) and
   relaunch. The supervisor returns to its provider pool, unchanged. No contract or wallet state changes.

## 7. What is still needed for production independence (pending)

- A synced own Base node: the HDD/RAM decisions are open (S, P).
- Own proof serving.
- Human authorization for the NucBox placement and restart.
- G1 if payment-event completeness is required.

## 8. Handoffs and export

- `handoff/HANDOFFS.md`: F (shared lease modules, the Windows bundle not rebuilt), A, P, S, E, D.
- `exports/`: source-only patch series for D, 9 patches with `SHA256SUMS`. `git am` on 673601e54 reproduces the head
  tree `b578d56b` exactly (checked in a scratch worktree, then removed).
- **Scans** (`jobs/scan.sh`, queue 256):
  - `.githooks/scan-crypto-keys.py --range 673601e54..HEAD`: rc 0.
  - `gitleaks git` over the 9 commits: no leaks.
  - `gitleaks dir` on RESULT.md, handoff, tools and lineage: no leaks.
  - `gitleaks dir` on `exports/`: 15 findings (14 `generic-api-key`, 1 `coinbase-access-token`). All are in patch 0005,
    in the `*.bundle.mjs.manifest.json` hunks: each is a file's SHA-256 digest, keyed by a path whose name contains
    "secret", "key", "auth" or "coinbase". They are false positives. `gitleaks git` (added lines only) finds nothing.
- `INVENTORY.json`.
