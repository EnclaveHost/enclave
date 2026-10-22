# Custodian Shield daemon integration: result

**Repository:** `wo/work/enclave` (main working tree, base `0ed5a8ba`).

**Constraints kept:** nothing committed; no image built or measured; no production, SSH, chain, Wine or GUI activity. No
Windows, Go, CLI or browser file was edited, and no relay module was edited (relay modules are only imported).

**The early interface:** `work/custodian-shield-daemon-interface.txt`. Section 7 lists the deviations from it.

## What exists now

The custody v2 daemon, as the image builder bundles it, can optionally verify Enclave Shield release recipients. This is
**off by default**. It turns on only from the custodian operator's measured opt-in.

| File | Change |
| --- | --- |
| `custody/v2/shield-operator.mjs` (new) | The measured opt-in: `validateShieldOperator` (shared by the build and the daemon), `shieldCustodyFor(MEASURED.shieldRecipients, {party})`, the limits and their bounds. |
| `custody/v2/http.mjs` (new) | The daemon's HTTP router, extracted unchanged, plus the two Shield session routes, present only with the adapter. |
| `custody/v2/host-config.mjs` (new) | `readHostConfig`'s parser, moved unchanged (a fixed field list). |
| `custody/v2/daemon.mjs` | Serves `createCustodyRouter`. Validates the measured opt-in before touching any state. Builds the adapter from `MEASURED.shieldRecipients` for `party = its own encKey`. |
| `custody/v2/custodian.mjs` | Refuses an adapter whose `party` is not this custodian's own encKey. Exposes `shieldLimits`. The F2 ledger-owner binding is unchanged. |
| `custody/v2/shield-evidence.mjs` | Passes `maxPending` through. Caps live sessions per EK at 4 (audit, section 6). |
| `custody/v2/build-config.mjs` | An optional `shieldRecipients` measured field, refused with `--transport tunnel`. `bundleOptions`, `bundleSources` and `sourceCheck`, plus `STATIC_IMAGE_SOURCES`. |
| `scripts/build-custodian-v2.mjs` | Adds `--shield-recipients <file>`. The dirty-source check now runs over every bundle input. New manifest fields: `shieldRecipients`, `bundleInputs`, `bundler`. |
| `docs/security/custodian-shield-recipients.md` (new) | Operator documentation: config, validation, routes, bounds, the release checks, status. |
| `test/custody-v2-shield-daemon.test.mjs` (new) | 8 tests over real HTTP against the real router and a real `createCustodianV2`. |
| `test/custody-v2-build.test.mjs` | 5 new tests: config, tamper, bundle sources, script refusals. |
| `test/helpers/shield-custody-rig.mjs` (new) | The existing Shield custody rig, moved verbatim from `test/shield-custody.test.mjs`, which now imports it (still 7/7). |

## 1. Default: SNP only

- `custodianMeasured` without `--shield-recipients` produces no `shieldRecipients` key. The measured text is
  byte-identical to before (the existing legacy-bytes test still passes, and a new assertion checks for no `shield`).
- `shieldCustodyFor(undefined)` returns `null`, so `createCustodianV2` gets `shield: null`.
- Over HTTP, both `/v2/custody/shield-session/*` routes return exactly the unknown-route 404. `/v2/custody/info` is
  unchanged. A Shield-format document is refused with `unsupported_evidence`.
- On an image that has the opt-in, an owner whose rules are default or SNP is still refused (`bad_rules`). SNP evidence
  never reaches the Shield verifier (the existing test is kept).

## 2. The measured operator opt-in (never host-controlled)

**The format:**

```
{ format: "enclave-custody-shield-operator/1",
  acceptTier: "windows-tpm-host/hv-node/T0-hv/hostExcluded:false",
  ekRoots: <PEM text>,
  ekRootPins: [sha256 of each root's DER],
  limits: { sessionLifeSec, maxSessions, maxPendingChallenges, maxAttestBytes, maxConcurrentAttests } }
```

**Where it is validated:** at build time, and again by the daemon before any state is touched. An invalid opt-in is
FATAL: it is never repaired, and never silently dropped to SNP-only.

**What is refused (tested):**

- `ekRoots` as a path. The relay's root loader would read a string with no `-----BEGIN` as a file.
- A PEM with a key block, or with text outside the certificate blocks.
- A non-CA certificate (an EK leaf), a duplicate certificate, or a bundle with no self-signed root.
- A root without a pin, a pin without a root, an intermediate pinned as a root, repeated pins, or uppercase pins.
- A wrong or missing `acceptTier`, a wrong format, unknown keys, or a missing limit.
- Every limit at min−1, max+1, as a fraction, or as a string.
- `--transport tunnel`.

**Tamper (tested):** each of these edits to a built measured module is refused by the daemon's own validator: a swapped
pin, an unpinned root added, a widened `maxAttestBytes`, a weakened `acceptTier`.

**Not from the host (tested):**

- `parseHostConfig` returns exactly its 7 fields when fw_cfg carries `shieldRecipients`, `ekRoots`, `ekRootPins` or
  `shield`.
- A source check on `daemon.mjs` confirms all of these:
  - `shieldCustodyFor(` appears exactly once, as `shieldCustodyFor(MEASURED.shieldRecipients, { party: encKey.slice(2) })`;
  - the only environment input is `CUSTODY_HOST_CONFIG`;
  - there is no `hc.shield` or `hc.ekRoots`;
  - the daemon has no route table of its own.

**Independent formation, governance and host ownership are unchanged.** `custodianMeasured` with owner permits plus the
opt-in keeps policy `owner-permits` and `needsDkg`. All formation, governance and ownership suites pass (section 5).

## 3. Party, and the binding at release

**The party is the custodian's own encKey.**

- The daemon passes `party` as the hex of `hpke.publicKeyOf(sealed encPrivate)`.
- `createCustodianV2` throws for an adapter whose party is any other key (tested).
- The session module refuses a `0x` or missing party (tested).
- `/v2/custody/info` advertises `shieldRecipients.party` as that encKey (tested), which is what the node's
  `custodianTargets` uses.

**At release.** A Shield document needs all of these:

- the adapter;
- the owner's Shield rules, with the exact T0-hv acknowledgement;
- a live session that **this custodian** challenged, for `keccak256(release endpoint)`;
- that session's signer equal to the release's **own agreed-read** `endpointOperator`;
- a report under that session's IDKS whose input binds the **ledger owner** `s.lease.owner` (F2).

Authorization stays `beneficialOwnerOf == policy.owner`. There is no relay verdict and no Enclave service: sessions are
per process and in memory.

**Tested over HTTP:**

- **The full flow.** The node's real session client (`windows/node/shield-sessions.mjs`) attests to the router at
  `party = encKey`. Then challenge and release go through `/v2/custody/challenge` and `/v2/custody/release`.
  - The answer opens only for the guest's R: DLEQ-verified, combined and decrypted to the owner's values.
  - Another key cannot open it.
- **A session-vault ledger owner.** A report binding the policy owner is refused (`evidence_refused` /guest binding
  differs/). A report binding the vault is released.
- **A moved beneficial owner** is refused with `owner_mismatch`.
- **A session for another party.** The operator signed an exchange naming another verifier. The session is stored, but
  its signer recovers to no registered operator, so the following release is refused with /registered operator/.

## 4. HTTP router and bounds

**Extraction.** The extracted router keeps every existing route, its order, the 405, the rate limiter (the same
`rateLimiter()`, with the first hop of `x-forwarded-for`), the 256 KiB bound, 400 for bad JSON, 404, and
Refusal→status/422 `refused`. One test drives all of these:

- `/health` and `/`;
- the custody routes `evidence`, `join`, `approve`, `host-binding`, `independent-genesis` and `code-approve`, with
  exact recorded arguments;
- 405, 400, 413 at 262145 bytes, 422 `bad_request`, 422 `refused`;
- 429 on the 31st POST from one client.

**Raw TPM logs: a bounded, documented size.**

- **Body bound.** Only `/v2/custody/shield-session/attest` takes `limits.maxAttestBytes`: default 4 MiB, hard maximum
  8 MiB, which covers a log of about 4.4 MiB against the verifier's 4 MiB log cap. The challenge route keeps 256 KiB.
- **Refusal.** A declared `Content-Length` over the bound gets 413 with nothing read. A streamed body gets 413 at the
  bound, with the rest discarded and not buffered.
- **Concurrency.** At most `maxConcurrentAttests` (1..4) at once; otherwise 503 before reading.
- **Deadline.** The whole body must arrive within `attestReadMs` (60 s), or 408.
- **Slot release.** A client that goes away mid-body gives its slot back.

All of this is tested over HTTP, including an attest body over 256 KiB but under the bound reaching the session check.

## 5. Image builder: transitive dependencies

**What the build checks now.** It runs both bundles (daemon and gsup) in memory first, takes every input from esbuild's
metafile, and requires each input, plus `STATIC_IMAGE_SOURCES`, to be **tracked** (`git ls-files`) and **clean**
(`git status --porcelain`). This happens before any Go, cargo or cpio work. `STATIC_IMAGE_SOURCES` is:

- `custody`;
- `isolation/m2/cmd/snpkey`, `isolation/m2/go.mod`, `isolation/m2/go.sum`;
- `relay/snp-verify.mjs`, `verifier`;
- the script itself;
- `package.json`, `package-lock.json`.

The old fixed list checked only `git status` over five paths. It could not see any input outside them, nor an ignored
file inside them.

**What the old list missed.** These bundle inputs were outside it:

- `availability/evidence.mjs`, `network/rpc-identity.mjs`, `isolation/contract/runtime.mjs`;
- `relay/{avf-verify, hvnode-core, hvnode-verify, shield-host-session, vbs-app-core, vbs-credential, vbs-policy, vbs-tcglog, vbs-tcglog-core, vbs-tpm, vbs-verify, vbs-vm-report, vbs-vm-report-core}.mjs`;
- `windows/node/{shield-verdict, hvnode-evidence}.mjs`.

The first three were already bundled and outside the old list before this change (imported by `custody/custodian.mjs`
and `custody/v2/{custodian, capacity, quorum}.mjs`), so that gap predates the Shield work. The rest come in with the
Shield path.

**Recorded in the manifest:**

- node_modules inputs, as `package@version` (for example, two viem versions are bundled: 2.53.1 and 2.54.3);
- `bundleInputs`;
- `bundler: esbuild@0.28.1`.

**Determinism.** `absWorkingDir` is now pinned to the repository, so the module path comments in the bundle no longer
depend on the caller's working directory.

**snpkey.** It imports only the standard library (`go list -deps`), so its directory plus the module files are its
whole source.

**Tests:**

- The actual daemon bundle with the opt-in contains the routes, the pin and the acknowledgement.
- Its metafile includes each relay and windows Shield module.
- The check asks git about exactly the static list plus the inputs.
- A fake git reporting one untracked input and one modified input yields exactly those two.
- An input outside the repository is refused.
- The script refuses a bad `--shield-recipients` file, malformed JSON, or tunnel with Shield, all before the base check.

**Today's tree.** The build would refuse right now, correctly: the Shield modules and the new custody files are
untracked or modified. They must be committed before any image is built from them.

## 6. Audit: replay, rate, abort cleanup, dependency closure

**Replay**

| Where | Result |
| --- | --- |
| Release challenge | Single use, consumed before the chain read. HTTP replay gives `bad_challenge` (tested). |
| Host-session credential challenge | Single use, deleted before any check. HTTP attest replay gives 409 `shield_session` (tested). |
| Operator release signature | Covers the binding, which includes each custodian's fresh nonce, and an expiry of 600 s or less. It cannot be replayed once the nonce is spent. |
| Guest report | Its input binds the same binding, so the same holds. |
| A session replayed at another custodian | That custodian never issued the session id (409). The attach message also names the party. |

**Rate and exhaustion**

- **Pre-existing, preserved: the rate limiter key is client-supplied.** The limiter keys on the first `x-forwarded-for`
  entry, which the client controls unless the operator's ingress overwrites it. This was not changed, because the task
  required preserving the existing bounds. Recommendation: key on the socket address, or require the ingress to set the
  header.
- **Fixed: one TPM could fill the session table.** A host's endpoint (and so its host id) is unverified until a release,
  so one real TPM could create `maxSessions` sessions for made-up endpoints and lock genuine hosts out with 429. Each EK
  now keeps at most 4 live sessions; a further one evicts that EK's oldest, never another TPM's.
  - Test: one TPM claims 6 endpoints and the table holds 4; a second TPM under the same CA attests, and its release
    passes; the squatter's next claim evicts only its own session.
  - Mutation: without the cap, that test fails.
- **Residual, not fixed: the pending-challenge table can be filled.** The challenge route builds a credential for any
  parseable EK certificate, with no chain check until attest. So self-made certificates can fill
  `maxPendingChallenges` (60 s each). This only delays Shield session formation; it cannot affect releases or SNP.
  - The fix belongs in the shared `relay/shield-host-session.mjs`: check the EK chain against the pinned roots at
    challenge time. That module is also used by the market verifier and the DNS responder, so I left it for coordinator
    review.
- **Bounded:** live sessions (by `maxSessions` and the per-EK cap), pending challenges, attests in flight, the
  rate-limiter map (100k entries), and the attest body and its read time.

**Abort cleanup**

- `readBody` settles on `end`, `error`, `close`, the deadline, or the 413. The concurrency slot is released in
  `finally`.
- Tested: a client destroyed mid-body, a body trickling past the deadline (408), and a slow body holding the slot (the
  next attest gets 503, and after it finishes a real attest passes).
- Mutations:
  - removing both abort handlers: the slot leaks, and the test fails;
  - removing the deadline: fails;
  - removing only `close`: survives, because Node 22 already emits `error` on an aborted request. The `close` handler
    is a backstop.

**Dependency closure:** section 5. Remaining assumptions:

- The base metal image is trusted through its manifest hashes, as before.
- The toolchains (Go via `GOTOOLCHAIN`, cargo via `--locked`) are pinned as before.
- esbuild is pinned by the clean lock and recorded in the manifest.

**Mutation checks (all detected):**

- the attest bound reduced to 256 KiB;
- no concurrency bound;
- no declared-length check;
- no party pin;
- F2 reverted (`pol.owner`);
- an unpinned root accepted;
- a non-CA certificate accepted;
- the dirty check limited to the static list;
- the party taken from the host config;
- both abort handlers removed;
- no read deadline;
- no per-EK cap.

At first, three of these were detected only as test timeouts. The tests now fail fast: the router's `close()` drops
connections, and one wait has a 5 s ceiling that applies only in the failure case.

## 7. Deviations from the early interface

- **Tunnel refused.** `--transport tunnel` with Shield is refused. The relay tunnel forwards only
  `relay/api-relay.js CUSTODY_SURFACES`, so a tunnel image could never serve the routes.
- **Two additions to the router:** an attest read deadline (`attestReadMs`, 60 s), and abort-safe body reads.
- **Per-EK cap.** `MAX_SESSIONS_PER_EK = 4` in `shield-evidence.mjs`, from the audit.
- **Wider pinned sources:** `isolation/m2/go.mod` and `go.sum` in the static sources, and the bundler version in the
  manifest.
- **Rig moved.** The rig moved to `test/helpers/shield-custody-rig.mjs`. `test/shield-custody.test.mjs` imports it and
  is otherwise unchanged.

## 8. Runs

All runs were serial, one file at a time (`--test-concurrency=1`). Available memory was checked against the 16 GiB
floor before each file and never went below 16 GiB. The final list: 25 files, 0 failures, 1 skipped.

| Suite | Result |
| --- | --- |
| `shield-custody` | 7 |
| `custody-v2-shield-daemon` | 8 |
| `custody-v2-build` | 10 |
| `custody-v2-protocol` | 8 |
| `custody-v2-release-authority` | 2 |
| `custody-vectors` | 2 |
| `custody-v2-e2e` | 1 |
| `custody-v2-independent-lifecycle` | 1 |
| `custody-v2-independent-runtime` | 4 |
| `custody-v2-independent-governance` | 2 |
| `custody-v2-independent-identity` | 3 |
| `custody-v2-host-ownership` | 3 |
| `custody-v2-chain-quorum` | 11 |
| `custody-v2-capacity` | 1 |
| `custody-v2-deploy` | 4 |
| `custody-direct-host` | 4 |
| `custody-direct-ingress` | 0 run, 1 skipped (it needs `CADDY_BIN`; pre-existing) |
| `custody-independent-admission` | 2 |
| `custody-independent-genesis` | 6 |
| `shield-dns-challenge` | 7 |
| `windows-shield-verifier` | 5 |
| `windows-shield-custody-transport` | 10 |
| `windows-shield-startup` | 14 |
| `relay-fresh-attestation-shield` | 1 |
| `verifier-hyperv-shield` | 7 |

`custody-v2-build` was rerun after the last script edit: 10/10.

**Cleanup:**

- Removed my test fixtures from `/tmp` (421 directories, 5.9 MB: `shield-custody-*`, `custodian-shield-build-*`,
  `custodian-build-*`) and my scratch files.
- Left alone: a running test process and the files `/tmp/runmon.sh` and `/tmp/mut.log`. They are not from this work.

## 9. Not claimed

- No image was built, measured, approved (`code-approve`) or activated.
- These changes alter the custodian bundle, and so the launch measurement of every image built from them, with or
  without the opt-in. Each needs a new `code-approve`.
- No real TPM, host, custodian, guest or chain session has run. Everything is synthetic or in-memory, on loopback.
- Still pending:
  - a measured Shield-direct guest image;
  - the 9445 transport on real hardware;
  - an owner policy with Shield rules;
  - the shared-module challenge hardening above;
  - the rate-limiter keying recommendation.
