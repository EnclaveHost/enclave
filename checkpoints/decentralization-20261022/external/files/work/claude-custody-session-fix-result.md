# Custody Shield B1 session-displacement fix: result (claude, 2026-10-19)

Repo: `wo/work/enclave` at HEAD `a40c5f99`.

**Constraints kept:**
- Nothing committed or staged. The index was not touched, by me or by the inventory generator (proved below).
- No production, SSH, image build, contract, GUI or Wine activity.
- No Windows file edited. The other worker's concurrent Windows changes were left alone.

**What this closes.** The custody component's B1 finding from `work/claude-custody-peer-review-result.md`. Commit A can
now be committed, and a custodian candidate built from clean source.

## 1. The fix (`custody/v2/shield-evidence.mjs`)

**What changed:**
- Live sessions are keyed by `` `${hostId} ${signer}` ``, not by `hostId` alone.
- `verify()` first requires the release's own `endpointOperator`: the chain-verified, active registry operator for
  `keccak256(endpoint)`, from the release's agreed read. It then looks up exactly
  `live.get(`${hostId} ${endpointOperator}`)` and requires both `s.endpoint === endpoint` and `s.signer === operator`.
  The signer check is now true by construction, and is kept as a defensive check.

**Preserved unchanged:**
- deferred identity at attest;
- the per-EK cap (`MAX_SESSIONS_PER_EK = 4`; it evicts only that EK's own oldest entry);
- the total `maxSessions` admission (429);
- `sessionLifeMs` and the sweep;
- the party binding;
- the single-use challenge and attest;
- the IDKS-from-session-log report check, the AppID, image and SVN checks;
- the `shieldReleaseInput(binding, ledger owner)` binding;
- every release authority check in `custodian.mjs` (not edited).

**Result.** Another party's attest for the same endpoint, with its own genuine TPM and key, adds its own entry. It can never
replace the lease holder's session, and it releases nothing.

## 2. Tests

**`test/custody-v2-shield-daemon.test.mjs`.**
- **Test 4, rewritten.** The old block asserted displacement: after a foreign-party session, the genuine release was
  refused. It now asserts:
  - the foreign session is kept beside the genuine one (`sessions() === 2`);
  - the genuine release still returns **200**;
  - on a fresh custodian holding **only** the foreign-party session, the release is **403 `evidence_refused`**
    /registered operator/.
- **New HTTP regression:** "a squatter's own genuine TPM and key, attesting for the lease holder's endpoint, never
  displaces its session or releases". It covers:
  - the genuine attest and release (200);
  - the squatter attest with a second on-die EK and `stranger`'s key: 200, with `party` = encKey;
  - the genuine release after it: 200;
  - 3 repeated squatter attests for the same endpoint: they replace only the squatter's own entry (`sessions() === 2`);
  - 8 squatter attests for other endpoints: the per-EK cap holds the squatter at 4 (`sessions() === 5`), and the genuine
    release is still 200;
  - the squatter's session alone, on a fresh custodian: 403 `evidence_refused` /no live Shield host session
    .*registered operator/, and it consumes nothing.

**`test/shield-custody.test.mjs`.** New test: the literal JS `shieldReleaseInput` vector.
- The value `4e01ef1a9ae8565737835fb7577a968701ce4492461eb812164a7c2eb8eefd53` is the one Go's
  `isolation/m2/custody/shield_test.go TestShieldReleaseInputMatchesTheCustodian` pins, for the binding `0xab…` and owner
  `0x33…`.
- It also checks owner case-folding, and refusal of a 31-byte binding and of the zero owner.
- The existing stranger-signed and other-endpoint refusals are unchanged and still pass.

**Mutation checks, in an isolated copy** (deleted; the copy's `shield-evidence.mjs` was restored byte-identical
before deletion):

| Mutation | `custody-v2-shield-daemon` | `shield-custody` |
|---|---|---|
| B1 reverted (keyed by `hostId` only) | 2 fail | 0 |
| Lookup ignores the operator (any session for the endpoint) | 2 fail | 1 fail |
| Per-EK cap evicts any EK's oldest | 2 fail | 0 |
| No per-EK cap | 2 fail | 0 |
| Signer equality dropped | 0 / 0: equivalent (the key contains the signer), kept as a defensive check | |

## 3. Runs

All runs were serial (`--test-concurrency=1`), guarded by process-tree RSS and MemAvailable. MemAvailable stayed at
≥ 16.9 GiB throughout.

| File | Result | Peak RSS (tree) |
|---|---|---|
| test/custody-v2-shield-daemon.test.mjs | 12/0 | 198 MB |
| test/shield-custody.test.mjs | 8/0 | 187 MB |
| test/shield-host-session.test.mjs | 3/0 | 182 MB |
| test/custody-v2-build.test.mjs (separate run, 512 MiB cap) | 11/0 | 425 MiB |
| test/custody-v2-ingress-ratekey.test.mjs (real local Caddy, loopback; no Caddy left running) | 1/0 | 225 MB |
| test/custody-v2-e2e.test.mjs, test/custody-v2-independent-lifecycle.test.mjs | **not run to completion**: my 250 MiB guard stopped each at about 255 MB | - |

**Why the last two weren't rerun.** They take the SNP path. They load `shield-evidence.mjs` only for its format constant,
through the unchanged `custodian.mjs`, so they don't depend on this fix. Rerunning them would need a cap above 250 MiB,
which this task did not allow for them.

## 4. Index churn: investigated

**No component code writes the index.** Neither the inventory generator nor any commit-A test or helper stages anything.
- The generator, `custody-v2-build`'s live `sourceCheck` and the build script call only `git status`, `ls-files` and
  `rev-parse`.
- The build tests spawn the script against the real root, but it fails at `--base` before any git call.
- No helper in `work/` or the repo runs `git add`, `stash`, `update-index` or `reset`. The only `add` hits are
  `ipfs add`.

**The likely source.** The `.git/index` mtime equals the coordinator's commit times in the reflog (latest 20:11:27). The
brief staging is consistent with commit-time staging by another session; the evidence fits but does not prove it. I
didn't touch it, and nothing is staged now.

**Hardening applied.** Plain `git status` opportunistically rewrites `.git/index` and takes `index.lock`, which can collide
with another session's `git add`. These now run with `GIT_OPTIONAL_LOCKS=0`:
- the inventory generator (`work/claude-custody-inventory.gen.mjs`);
- the live check in `test/custody-v2-build.test.mjs`.

The generator now also records the staged set before and after, and fails if it changed. This run:
`{stagedAtGeneration: [], unchangedByGenerator: true, indexFileRewritten: false}`.

## 5. Inventory: `work/custody-final-source-inventory.json` (regenerated 2026-10-20T03:20:58Z)

**What the regenerated file shows:**
- A new `commitA` section, plus `component.shared` for `windows/node/shield-verdict.mjs` and `shield-sessions.mjs`.
- `commitA.closureDirtyOutsideCommitA: []`: the image's bundle inputs and every commit-A test's imports resolve only to
  commit-A files or to clean tracked files.
- `custodianImage.dependsOnDirtyCodeOutsideComponent: []`.
- The DNS test depends on `relay/dns-challenge-attested.mjs`, so it belongs to commit B. `test/windows-shield-verifier`
  depends on Windows files, so it belongs to commit C. Neither is in commit A.

**Commit A, exactly** (21 files; sha256 at generation):

| Status | sha256 | File |
|---|---|---|
| ` M` | 7b60672a23c8835683c105828b8c1f1f9310ae85853e8b05ed222360980d16ce | custody/v2/custodian.mjs |
| ` M` | 3082d9b8bfaef41752e337b6a06bdd52cad97287ba6a3c05e81957033bb6735d | custody/v2/daemon.mjs |
| `??` | 6f81e9c70544a004d5abf4df9902d6bd4b8bbc2f4c5ca6403add1f209cbc62e6 | custody/v2/http.mjs |
| `??` | 05771b528710d7e51568106a70c54b7515ac8e2498735bca0fee74ed9ae2c93a | custody/v2/host-config.mjs |
| ` M` | 73247f905924bbf768d14d81053b9516d52b1ad4ff3858c84a8149ddf13be7d2 | custody/v2/build-config.mjs |
| `??` | 641b183f9b59044f826263c02cc031b2e4b0c9e84edfc373f9cb3a60d818e580 | custody/v2/shield-evidence.mjs (B1) |
| `??` | 0c146e20f3b288b9780ae9e26b51c1a9154b1c32d26cddef04b46011ef3fbcd9 | custody/v2/shield-operator.mjs |
| `??` | a9b9e7bf21329c71250ab44e5ecdb3a356f61c0e644d113fa56f6a7a720b96cf | custody/v2/shield-rules.mjs |
| ` M` | 7d9b2d1aeae0e81f86e2aacc83224327ebe9217ad01d39b271960445424640e0 | custody/v2/ingress.mjs |
| ` M` | 71cec859c0d3fb191be292c338d44ca5617b4df221dff9f2a8967f637a153fde | scripts/build-custodian-v2.mjs |
| `??` | 60d9ad86522d1e48ffe7d4b83628c7ce7af2bda06338595018114d8bb1d7cdef | relay/shield-host-session.mjs |
| `??` | 6f134d8b27baea62044506c820df9fc36fbcaa68a64a5754f36bb18a7e5dbd95 | windows/node/shield-verdict.mjs |
| `??` | 5706db7bac997906ae0f631d156c9fb801f1fb7e3fe1813b5697696bc760dd00 | windows/node/shield-sessions.mjs |
| `??` | d660fc92a086209e007272ae410ed8e0962327ed906090cfcc51f9d250d8f005 | docs/security/custodian-shield-recipients.md (B1 wording) |
| `??` | a0d6726ea817fdeac24a6850b5343aadbb95d7125d25ded53073b8aa94e4880a | test/shield-custody.test.mjs |
| `??` | 14a9f9c41227f4dc3bcf576d28b0a788476cd371827e5bc9af7ed22e88a4f9d3 | test/custody-v2-shield-daemon.test.mjs |
| ` M` | 5643c44a049f8d7b898a2a480e6e73576c8245be5c0ef4b07766d7b0afc9c021 | test/custody-v2-build.test.mjs (GIT_OPTIONAL_LOCKS) |
| `??` | 62630aba68785b0fc385544ffd6bcfee89a81714f04b8351acb9f3524be17995 | test/shield-host-session.test.mjs |
| `??` | 91373a4b13ad41b320b9638b3a368c8dda1125e259219d8f086115c15eb91284 | test/custody-v2-ingress-ratekey.test.mjs |
| `??` | 8e08ff903a09f16969824bb4986e2222983bae98df2acf1c9bd6a9563ae09e64 | test/helpers/shield-custody-rig.mjs |
| `??` | 9d8b3a10b2a072904ea9263201162197e769969f09e6a95fbbcdfe98ebaa2fc0 | test/helpers/malicious-ek.mjs |

**Before committing:**
1. Re-run `node ../claude-custody-inventory.gen.mjs` from `work/enclave` and compare. `windows/node/shield-sessions.mjs`
   is also imported by the Windows worker's agent, and could change if they touch it.
2. Confirm `git diff --cached` shows only these 21 files.

**After committing:** `custodianImage.buildSourceCheckToday` must be empty.

**Excluded from commit A:**
- commit B, the DNS responder: `relay/dns-challenge-shield.mjs`, `relay/dns-challenge-attested.mjs`,
  `test/shield-dns-challenge.test.mjs`, and the reviewed `relay/dns-relay.js` hunk;
- commit C, with the Windows change: `test/windows-shield-verifier.test.mjs`, `relay/shield-independent-verifier.mjs`,
  `relay/shield-market-evidence.mjs`;
- all management, browser, site and Windows files.

## 6. Remaining activation inputs (none supplied or invented here)

**Candidate build provenance (a requirement, not a code change):**
- Build from a fresh clone at the commit-A commit, after `npm ci`. The manifest records `node_modules` packages only by
  `name@version` (14 packages, including two viem and two ox versions), and does not check them against the lock.
- Never use `--allow-dirty`. The manifest doesn't record its use.

**Custodian image operator inputs** (`work/claude-custody-final-result.md` section 3):
- the metal base dist dir;
- the `EnclaveSecretVaultV2` address;
- the `hostOwnership` authority;
- the admission mode;
- `--transport direct`;
- `--trusted-proxy 10.0.2.2`, recommended; the guest-side slirp address has not been observed on hardware;
- optionally `--shield-recipients`: `ekRoots` as certificate-only PEM (the repo's `relay/fixtures/tpm-roots.pem` needs its
  6 comment lines removed), the exact root pins, and all 5 limits. The operator decides between AMD only, or AMD plus
  Intel.

**Then:**
- the committee's `code-approve` of the measured image (an on-chain, owner-signed step; every image built from this
  source has a new measurement, with or without the opt-in);
- an owner policy with Shield rules.

**On the Windows side** (separate):
- explicit 9445/9446 service registration;
- the direct-image and node pins;
- the custody callback key.

**Hardware evidence: none.** None of the following exists yet:
- a real TPM, custodian or host session;
- a measured custodian image;
- an activated Shield-direct guest (`c7084346` is unactivated).
