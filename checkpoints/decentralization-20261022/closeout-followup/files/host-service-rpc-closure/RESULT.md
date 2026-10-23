# host-service-rpc-closure: RESULT (2026-10-23)

**Status: SOURCE + OFFLINE TESTS + JS ARTIFACTS. Nothing deployed, pushed, signed or activated.**
- No SSH, wallet, production, live network, new image or new toolchain.
- The immutable final package (`host-services-final-compose`, 4106c311), C's tree and A's tree were only read: A's
  objects were fetched into MY clone.
- `main-repo` was not touched; D owns checkpoint publication and root owns rollout.
- Every build, test and scan ran through `claude-test-queue.py` (16 GiB floor):
  - caps 256, 768 and 1024, plus one 1536 lane for the browser and rig suites;
  - one 1024 job (g4) was guard-stopped at 1029 MiB and counted as NOT RUN; it was re-split and run (g6, g7).
- No NVMe cache was allocated or used.

## 1. Exact commits (branch `closure/host-service-rpc`, origin removed, SteveDeFacto author and committer)

| commit | content |
|---|---|
| base **`4106c3114dd13f39692195c182d3152efa5e212c`** | the immutable final composition (C 0757085e + F 6c38c048) |
| `bb86e0cebdd43c4ab4a5182c42fc143b30eafa6b` | policy-mirror sync race fix + deterministic regression |
| `30123801a279479f1dc9406d417e7bfa17b9f023` | A's verified chain authority composed (A only; built in a temporary index from git objects) |
| **`14d1e4954cf7c9900d5d3e841a23f02de945c1b2`** (tree `77d12fb6`) | one-authority hardening + packaged-role verifier tests |

Patches:
- `patches/0001-…` `3651eade…`, `0002-…` `8f436018…`, `0003-…` `f01359a4…`;
- `host-service-rpc-closure.patch` = `git diff 4106c311 14d1e495`, `de4609e4…`.

## 2. The policy-mirror sync race (fixed)

**The defect** (`network/host-services/policy-mirror.mjs` `sync()`, seen in t2 of the final package):
1. It verified a snapshot of the store.
2. It then dropped every key of the CURRENT store that the verification did not cover.

So a document the admin POSTed during the awaited verification was dropped as "not signed by the current owner". A ban
published only to that carrier was lost from it: enforcement was delayed to the gate's grace, not bypassed.

**The fix:**
- capture `(digest, entry)` pairs;
- drop only an entry that is still the exact captured object.

A document published or re-published meanwhile therefore keeps its own, fresher verification. The owner signature,
binding, anchor fill and prune are unchanged.

**Test** (`test/policy-mirror-sync-race.test.mjs`): the REAL module and a REAL quorum snapshot over the loopback policy
world, with exactly the sync's verification held deterministically.

| run | result |
|---|---|
| candidate (r1) | **2/2** |
| exact 4106c311 (negative control) | **FAILS** on "the ban published during the sync is still carried" |
| checks case on both trees | foreign-signed document refused at POST (422) and dropped from disk; anchored document filled from importDir — passes on both (the checks are preserved) |

## 3. Hosted-service RPC authority: A composed, roles wired

**Source lineage:** worker A's immutable `df8fbafae` (rpc-priority/repo; A's base `9fdc1418c`).

**Taken as A's blobs** (A's base blob equals 4106c311's, so each is the exact 3-way result):

| file | A blob |
|---|---|
| `network/verified-chain.mjs` | `e55f0359` |
| `network/lease-reader.mjs` | `d77dbf77` |
| `network/directory-server.mjs` | `c48d1908` |
| `network/host-policy-runtime.mjs` | `95930152` |
| `network/service-index.mjs` | `d7350364` |
| A's tests `verified-chain`, `verified-chain-lifecycle`, `lease-reader-verifier`, `lease-reader-verifier-deadline`, `lease-reader-terminal-snapshot` | |

**3-way merged (`git merge-file`):**
- **clean:** `platform-host-policy-config.mjs`, `policy-carriers.mjs`, `host-services/roles.mjs`, and `policy-mirror.mjs`
  (on the race fix);
- **one conflict, resolved by `resolve-runner.py`:** `host-services/runner.mjs` `policyCarrierFetch`.
  - C's injected `snapshot` (its gate's own authority, the verifier seam) wins.
  - Otherwise A's configured `chainAuthority` applies.
  - The RPC-quorum requirement applies only in legacy mode.

**Not composed (out of scope; A's other consumers):** cold-bootstrap, provider-settlement, usdc-bandwidth,
management/native/windows/relay/lease-gas/host-admission/challenge-replica wiring.
- A's `lease-reader-verifier` case "settlement pinned reads" needs `usdc-bandwidth`, so it is excluded by name.

**Effect.** A role (`directory-replica`, `policy-mirror`), or the runner's policy gate, its carriers and its index
carriers, configured with `chainAuthority:"verifier"` + a LOOPBACK `chainVerifier`, reads ONE proof-backed pinned
block from the local verifier.
- That read is the unsafe tier, with freshness, header re-check, monotonic floor and whole-operation deadline.
- No provider client is built and there is no fallback.

Without that choice the legacy quorum is unchanged: 2 to 8 distinct provider identities, majority agreement.

**My hardening** (commit 3):
- **One explicit authority:** in verifier mode, `directory-replica` refuses `rpc` and `policy-mirror` refuses
  `rpc`/`minAgree`, rather than ignoring them. The runner refuses `platformHostPolicyRpcs`.
- **The verifier is never a vote:** no RPC entry the host lists (the policy's, or any role's) may resolve to the endpoint
  identity of a configured verifier.
- **Not changed:** a remote verifier is refused by A's `chainVerifierOf`/`verifierEndpoint` (loopback only).

## 4. Tests on the final head's code

**v2** (1024, anvil, peak 548 MiB): **39/39 pass**. A's settlement case was excluded by name. The job's exit code 7 is
my own strict-skip counter: the excluded case is not reported as "skipped".

**`test/host-service-verifier-roles.test.mjs` (4 tests):** the PACKAGED roles under the real runner, gate, carriers and
index, on the hosted policy rig's real chain:
- admin-owned EnclaveAddressBook, EnclaveHostOwnership, registry and EnclaveServiceIndex (forge-subset artifacts copied
  from C, hash-verified earlier).

The scenarios:
1. **Config:** one authority; local-only verifier; never a vote; legacy validation unchanged.
2. **Every public provider down** (the rig's three RPC origins down) and the fleet mirrors refused at the transport.
   - Host A is admitted on the verifier alone, and the gate read the book through it.
   - The PACKAGED directory replica logs `chain reads: local-verifier (unsafe tier, proof-backed, no provider fallback)`.
   - The policy mirror holds the anchored document from the import carrier.
   - Host B starts COLD (empty state) via the service index read through the verifier.
3. **Admin ban and unban** of host B through the carrier, verified via the verifier.
4. **AddressBook OWNER MIGRATION** (`setOwner` + `acceptOwnership`):
   - only the current owner's signature verifies;
   - the new admin's anchored policy governs both hosts;
   - the old admin's document is refused by the mirror (422).
5. **Proof failure, missing witness, stale head, unknown block:**
   - with the public providers UP, the mirror POST answers 503;
   - the directory replica's reader (constructed exactly as `runDirectory` builds it) refuses;
   - the gate's policy read refuses;
   - **the providers saw zero requests**; recovery happens when the verifier answers.

**A's verifier units** (`verified-chain`, `lifecycle`, `lease-reader-verifier`, `deadline`, `terminal-snapshot`): all
pass in this lineage. The race regression passes 2/2.

**Regression of every existing suite importing a composed module.** Each candidate failure was rerun on exact
4106c311 to classify it:

| job | files | result |
|---|---|---|
| g1 (768) | 25 light files | **220 pass, 1 fail**: `site-host-policy` "modes…", identical on 4106c311 (pre-existing). The 30 skipped were anvil suites, run in g6/g7 |
| g2 (1024) | agent side: carriers, cold-start, lifecycle, transport, privacy-agent ×3, challenge-replica | **60/62.** Two timing-sensitive cases under load (the carriers case failed on 4106c311 in the same run). **Rerun alone, g5: 21/21** |
| g3 (1024) | legacy-quorum packaged roles: hosted-policy-cold-start, hosted-service-placement, credit-vault ×2, hosted-services-stage | **24 pass, 0 fail**, 2 known `STAGE_TAR` skips |
| g6 (1024) | service-index ×2, lease-designated-relays, lease-relay-host-policy | **38/39**: the schema-4 checker case, identical on 4106c311 (local solc bytecode hash, pre-existing) |
| g7 (1536) | site-independent ×2, cli-independent-sessions | **17/25**. **4106c311 gives the same 17/25 with the same 8 failures** (g8; management host HTTP 409 "does not hold a current lease"): pre-existing |

**Scans** over `4106c311..14d1e495`: `scan-crypto-keys` 0; gitleaks "no leaks found" (`gitleaks-range.json` = `[]`).

## 5. Artifacts (built once after the tests, JS only; Go sources unchanged, no image rebuild)

**`build-js.sh` (b1, 768):** the committed head, built in this tree and in an independent `--local --no-hardlinks` clone.
- The packages were built and `--check`ed under the lockfile check.
- **Result: `REPRODUCIBLE (JS): 22 artifacts byte-identical`.**
- Full list: `artifacts-js-14d1e495.sha256` (`aa6a19d4…`).

| artifact | 4106c311 | 14d1e495 |
|---|---|---|
| **directory-replica** package manifest / bundle | `4aa032fa` / `903b1515` | **`e9cff3283064bcf2bb765a4c741af384eed2adc14a30bff959c58df8032be2d8`** / `45dc2321…` |
| **policy-mirror** package manifest / bundle | `0cec04fa` / `117bdd23` | **`2b5a85468d720d4904f282bc6ff84bcf9ff33e46738172cc32d444ae6e4bacbe`** / `74878623…` |
| route-dns manifest / bundle | `d60eb763` / `a99db623` | `e265478277853d4c3e9fc09337b7b366f4a332cbda31e8b5b10ce674f3970d9c` / `06293c93…` |
| credit-vault-submitter manifest (bundle unchanged `2a4de6d5`) | `45b98921` | `a22cd7a8fc6f7d85fea6edbd7f8e9deb36dc1b55507e3bb396e9bc6a368eb0e6` |
| bootstrap-replica | `7732950b` | same |
| `relay/network-runtime.bundle.mjs` | `dced8384` | `a5915d4c…` |
| Windows `dist/privacy-agent.mjs`; `consumers/privacy-agent.mjs` | `6480ca9b`; `4124c4ca` | `26091ec5…`; `eae93939…` |
| `dist/wg-provider`, `wg-qualify`, `enclave-directory`, `reconcile-apps`; consumers `provider`, `dns`, `checker` | | all changed (they bundle the shared reader/config modules) |
| `dist/host-service-ingress`, `windows-circuit-worker` | | same |

**Blast radius (for root's composition decision).** A's shared `lease-reader`, `service-index`,
`platform-host-policy-config` and `host-policy-runtime` are bundled into nearly every JS artifact. Rebuilding ANY of
them from this tree changes its bytes, even though the legacy path is unchanged by test.
- The Windows node deploy closure gains exactly one changed file: `control/network/platform-host-policy-config.mjs`
  (`e5d50001…`; A's opt-in `chainAuthority` fields).
- Pin only what is shipped. A release of the roles alone needs the two role pins above, plus `route-dns` if it is
  repackaged.

## 6. Preserved; nothing loosened

- **Admin governance:** the same gate and anchors; AddressBook owner migration followed at the next fresh read (tested);
  bans and unbans; sticky refusal; the exits' own admission.
- **No allowlist or legacy-admission change:** the API relay's branch-specific admission (generic `TRUSTED_OPERATORS`,
  HV-attested `RELAY_HVNODE_OPERATORS="*"`, measured attach) is untouched. No global allowlist and no static registry
  binding were introduced. Book resolution stays admin-driven.
- **Legacy quorum:** 2 to 8 distinct identities, majority; `minAgree` must be a majority.
- **Production anchor:** unanchored (root's 05:51Z preflight). Nothing here fabricates or activates a policy.
- **Not addressed here:** the pre-existing `platformHostPolicyRpcs` minimum of 1 entry (a single provider) in legacy
  mode; it is reported, not changed.

## 7. Unresolved gates (not claimed)

1. **No production verifier exists to point roles at.** B's runtime is loopback-only and internal, not a host role or
   public service.
   - A host using verifier mode needs a local patched Helios plus a witness/head supply on the same host.
   - Fresh witness availability is UNSOLVED (no Base peer proof interface; an execution-data holder is needed: see
     fresh-witness-supply).
   - Until then a verifier-mode role fails CLOSED (tested). The production authority stays the legacy RPC quorum, which
     remains a public-provider dependency.
2. **The proofs in these tests are not cryptographically checked.** The loopback verifier models the real one's protocol
   and refusals but does not check Merkle proofs. Proof checking is proven only by A's Helios E2E on a canonical-trie
   reth chain, with the same unchanged `verified-chain`/`host-policy-runtime` modules.
3. **Public exposure.** The roles listen on loopback in tests. Public reach still requires the host-service transport
   (the exits are the 4 DO fronts) and the B1–B10 gates of `host-services-final-compose/RESULT.md` §8. Moving the
   packages does not remove the provider dependency: DO remains the exit and DNS failure domain.
4. **Resources.** Role heap caps are as configured (directory 192, mirror 128 MiB V8); process limits come from the
   host's service manager. Not measured on a real host. Any verifier/witness cache on NVMe must sit inside the
   250,000,000,000-byte aggregate cap (target 200 GB), with enforced eviction verified before activation. Nothing was
   allocated here.
5. **Native.** No Windows/Linux service-manager run of the packaged runner, no real WireGuard, no production chain.
6. **Physical/provider independence** remains an external gate (one site; no non-DO exit/DNS path).
7. **Pre-existing failures carried, all reproduced on 4106c311:** site-host-policy modes, the schema-4 checker, and
   site-independent-management ×8 (HTTP 409).

## 8. Files here

- **Scripts:** `setup.sh`, `compose-a.sh`, `resolve-runner.py`, `commit1.sh`, `commit2.sh`, `commit3.sh`,
  `commit-msg-2.txt`, `commit-msg-3.txt`, `race.sh`, `regress.sh`, `job.sh`, `build-pkg.sh`, `build-js.sh`, `scan.sh`.
- **Evidence:** `logs/` (r1, v1, v2, g1–g8, p1, b1, s2, c1–c3), `artifacts-js-14d1e495.sha256`, `gitleaks-range.json`,
  `patches/`.
- **Scratch:** the `base/` worktree of 4106c311 for controls and classification, with node_modules and forge out
  symlinked to the candidate's copies.
