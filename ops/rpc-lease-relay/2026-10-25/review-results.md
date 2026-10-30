## Round 2 (root review `lease-relay-root-review.md`, 2026-10-25)

Synthetic-chain tests only. Production is untouched: no live unit, service, SSH, key, wallet, commit or push.
Every test and build ran through `claude-test-queue.py` (caps 1024 / 1408; largest round-2 peak 758 MiB).

### Fixes

1. **The 10 s cut while a relay job waits** (root's main finding).
   - **Cause:** `startLeaseRelay` used `req.setTimeout(10_000)`, a socket-idle timeout that stayed armed while the job
     waited for its receipt. A relay job idle for more than 10 s lost its client: the host saw "fetch failed", as in r4.
   - **Fix:** two separate bounds. *Receipt*: the whole request (headers and body) within `bodyTimeoutMs` (10 s) of its
     arrival, else a flushed 408 and the connection is cut, so slow uploaders are still bounded. *Processing*: once a
     complete body is in, the receipt timer is cleared and only `requestTimeoutMs` (60 s) bounds the answer.
   - **Unchanged:** `sendQueue`/`inflight` still hold the key until the job ends, even after the client's answer timed
     out. The send record and same-byte recovery are unchanged.
   - **A bug I caught along the way:** a fully read `IncomingMessage` auto-destroys, so `req.destroyed` is no sign of a
     cut. The first memory runs got 408s from exactly that. It now uses an explicit `cut` flag.
2. **Orphaned Helios/listener processes.**
   - **Cause:** `network/rpc-runtime.mjs` starts Helios and the listener `detached` (their own process groups) and
     records them in its stateDir `children.json`. The test helper SIGKILLed only the launcher's group, without
     awaiting, so the runtime never ran its own teardown.
   - **Fix:** `test/helpers/verifier-runtime.mjs` `stop()` now remembers the recorded identities (pid + pgid + start
     time) and sends SIGTERM to the runtime, which stops its own children. It awaits the exit, bounded at 20 s, then
     escalates: SIGKILL of the launcher group, then only the remembered identities, re-checked in `/proc`. It returns a
     report.
   - `after()` now awaits it, in the new E2E and in `lease-gas-verifier.e2e`.
3. **Stale assertions.**
   - `lease-pinned-relay-config`: the loader's exact key list now includes `authority`. It checks `rpc-quorum` (all
     RPC clients, quorum 2), the explicit verifier env (one marked `local-verifier` client, required 1, RPCs unused),
     and that a verifier URL without the selection is refused.
   - `lease-relay-host-policy` cold start: base `6f2c7da46` set `PRODUCTION_MIRRORS = []`, so "tried the fleet
     mirrors" was impossible. The test only showed this once it stopped being skipped. Now, with mirrors configured it
     asserts they were tried and refused; with none, it asserts that **nothing** reached a fleet address and that the
     imported carrier alone admitted the relay. The fleet-only host must still never start. The production mirror list
     itself is not changed: that is root's decision.
4. **Memory headroom.** The double-memory assertion is kept. The release test now starts the artifact with exactly the
   unit's `ExecStart` node flags. `LEASE_RELAY_MEASURE_NODE_ARGS` exists for measurement runs only.

   | Measurement | Result |
   | --- | --- |
   | Bundle size | 334,255 bytes (base) → 348,674 (+`chain-authority`, `verified-chain`) |
   | Peak, base `9fa02e1bc` | 92.2, 93.8, 93.4 (+96.1) MiB |
   | Peak, worktree | 93.2, 99.1, 93.3 (+93.0, 104.6, 104.6) MiB |
   | Peak with `--max-semi-space-size=2` | 91.7, 91.8, 93.4 MiB, so not adopted |

   There is no difference between the builds beyond spikes, which occur on both sides; the 2× rule had no margin on
   this Node (v22.23.3). The source unit template changed `MemoryMax` from 192M to **224M** (2.14× the worst run; doc
   updated). The live unit is unchanged.

   Logs: `lease-relay-memory.summary`, `lease-relay-mem-*.tap` (the first worktree runs are in `logs/memory-r1/`; they
   hit the item-1 bug).
5. **Skipped admin-policy tests.** I built the forge subset in the worktree (`jobs/lease-relay-forge-subset.sh`, the same
   12 artifacts as `forge-subset.sh`, gitignored, peak 331 MiB). The 3 REAL-gate tests (cold start, anchored ban/unban,
   the real `run` CLI) now **run and pass**.
6. **Wording.** The simulation price is the effective price **in the anchor block it is simulated in**: that block's
   base fee + priority. It is not a promise about the inclusion block. The reserve charges on chain at inclusion,
   bounded beforehand by the owner's caps and the signed maximum. Updated in the code comment and the release doc.

### Results

| Run | Command / job | Result |
| --- | --- | --- |
| E2E r6 | `jobs/lease-relay-round2.sh` step 2 → `lease-relay-e2e-r6.summary` (the lease-relay-verifier and lease-gas-verifier E2E files) | **15 tests, 15 pass, 0 fail, 0 skipped** |
| Config unit suite | `lease-relay-r2-unit.out` | 5/5 |
| Legacy batch r2 | `jobs/lease-relay-round2b.sh` → `lease-relay-legacy-r2.tap` | 114: **113 pass, 1 fail, 0 skipped**. The fail was host-policy test 62 (the stale mirror assertion, fixed in item 3). Memory test passed at 104.6 MiB under 224M. |
| Host-policy rerun | `jobs/lease-relay-hostpolicy.sh` → `lease-relay-hostpolicy-r3.summary`, after the item-3 fix; only that file changed | **9/9 pass, 0 skipped** (cold start, ban/unban, CLI) |
| Earlier legacy r2 attempt | `lease-relay-legacy-r2-KILLED-partial.tap` | Killed with the previous session at test 28 (28 ok). It left no process. |

E2E r6, beyond r5:
- **30 s receipt wait:** the host got the relay's semantic 502 after 33.0 s ("…not confirmed by a verifier-checked
  receipt (broadcast unknown…").
- **Production waits** (request 60 s, receipt 120 s): the host got the relay's `502 relay: no answer within 60000 ms`
  after 62.4 s. The job kept the key until its end, and the same bytes landed after a restart.
- **Stalled upload:** cut with 408 at about 10 s.
- **Teardown:** report `{runtimeExit:{code:0}, escalated:false, killedChildren:[], leftover:[]}`. The recorded
  listener and Helios are gone, reth exited, and no process names the test's scratch paths.

Note: in production the HOST's own default `requestTimeoutMs` is 20 s, shorter than the relay's 60 s. It aborts first
and decides from the chain (findLanded, then nonce, then failover). That is unchanged by design and never a false
success.

### Process-scan evidence

- **Found before r6:** 10 orphans of my own r1–r5 jobs, from the old helper: 5 listener/Helios pairs under
  `test-scratch/lease-gas-verifier-*`, PPid 1.
  - Each start time falls inside one of my E2E job windows (12:17:56, 12:27:26, 12:40:28, 12:53:56, 13:02:35Z). The
    large queue lane allows only one job at a time, and the scratch dirs were already deleted.
  - Root's 13:18Z cleanup covered only `lease-relay-verifier-*`.
  - I sent SIGTERM after re-checking each identity (pid + start time + PPid 1 + path). All 10 exited; none was left
    after 5 s. Receipt: `logs/lease-relay-orphan-cleanup.json`.
- **r6 added none:** `lease-relay-procs-before.txt` and `-after-e2e.txt` held the same 10 pre-existing entries.
- **After the cleanup:** `lease-relay-procs-before-resume.txt` = 0, `lease-relay-procs-after-legacy.txt` = 0.
- **Anvil with PPid 1:** 25 (`lease-relay-orphan-anvil.txt`, `lease-relay-hostpolicy-r3-orphan-anvil.txt`). All started
  2026-10-13/14, not from these jobs, and **not touched**; listed for root.

### Reproducible relay artifacts (from the final source, built twice + host package `--check`)

`test-scratch/lease-relay-artifacts/`, hashes in `logs/lease-relay-artifacts.sha256`:

| Artifact | sha256 | Notes |
| --- | --- | --- |
| `lease-relay.mjs` | `633b313694e8cad95b5dcaf21b62d0b6b569bbe031f555379f52059ef4ab4e3e` | 348,674 bytes, 449 inputs; release-1 and release-2 byte-identical (`cmp`) |
| `lease-relay-check.mjs` | `e45e433cadf21291c0c36263e1dfaf341ab9b72ad34c401e60a77a7c6028098a` | 13,005 bytes |
| `manifest.json` | `1ccb7101ba346ce44908bf34572d8910e300e1be98fa8eb932c2b072023e7737` | identical across both builds |
| host package `lease-relay.package.json` | `ea685251dbc7805fe9890996ea8baf1e86573ad10652616bec901e85770725bd` | its bundle is the same `633b3136…`; the `--check` rebuild passed |

These are built, not staged or deployed. The test-only changes made after the build do not affect them: the bundle has
no test inputs.

### Final source (uncommitted; blob = `git hash-object`)

| File | Blob |
| --- | --- |
| client/lease-executor-client.mjs | fd114bae |
| network/lease-relay-service.mjs | 6fe68bdc |
| network/lease-relay-check.mjs | a2f287a3 |
| network/host-services/lease-relay-host.mjs | 1375f10a |
| relay/systemd/enclave-lease-relay.service | 5901a15d (MemoryMax 224M) |
| relay/lease-relay.env.example | 52cac614 |
| docs/network/lease-relay-release.md | 70483931 |
| test/helpers/verifier-runtime.mjs | 746d71fc |
| test/lease-relay-verifier.e2e.test.mjs | b4ada0c1 (new) |
| test/lease-relay-verifier-config.test.mjs | 12ddde70 (new) |
| test/lease-gas-verifier.e2e.test.mjs | 20632974 |
| test/lease-pinned-relay-config.test.mjs | d6daf2c2 |
| test/lease-relay-host-policy.test.mjs | 9444ef65 |
| test/lease-relay-release.test.mjs | fbe5b2cf |

`contracts/foundry/{out,cache}` (gitignored) and `node_modules` (symlink) are untracked.

### Still open (for root)

- **The pinned Helios `eth_call` defects** (`claude-lease-relay-helios-call-env.proposal.md`). The relay's override +
  anchor-price simulation is proven against reth on the dev chain only.
- **`PRODUCTION_MIRRORS` is empty at base.** That is a policy-distribution decision. Its comment still describes four
  regional endpoints.
- **`MemoryMax=224M` is a template change.** Any installed relay keeps its own value until a reviewed rollout.
- **The hosted-relay verifier fields** (`relay.chainVerifier` / `relay.txBackend`) have validation tests only, with no
  packaged run.
- **No live verification.** The live relay at `https://134.209.248.172` was not contacted or changed. A deployment
  needs review and sync first.

