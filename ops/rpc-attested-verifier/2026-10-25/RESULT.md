# Attested chain verifier: source RESULT, round 2 (G1–G5 + root-review fixes)

**Scope.**
- Tree: `work/rpc-production-final-20261025/attested-verifier-source`, branch `fix/rpc-attested-verifier-20261025`, base
  `9fa02e1bc`. The change is uncommitted in the working tree.
- Not done: no commit, push, SSH, live access, key read, image build or bundle rebuild.
- Every test ran through `work/claude-test-queue.py`: 16 GiB floor, cap 1024 MiB, peak 581 MiB.
- Jobs and logs: `attested-verifier-stage/jobs`, `attested-verifier-stage/logs`.
- **Composition note:** the relay worker also changes `metal/guest/measured-control.mjs` in its own tree; root composes.

## Source delta

- **Diff:** `attested-verifier-stage/logs/attested-verifier-source-round2.diff`, sha256
  `a2fb6b14e0badbb66c37309db2bd04d67b661271d7607ca343333f67cf6573c5`. It is the tracked diff (10 files, +153/−28) plus 5
  new files.
- **Do not commit** the untracked `node_modules` symlink (a test dependency only).

| file | HEAD → new blob | change |
|---|---|---|
| `metal/guest/chain-verifier.mjs` | `755260cc4b` → `3762dd1fa5` | G1 `expose` only with `allowExpose` (bound direct path; `guestChainVerifier` forwards it), no `txBackend`; G2 private-literal http witness sources |
| `metal/guest/measured-control.mjs` | `9ac322aa53` → `385bc34732` | G1 verifier-only rules, checked FIRST (before member validation): refuses mcp, platformApi, nativeControl, leaseGas and ownerNomination members and a host registry key; the RPC env names point at `REFUSING_VERIFIER`; one filtered front route `/chain-verifier` (14 reads, bounded) |
| `metal/guest/gsup.mjs` | `b8e87cae70` → `f3e70c18ff` | passes the bound route to the front |
| `network/rpc-identity.mjs`, `rpc-runtime.mjs`, `witness-gateway.mjs` | `b3c3edd18a`→`3ea883ed15`, `2c2de5b3b7`→`9cd2defc3b`, `f6a18de33c`→`36edc420d4` | G2 `witnessSourceEndpoint` for witness sources only; `rpcEndpoint` unchanged |
| `network/lease-reader.mjs`, `network/verified-chain.mjs` | `d77dbf772c`→`ce157773ac`, `e55f0359eb`→`2a82925232` | G4 labels `attested-verifier`, `localProof: false` for client-built objects |
| `network/attested-verifier-brand.mjs` | new `7372f053bb` | details below |
| `network/attested-verifier-client.mjs` | new `719032372d` | details below |
| `network/wg-provider/attested-authority.mjs` | new `8088930fcc` | details below |
| `network/wg-provider/main.mjs` | `2e9633b868` → `1283ec7350` | uses `providerChainAuthority`: the reader gets the authority's options; raw RPC clients exist only under the RPC authorities; `--check-config` prints the mode; `cfg.rpc` (≥2) is still required for quorum and verifier |
| `test/metal-measured-control.test.mjs` | `2cd69e4b91` → `16c0c19b1e` | **stale baseline fixture fixed** (detail below) |
| `test/attested-chain-verifier.test.mjs` | new `1c69f41d05` | 15 tests |
| `test/helpers/loopback-verifier.mjs` | new (a byte-identical copy of route-source's reviewed helper) | test only |

`network/attested-verifier-brand.mjs`:
- A process-global WeakSet (`Symbol.for` key), so separately bundled copies share it.
- It stops a **plain object** (config/JSON-shaped) from being labelled attested. It is **not** a boundary against
  same-process code (stated in the file).

`network/attested-verifier-client.mjs`:
- **One overall deadline per request,** across waiting for or running an attestation and every replica. It is linked to
  the caller's AbortSignal: an abort or the deadline settles the caller at once, even while a shared attestation runs.
- **One attestation per replica at a time,** budget ≤ the starting request's remaining time.
- **Sockets:** every pinned socket is tracked and destroyed on abort, deadline or `close()`.
- **minTcb** is validated exactly as `checkMinTcb` does (`TCB_FIELDS` product lines, every field an integer 0–255).
- **Test roots** are refused unless the programmatic `allowTestRoots: true`; crl only `"required"`.
- **Unchanged:** `verifyMeasuredControl` and the verifier crypto.

`network/wg-provider/attested-authority.mjs`, G5:
- **Choices:** quorum, verifier and attested-verifier. The first two are exactly as before.
- **Attested mode refuses:** `rpc`, `chainVerifier`, a paid provider (on-chain writes), unknown fields, and any
  root/status field. Paths must be absolute.
- **Replica configs** come from absolute `configFile`s.
- **Collateral:** pre-seeded `fileCollateral(dir)` (read-only), optionally layered over AMD KDS (`kds: true`, off by
  default).
- **Test roots** are programmatic only; main never passes them.

The `metal-measured-control` fixture fix:
- The "gsup legacy path" test failed on clean HEAD.
- Cause: two reviewed commits inside the compared region were never accounted for: `f04efa124` (the
  `SHIELDED_GPU_EXPECTED` line) and `a7fc374f4` (the measured custody v1/v2 vault lines).
- The fix names both exactly, asserts each appears once, and removes them before the unchanged byte-identity comparison.

## Tests (strict per-file runner: any fail, cancel or skip fails the file)

**`test/attested-chain-verifier.test.mjs`, t5: PASS 15/15, 0 skipped.**
- The round-1 nine:
  - G2 sources;
  - G1 config;
  - G1 `planDirectBoot` (directOnly rules);
  - front filter;
  - oversize answer;
  - attestation through the unchanged verifier;
  - attestation refusals, failover and re-attestation after a key change;
  - G4 labels;
  - ERC-1271 + SessionVault on a real anvil chain through the attested channel.
- Round-2 additions:
  10. minTcb validation (missing field, unsupported product `Venice`, unknown field, non-integer, >255, empty); crl;
      roots refused without the programmatic flag; collateral required.
  11. **One deadline:**
      - 8 *hanging* replicas settle at the caller's 1200 ms deadline with "deadline passed" (between 1150 and 1900 ms),
        not 8 × 5 s, with at most one pending attestation;
      - 8 *dead* replicas fail fast (< 3 s) at cold start, all `unavailable`, nothing reaches the verifier;
      - a hanging first replica consumes the shared deadline: the second is not given a fresh budget.
  12. **Aborts:**
      - 20 requests aborted while an attestation is pending each settle promptly (< 400 ms max), sharing ONE attestation;
      - a pre-aborted signal rejects;
      - an attested request aborted mid-flight leaves 0 open sockets;
      - `close()` refuses later requests.
  13. **G5:**
      - quorum and verifier modes are unchanged, and the legacy "two or more RPC endpoints required" still holds;
      - every mixed, paid and root-naming config refuses;
      - a config-file-only attested authority (AMD's pin) **rejects** the synthetic chain;
      - with programmatic test roots, the provider's reader built as main builds it is labelled `attested-verifier`, has
        no raw RPC client, and reads through the client.
  14. **Packaging:**
      - a reader bundle and a client bundle built separately by esbuild share ONE brand (no duplicate-module mislabel);
      - `wg-provider/main.mjs` bundles its whole closure, with exactly one brand registry in it.
  15. **The REAL `supervisor.js` in a verifier-only boot:**
      - the planned env is unchanged for every chain name (`BASE_RPC(S)` and the policy RPCs are the refusing verifier);
      - it starts and answers `/v1/health`;
      - the config's rpcs appear nowhere in its output;
      - behind the real front, the client attests **including step 6 against the real supervisor's minted keys**, then
        reads through the filtered route.

**Existing suites of the changed modules, t4: 96/97.**

| file | result |
|---|---|
| **metal-measured-control** | **15/15** (was 14/15) |
| chain-verifier-guest | 5/5 |
| rpc-runtime | 9/9 |
| witness-gateway | 7/7 |
| lease-reader-verifier | 9/9 |
| lease-reader-verifier-deadline | 11/11 |
| lease-reader-terminal-snapshot | 2/2 |
| verified-chain | 9/9 |
| verified-chain-lifecycle | 3/3 |
| chain-authority | 10/10 |
| contract-owner-signature | 2/2 |
| service-index | 14/15 |

The `service-index` failure:
- The failing case is "independent checker … schema-4 registry".
- It **fails identically on a clean worktree of HEAD** (t5 control): `fatal: invalid object name 'b17db9a3'`, a
  historical object absent from this clone.
- It is pre-existing and not caused by this change. Earlier root direction was not to restore old history, so it is not
  "fixed" here. It is reported as a failure.

Not rerun after the final client change: the t4 existing suites. That change was a deadline label, in a file only the new
suite loads; the readers only import the brand module, which did not change after t4.

## Labels (as implemented)

| what | label |
|---|---|
| the remote caller | attested remote execution, `localProof: false` |
| the guest | proof-backed (Helios over proofs) **inside the attested guest** |
| tier | **unsafe** (sequencer-signed head) |
| finality | **none** |
| replicas | failover, `replicaQuorum: false` |
| host-local unmeasured HTTP | never attested: only client-built objects are labelled, and the client attests via SNP before use |

## Remaining gaps (explicit)

1. **Synthetic crypto, no Merkle proofs.**
   - The SNP chain is synthetic: the real AMD pin refuses it, and the G5 test proves that refusal.
   - The verifier stand-in checks **no MPT proofs**; real proof checking is the pinned Helios's.
   - The anvil contracts are minimal hand-assembled ERC-1271/SessionVault/factory code with the real call shapes, not
     the production contracts.
2. **Collateral pre-seed not exercised in a full attestation.** `providerCollateral` (fileCollateral layout
   `amd/<product>-cert_chain.pem`, `amd/<product>-crl.der`, `vcek/<product>-<chip>-<tcb>.der`) is wired and
   config-checked. Tests passed the synthetic collateral programmatically, and the guest-evidence auxblob VCEK path was
   not exercised.
   - Pre-seeded CRLs expire, after which attestation refuses (fail-closed). The refresh operation is not built.
3. **Unbounded background attestation after the caller settles.** A shared attestation can outlive its waiters: it is
   bounded only by `verifyMeasuredControl`'s own per-step timeouts (≤ timeoutMs each), because that function takes no
   AbortSignal. It was left unchanged on purpose. There is at most one per replica.
4. **No host-services gate here.** This tree's provider has no host-services gate (that is the route-source lineage), so
   G5 covers registry, leases, owner signatures and paid refusal here. Composing it with the route-source host-services
   policy runtime (`createHostPolicyRuntime({snapshot: verifiedHostSnapshot({verifier: client})})`) is root's
   composition step, untested here.
5. **Bundles not rebuilt.** The changed shared modules feed generated bundles and pins (host-admission, lease-gas-runtime,
   platform-api, network-runtime, host-service packages, the rpc-runtime host package, the provider dist). Run each
   builder's `--check` and rebuild. No image or measurement was produced.
6. **Pinned Helios `eeffcc9` call defects.** They (dropping maxFee/authList) are not exercised by these view calls.
7. **G6 not done.** The static operator WireGuard carve-out remains a staging/ops item.
