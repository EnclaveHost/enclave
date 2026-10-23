# host-service-lifecycle: RESULT (2026-10-23 ~05:35Z)

**Status: SOURCE FIX + OFFLINE TESTS ONLY.**
- Not pushed, merged, imaged or deployed. The normal checkpoint (`main-repo`) was not touched.
- No SSH, production, live network, real signing or wallet use.
- C's tree (`windows-host-services-compose/candidate`) was only read: a local clone, and one `git fetch` of its newer
  commit into MY clone for a trial merge.
- Every build, test, scan and commit ran through `work/claude-test-queue.py` (16 GiB floor). Caps were 256, 512 and 768.
  - The multi-process suites peaked at 320-400 MiB.
  - The 16-suite regression and the artifact builds peaked at 513-613 MiB.
- One exception: early on I ran a single `node --check` (syntax only) outside the queue.
- Root owns review, composition and rollout.

## 1. Exact commits and patches

Repo: `work/resume-after-checkpoint-20261022/host-service-lifecycle/candidate`, branch `fix/host-service-lifecycle`, origin
removed. It is cloned from C's repo at exactly **`427780bbc0fc524f8091893614eae8a653518139`**. Author and committer of
every commit are SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>.

| commit | content |
|---|---|
| `24fb993c4f9df6868ca06f210ab7b9abec10e502` | the fix (runtime, transport, lifecycle, agent wiring) plus `test/host-service-lifecycle.test.mjs` |
| `862f65493faad2f99e568a752951dc999f10fa27` | `settleMs` becomes a constructor option (default 90 s, unchanged), plus 2 assertions. Mutant M1 had survived without them |
| **`6c38c0489d769db12e5037e7c20f7372e56d5620`** (final, tree `8532cb55`) | test only: the settle-bound test holds the event loop (§4) |

Patches (in this directory):
- `0001-…patch` `2c41885e…`, `0002-…patch` `943ea9ff…`, `0003-…patch` `4ccacd97…` (format-patch, full index);
- `host-service-lifecycle.patch` = `git diff 427780bbc 6c38c048`, sha256 `38c329d1…039e` (4 files, +529/−68).

Final source hashes (sha256):

| file | 427780bbc | 6c38c048 |
|---|---|---|
| `network/host-service-transport.mjs` | `de5bb98a…` (root's probe source) | `43e7c115…6c45d` |
| `network/wg-circuit-runtime.mjs` | | `77b842e8…045efd` |
| `network/privacy-agent.mjs` | `1d0c0f99…` | `54bb6d09…99d3` |
| `test/host-service-lifecycle.test.mjs` | (new) | `0c7c438b…b434` |

## 2. The defects, confirmed in the source flow

1. **Root's probe (`root-host-service-stop-race-result.json`, transport `de5bb98a`).**
   - `HostServiceTransport.close()` set `closed` and returned while `runtime.start()` was pending.
   - The live circuit that start then returned was inserted into the closed transport, with its exit grant never
     revoked.
   - `start()` then created its 15-s interval.
   - The `gate: () => !this.closed` the transport passed is used by `WgCircuitRuntime` only for an app's broker and
     egress, which a service circuit does not have. Nothing stopped the startup itself. The real runtime went on to:
     ask the exit for the grant, start the ingress worker, and return a usable circuit.
2. **`privacy-agent.mjs` `judge()`.** `judging = true` spans `await hostServices.start()`, one full first round (each grant
   request up to 15 s; the tunnel's readiness up to 45 s). A known admin refusal during that time was skipped by the 2-s
   timer until the startup returned. Then the circuit was live first and only withdrawn on the next tick.
3. **Found while testing.** A wait that a close rejected (the tunnel's or the worker's readiness) left its 45-s or 15-s
   timeout armed. A stopped startup kept a timer alive.
   - Measured: suite duration 45.3 s, down to 3.8 s after the fix.
   - Measured: the base control's slow-handshake case waited the full 45 s.

## 3. The fix

**`WgCircuitRuntime.start({…, signal})`** (shared `AbortSignal`, no new framework):
- **A stop ends the startup at its next step** with `err.cancelled`:
  - the waits pending at that moment are rejected at once and their timeouts cleared;
  - every child is killed by the circuit's own `close()`.
- **A grant request already sent is never cut off.** Its answer is awaited, so any withdrawal is ordered AFTER it. The
  provider serializes service grants and revokes (`serial()`).
- **A host-service circuit that asked its exit and does not come up** (cancelled, or failed: names mismatch, worker
  timeout, …) **withdraws that grant**: a signed `revoke` through its still-running guard tunnel, before its processes end.
  - An explicit refusal (HTTP 403, so no peer) needs none.
  - If the tunnel is already gone, or the revoke fails, the log says so and the grant lapses at its expiry (≤ 10 min,
    `PEER_TTL_MS`). Its names then route to a WireGuard key whose holder process is dead, so nothing is served. Before
    this fix a failed service startup ALWAYS left its exit grant until expiry.
- App and control circuits are unchanged, except that they accept the same optional `signal`. No caller but host
  services passes one yet.

**`HostServiceTransport`:**
- **`close()` is idempotent** (one promise):
  1. closed, timer cleared, startups cancelled;
  2. **the live circuits are withdrawn and closed first**;
  3. then the cancelled round is awaited, bounded by `settleMs` (90 s).
- **A circuit a runtime returns after the stop** (one that ignores the signal, or finished first) is withdrawn and closed
  (`retire`) **and never inserted**. That also holds past the settle bound.
- **No timer:** `start()` creates none once closed.
- **No strike:** a cancelled startup is no strike or cooldown against the providers.
- **Unchanged:** the provider checks, the 15-s round and the per-exit failover.

**`hostServiceLifecycle({refusal, create, log})`** (exported beside the transport; `privacy-agent.mjs` uses it in place of
its inline judge):
- **One transport at a time.**
- **A refusal stops the current transport, also one still in its first round, at once.** The startup is cancelled, not
  awaited.
- **Only an admit creates a FRESH transport.** It is started without being awaited, so judging continues every 2 s.
- **A startup that settles after its transport was replaced or stopped closes only its own transport** (idempotent close),
  never the current one.
- **A transport that cannot be built** refuses host services for the process, as before.
- **`close()` resolves once every transport it stopped has closed.** The agent's SIGTERM path and its startup-failure
  paths call it.

**Unchanged administration:**
- the same gate (`serviceRefusal`), the same sticky refusal until the admin's admit, the same explicit fresh admit;
- the exits still judge the platform host policy before every grant (wg-provider `admitHost`);
- host ownership, apps, the runtime and app circuits are untouched by a host-service stop.

## 4. Evidence (actual terminal results; logs in `logs/`)

**The new suite: `test/host-service-lifecycle.test.mjs`, 10 tests.** It runs the REAL control flow:
- the real `WgCircuitRuntime` (plain);
- the real `WgGrants`, signing with throwaway keys;
- two real `WgProvider` instances behind their real control HTTP servers on loopback (guard 127.0.0.1, exits 127.0.0.2/.3),
  each with an in-memory kernel table;
- the real host-service ingress worker process.

Only the WireGuard data plane is a stand-in: a small "wg" process that forwards the exit's control API and reports
readiness.

The agent's host-service block is the actual text of `network/privacy-agent.mjs`. It is sliced from the source and run
with its free variables bound, so the same file is also the control on the older tree.

The 10 cases:
1. Root's race with the real runtime: close while the exit grant is in flight → no circuit, 1 revoke, 0 service peers at
   the exit, no child, no timer, runtime still open.
2. Close during a slow tunnel handshake → ends in < 10 s, the exit is never asked, no strike.
3. A ban during a BACKGROUND reconcile (2 exits) → the live circuit is withdrawn while the second startup is still
   pending; that one is withdrawn when it answers.
4. Delayed failure: the exit refuses the grant it held → no revoke needed, none sent.
5. Delayed failure AFTER a grant (names mismatch) → the grant is withdrawn (it formerly stayed until expiry); the strike
   is kept.
6. The agent switch: a ban during the FIRST startup → stopped at once, the late grant withdrawn, no circuit came up. Then
   the admin's re-admit gives a fresh transport that serves (HTTP through the ingress worker reaches the role), with
   exactly one service peer at the exit.
7. The agent switch: a ban during a BACKGROUND round of a serving transport → everything withdrawn. **A healthy app
   circuit** (egress-only, same runtime and providers) stays up, keeps carrying traffic and keeps its exit peer.
8. Agent stop during a startup → `close()` waits for the cancelled startup; a later `judge()` starts nothing.
9. Root's probe shape (a runtime that ignores the stop) → the late circuit is withdrawn and closed, never inserted or "up";
   no timer.
10. A startup that outlives the settle bound → `close()` resolves at the bound; the late circuit is still withdrawn when it
    answers.

| run | cap | tree | result |
|---|---|---|---|
| `c3-commit-v1` | 512 | **6c38c048** | **27/27**: the new suite 10/10, plus `host-service-transport` and `privacy-agent-lifecycle` |
| `v2-verify` (V2) | 512 | **exact 427780bbc**, same test file `0c7c438b` | **CONTROL: 0/10, all 10 fail on behaviour**: circuit inserted after close; stop waits 45 s; late grant not withdrawn; strike on own stop; mismatched grant left at the exit; ban not acted on during startup; stop does not wait; no stop signal |
| `v2-verify` (V3) | 512 | mutants of **6c38c048** | **6/6 killed by assertions** (fail counts 2/6/1/5/1/2+1). M1: insert after close. M2: no withdrawal on a failed start. M3: no abort listener. M4: timer after close. M5: judge awaits the startup. M6: close waits before withdrawing the live circuits |
| `r1-regression` | 768 | the fix's content (= 24fb993c) | **102/104**: C's exact final 12-suite set (`c15`: 82/82 on 427780bb) plus the new suite, `wg-renewal`, `egress-probes` and `provider-canary-independent`. The 2 failures were environment-only (below) |
| `r1b-runtime-bundle` | 768 | same | the gitignored `relay/network-runtime.bundle.mjs` built from these sources = **`dced8384`, byte-identical to C's**. The 2 environment failures (`challenge-replica-host`, `network-consumer-bundle`) **10/10**. Regression total 104/104 |
| `a2-final` | 768 | **6c38c048** | scans of `427780bbc..6c38c048`: `scan-crypto-keys --range` 0, gitleaks "no leaks found" (`gitleaks-range.json` = `[]`). `host-services-cold-start` (real privacy-agent processes, the real platform-policy gate, the shipped bundle) **12/12**. Artifacts §5 |
| `k1-compose` | 256 | | `git merge-tree` of 6c38c048 onto **C's newer head `0757085e5`** (host-policy carriers): **clean** (`privacy-agent.mjs` auto-merges), merged tree `1a679ef3`. **Not tested on the merged tree** |

**Superseded runs, kept for honesty:**
- `l1-candidate` was a harness race in my egress echo, now fixed.
- `l2-control` hit the base file's 45-s wait and was cancelled; `l2b` is complete.
- `v1-verify`: the settle-bound test was cancelled by node ("event loop already resolved"), because `close()`'s settle
  timer is unref'd by design and the stand-in held no I/O. That is a test-only fix in 6c38c048. The candidate's own
  27/27 and the mutant/control reruns are on 6c38c048.

## 5. Changed package and bundle inputs: dependency closure

All JS release artifacts were rebuilt from 6c38c048 (`artifacts-final.sh`, Go deliberately denied) and compared with C's
reproducible 427780bb set (`windows-host-services-compose/cold/artifacts.sha256`; full list in
`artifacts-6c38c048.sha256`):

| artifact | 427780bb | 6c38c048 |
|---|---|---|
| `dist/privacy-agent.mjs` (network/build.mjs; Windows agent) | `e0a6abab…` | **`6f5b5043c15154f51a2f5f5092539bed51f0b919f2e4e41be1d3dde967cade43`** |
| `consumers/privacy-agent.mjs` (scripts/network/build-consumers.mjs) | `fdd3a4a4…` | **`fbd61422bc734e4a40af67cafc5aa10892604f5b09820e58fc0badc21b5fff2c`** |

**The other 20 JS artifacts are byte-identical**:
- `relay/network-runtime.bundle.mjs` `dced8384`;
- all 5 host-service packages and their manifests (bootstrap-replica, credit-vault-submitter, directory-replica,
  policy-mirror, route-dns);
- the consumers `provider`, `dns` and `checker`;
- `dist/` `host-service-ingress`, `windows-circuit-worker`, `wg-provider`, `wg-qualify`, `enclave-directory` and
  `reconcile-apps`.

**So only the privacy agent bundles need rebuilding. The host-service package manifests C pinned stay valid.**

**Go artifacts** (`enclave-wg`, `enclave-wg.exe`, `enclave-circuit-firewall.exe`): no Go source changed, so none was built
here. They embed `vcs.revision`/`vcs.modified`, so binaries built from a new commit will differ by that stamp alone.
Build them per C's recipe before generating packages.

**Closure:**
- `network/privacy-agent.mjs` → `host-service-transport.mjs` (lifecycle + transport) and `wg-circuit-runtime.mjs`
  (through `enclave-network-host.mjs`).
- No other shipped entry includes the changed code paths.

## 6. Activation and rollback implications (root's)

- **Composition:**
  - C has since committed `0757085e5` (policy carriers) on 427780bbc. My series merges cleanly onto it textually.
  - The lifecycle takes only `refusal: () => hostGate.serviceRefusal()`, so C's carrier gate needs to keep that
    interface.
  - Re-run the new suite and `host-services-cold-start` on the composed tree, then rebuild the two privacy-agent bundles
    from the composed commit.
- **Activation:**
  - Ship the rebuilt privacy-agent bundle: Windows `dist/privacy-agent.mjs`, and the consumer bundle wherever it is
    used.
  - It needs no config change, no new field and no package change.
  - A running agent picks it up only on restart. Restarting withholds apps for the usual ~48-68 s; follow the existing
    node-restart window rules.
- **Rollback:** the previous privacy-agent bundle. Nothing persistent changes: no state format, and no provider or
  contract change.
- **Behaviour change visible to operators:**
  - On a ban, host services stop at once, even mid-startup.
  - A failed or cancelled service startup now withdraws its exit grant, where it used to leave it to expire.
  - New log lines: `host service circuit startup ended: …`, `host service grant at … withdrawn / not withdrawn: …; the
    grant lapses at its expiry`, `… still running N s after the stop …`.

## 7. Limits (not claimed)

- **Data plane:**
  - No real WireGuard, kernel, Windows firewall or production provider was involved; the stand-in "wg" only forwards
    the control API.
  - Windows-only cleanup (`firewall remove`) on a cancelled startup is not exercised (plain platform).
- **Grants already processed cannot be recalled.** Guarantees:
  - the host side never makes a late circuit usable (no insertion; its processes are killed);
  - its exit grant is withdrawn whenever the guard tunnel still runs;
  - otherwise the grant lapses at its expiry (≤ 10 min) and routes to a dead key.
- **Guard grants carry no names.** They are not revocable by the host (provider rule) and lapse at expiry (≤ 10 min), as
  before.
- **A runtime that ignores the stop** (none in this tree) makes `close()` wait up to `settleMs` (90 s) before resolving.
  Root's original probe script awaits `close()` BEFORE releasing its stand-in, so it would now take 90 s and then report
  the clean result. Test case 9 runs that shape with close and release interleaved.
- **The agent's judge is tested as its actual source block with bound variables**, plus the daemon-level
  `host-services-cold-start` (12/12). There is no daemon-level ban-during-startup run with real providers.
- **`WgControlTransport` (the host's own control circuits) has the same insert-after-await and timer-after-start shape.**
  - It is closed only at process stop (or a startup failure), right before `runtime.close()`, which closes in-flight
    circuits too.
  - Control peers are egress-only, with no public names.
  - Unchanged here; a follow-up can pass it the same `signal`.
- **Not re-run:** C's full matrix and the forge-dependent hosted e2e (they skip without `contracts/foundry/out`).
- **This is not a deployment or completion claim** for the host-services workstream or the overall goal.

## 8. Files here

- **Patches and commit messages:** `0001-0003-*.patch`, `host-service-lifecycle.patch`, `commit-msg*.txt`.
- **Job scripts:** `setup.sh`, `job.sh`, `q.sh`, `build-runtime.sh`, `artifacts*.sh`, `verify*.sh`, `mutants.py`,
  `compose-check.sh`, and `commit*.sh`.
- **Evidence:** `logs/*.{out,guard.log,rc}`, `artifacts-*.sha256`, `gitleaks-range.json`.
- **Scratch trees (mine; disposable):**
  - `base/`: worktree of 427780bbc for the control;
  - `mut/`: worktree of 6c38c048 for mutants;
  - their `node_modules` are symlinks to the candidate's real copies, which come from C's tree.
