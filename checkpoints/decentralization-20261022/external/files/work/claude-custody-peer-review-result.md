# Custody Shield daemon integration: peer review (claude Windows worker, read-only)

Repo: `wo/work/enclave` at HEAD `d0676ff3`. I edited no source, test or doc in the repo, and staged or committed nothing.
There was no image build, SSH, chain, Wine or GUI activity.

I read the four custody result files, the inventory JSON, and the exact source (listed under "Sources" at the end).
Source state is not hardware evidence: nothing here shows a real TPM, a custodian image, a measurement, a `code-approve`
or a custody migration.

**Verdict: sound, apart from one concrete blocker (B1, availability).** It has a small fix, validated in an isolated copy.
The blocker is summarised for the custody author in `work/custody-peer-review-interface.txt`. Fix B1, re-run the
inventory generator, then commit the closure in section 4.

## 1. Blocker B1: another genuine TPM can displace a lease holder's live Shield session

**Trace.**
- Custody creates host sessions with `registryEntry: null` (`custody/v2/shield-evidence.mjs createShieldCustody` → `relay/shield-host-session.mjs`).
  Attest therefore accepts any recovered signer, which is the design: identity is checked at release.
- `attest()` stores sessions under `hostId` alone (`live.delete(s.hostId); live.set(s.hostId, …)`).
- `verify()` then reads `live.get(hostId)` and compares `s.signer` with the release's `endpointOperator`.

**Impact.** Anyone with any on-die AMD or Intel TPM under the pinned roots (an ordinary PC on a production boot), signing
with their own key, can attest for the victim's endpoint. That replaces the victim's session, and the victim's releases are
refused. The node only re-attests on its own 6-minute schedule (`windows/node/shield-sessions.mjs RENEW_AFTER_MS`), so the
attacker can keep repeating it. Confidentiality is intact.

**Actual test.** A read-only reproduction, from a scratch directory, against the real router, `createCustodianV2` and
`shield-custody-rig`, over HTTP:
1. The lease holder attests and its release returns 200.
2. A second TPM under the same CA, signed by `stranger`, attests: 200.
3. The lease holder's next release: `403 evidence_refused` "the host session was not made by the lease holder's registered
   operator".

**Fix, validated in an isolated copy.** Key live sessions by `${hostId} ${signer}`, and look them up with the release's own
`endpointOperator` (exact text in the interface file). Results in that copy:
- the reproduction now keeps the lease holder releasing;
- `shield-custody` 7/7;
- `custody-v2-shield-daemon` 10/11.

The single failure is test 4 (lines 185-190). Its comment states the foreign session "replaces this host's", so the test
encodes the defect and needs the expectation change given in the interface file.

## 2. Requested checks: verified from source, with traces

| Check | Result |
|---|---|
| Opt-in off by default | `custodianMeasured` adds `shieldRecipients` only when given. `daemon.mjs`: `shieldCustodyFor(MEASURED.shieldRecipients)` returns null when absent, giving `shield:null`. The router serves the Shield routes only if `custodian.shieldChallenge` exists, otherwise an unknown-route 404. The production verifier table (`custody/verifiers.mjs`) has only the SNP format, so a Shield document without the adapter gets `unsupported_evidence`. |
| Host config can't inject policy | `custody/v2/host-config.mjs parseHostConfig` reads a fixed set of 7 fields. The daemon reads Shield and trusted proxies only from `MEASURED`, and validates both before touching state (FATAL if invalid). |
| Party = actual custodian encKey | The daemon passes `encKey.slice(2)` from `hpke.publicKeyOf(sealed encPrivate)`. `createCustodianV2` throws unless `shield.party === encKeyHex`. The attach message names the party (`shield-host-session.mjs verify`, `attachMessage({verifier: party, …})`). |
| Owner vs beneficial owner | Authorization (step 6) is unchanged: `s.beneficialOwner === pol.owner`. The report binds `s.lease.owner`, the ledger row owner from the same agreed read. The guest uses the same owner (`isolation/m2/bootstrap/names.go`, `NameGrant.Owner = snapshot.row.owner`). `shieldReleaseInput` gives `4e01ef1a…fd53` in both JS (computed here) and Go (`isolation/m2/custody/shield_test.go`). |
| Fresh lease and operator snapshot | `custody/v2/chain.mjs readRelease` comes from `agreed()` (`custody/v2/quorum.mjs`): a majority-agreed canonical block hash, with `maxAgeSec` 120 measured and a rollback high-water. Step 7 requires `lease.runner === keccak(endpoint)` and a live `leaseUntil`. `endpointOperator` is the active registry entry at that block. The Shield session's signer must equal it, and so must the release's operator signature. This code is committed and unchanged. |
| Nonce and session single use | Release nonce: consumed before the chain read (`consumeNonce`). Host challenge: `sessions.delete` before any check, with a 60 s TTL. The credential is minted per challenge and bound to the EK and AK name (`mintedFor`). |
| TPM roots: challenge trust vs the caller's chain | Anchors are `loadTpmRoots(party's own ekRoots)` narrowed to the pins, derived once at construction. `verifyEkChain` (`relay/vbs-verify.mjs:144`, committed) terminates only at `trust.roots` with pinned fingerprints. Request `ekChain` entries are used only as CA intermediates. Attest re-verifies with the same `ekRoots`/`ekRootPins`, plus the leaf-not-CA and on-die manufacturer checks. |
| Input bounds | Challenge: 256 KiB, base64 caps, at most 8 chain certs. Attest: measured `maxAttestBytes` (≤ 8 MiB), refused on declared length before reading and counted while streaming; `maxConcurrentAttests` 1..4 (503); `attestReadMs` 60 s (408); the slot is released in `finally`. Other bounds: per-EK pending 2, per-EK live 4, `maxSessions`, `maxPendingChallenges`. Rate key: the TCP peer, or the rightmost XFF entry only from a measured private proxy. |
| SNP compatibility | `isShield` requires the Shield format and the adapter. Otherwise `parseRules`, the verifier table and the call arguments are unchanged; the Shield-only arguments are spread only when `isShield`. Cross-acceptance is refused both ways: Shield rules don't parse as SNP rules and vice versa. The SNP release-authority, quorum and protocol suites were run by the author; I did not re-run them. |
| Bundler clean-source closure | I re-ran the builder's own `bundleOptions`/`bundleSources`/`sourceCheck`, in memory with `write:false`, using a dummy vault: 54 repository inputs. Untracked or dirty inputs are exactly the inventoried set (custody/v2 ×5 new + ×4 M, `relay/shield-host-session.mjs`, `windows/node/shield-verdict.mjs`, the script), with **no dirty input outside the component**. Note: the Shield modules are bundled even into SNP-only images, so every image's measurement changes and needs a new `code-approve`, as the author states. |
| `shield-verdict.mjs` standalone | Its only local import is `windows/node/hvnode-evidence.mjs` (tracked, clean). It can be committed with custody, with no Windows dependency. |
| Test helper imports | `shield-custody`, `custody-v2-shield-daemon` and `shield-dns-challenge` also import `windows/node/shield-sessions.mjs` (untracked). Its imports are only `hvnode-evidence` (clean) and `shield-verdict`, so it can be committed standalone in the custody closure. `windows-shield-verifier.test.mjs` imports the Windows worker's uncommitted host and startup files and `relay/shield-{independent-verifier,market-evidence}.mjs`, so it belongs with the Windows commit. |

## 3. Non-blocking findings

1. **Reproducible-input provenance (gap, procedure).**
   - The manifest records `node_modules` inputs only as `name@version`, read from the installed tree.
   - Nothing checks that tree against the clean `package-lock.json`, and no per-file hash is recorded.
   - `--allow-dirty` use is not recorded in the manifest either.
   - Recommendation:
     - build candidates only from a fresh clone with `npm ci`;
     - record sha256 per bundled `node_modules` input (the metafile already lists the paths);
     - add `allowDirty: true` to the manifest when that flag is used.
2. **Test budget.** `test/custody-v2-build.test.mjs` peaked at **411 MB** (process tree; run once), over the 250 MiB
   single-job budget. The others peaked at 150–200 MB. In the transport session, `test/shield-dns-challenge.test.mjs`
   peaked at 276 MB.
3. **Vector pin.** The Go test claims to share its `shieldReleaseInput` vector with `test/shield-custody.test.mjs`, but the
   JS tests don't assert the literal. The values match today (computed above). Add the literal to the JS test.
4. **Index churn.** `custody/v2/build-config.mjs` showed as staged (`M `) once during this review, then unstaged a moment
   later. The author saw the same. Another session is touching the index: confirm `git diff --cached` immediately before
   committing.

## 4. Recommended commit closure (after B1)

**Commit A: custodian Shield recipients.** Self-contained: every import resolves to these files or to clean tracked files.
- `custody/v2/{custodian,daemon,http,host-config,build-config,shield-evidence,shield-operator,shield-rules,ingress}.mjs`
- `scripts/build-custodian-v2.mjs`
- `relay/shield-host-session.mjs`
- `windows/node/shield-verdict.mjs`, `windows/node/shield-sessions.mjs` (standalone; see section 2)
- `docs/security/custodian-shield-recipients.md`
- Tests:
  - `test/{shield-custody,custody-v2-shield-daemon,custody-v2-build,shield-host-session,custody-v2-ingress-ratekey}.test.mjs`
  - `test/helpers/{shield-custody-rig,malicious-ek}.mjs`

**Commit B: DNS responder, separately.** No custody file depends on it.
- `relay/dns-challenge-shield.mjs`, `relay/dns-challenge-attested.mjs`, `test/shield-dns-challenge.test.mjs`
- The owner-reviewed `relay/dns-relay.js` hunk.

**Commit C: with the Windows commit.**
- `test/windows-shield-verifier.test.mjs`
- `relay/shield-independent-verifier.mjs`, `relay/shield-market-evidence.mjs`

**Exclude:** management and browser files, `cache/test-failures`, and anything else outside these lists.

## Runs (serial, `--test-concurrency=1`; RAM floor held at ≥ 17.1 GiB)

| File | Result | Peak RSS (tree) |
|---|---|---|
| shield-host-session | 3/0 | 173 MB |
| custody-v2-shield-daemon | 11/0 | 197 MB |
| shield-custody | 7/0 | 188 MB |
| custody-v2-build | 11/0 | **411 MB** |
| B1 reproduction (scratch, real tree read-only) | defect confirmed | 150 MB |
| Isolated copy with fix: reproduction / shield-custody / daemon | pass / 7/0 / 10/1 (test 4 encodes the defect) | ≤ 180 MB |

`custody-v2-ingress-ratekey` was not run: it needs the local Caddy, and the author ran it.

**Scratch.** `/tmp/claude-peer` (the isolated copy, the reproduction, the monitor) was deleted after this report. No test
process was left running.

**Sources reviewed:**
- `custody/v2/{custodian,daemon,http,host-config,build-config,shield-evidence,shield-operator,shield-rules,ingress}.mjs`
- `scripts/build-custodian-v2.mjs`
- `relay/shield-host-session.mjs` and `relay/vbs-verify.mjs verifyEkChain`
- `custody/v2/{chain,quorum}.mjs` (the release read)
- `windows/node/shield-verdict.mjs` (imports)
