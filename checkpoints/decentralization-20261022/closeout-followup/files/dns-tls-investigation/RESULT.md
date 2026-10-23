# EnclaveDNS (0x59f1273d) certificate delay and route gap: diagnosis and candidate fix (RESULT; source only, root activates)

Live state is recovered: ZeroSSL until 2027-01-20, public HTTPS 200 on both routes, and DNSSEC tests passing
(`outputs/decentralization-audit/enclavedns-tls-20261023.json`). Nothing live was touched. The causes below are what made
recovery take until 00:28:55Z, and they can recur.

**Lineage.** The files involved are byte-identical in the installed relay tree
(`relay-release-list-review/tmp/installed-tree`), the relay candidate ad074e2 and the adapter candidate:
- relay/certs.js 237834d8, relay/shield-marketplace.mjs 463f11fe, relay/shield-app-verifier.mjs 2e1c0347,
  relay/measurement-predict.mjs a6372f41;
- network/guest-probe.mjs e26da7ff, network/local-app-transport.mjs 4c4b3ce1;
- windows/node/hvcert.mjs 3a87d9b8, windows/node/apptls.mjs 2fb25b00.

## 1. Why a request for an already-issued (cached) certificate exceeded the timeout

1. **The node aborts at 60 s.** It POSTs `/v1/certs/issue` with `AbortSignal.timeout(60_000)`
   (`windows/node/apptls.mjs:128`). "The operation was aborted due to timeout" at 00:05:46 and 00:13:46 is that abort;
   the guest-side steps fail with a different message.
2. **The evidence check comes before the cache.** On a Shield host (`appEvidenceRequired`), the relay awaits
   `ctx.verifyAppCertificate` with no bound BEFORE its cache lookup (`relay/certs.js:981-991`; cache at 993-995). A
   certificate the relay had issued at 23:59:06 was still behind the full verification.
3. **That verification is a full re-run on every request.** `shieldMarket.certificate` → `admit`
   (`relay/shield-marketplace.mjs:47-75`) runs:
   - `confirmRow` (chain quorum) before and after the proof;
   - `readCatalog`;
   - the config fetch;
   - **the catalog component `fetchVerified`** (`relay/shield-app-verifier.mjs:92-93`);
   - up to 3 jittered evidence fetches through the tunnel.
4. **The component re-fetch is the slow and intermittent step.**
   - EnclaveDNS's component is `bafybeic3peeqxip4w2sxz66krxbhkjygfnkqyigdgvoajw6moykvtkfeau`, a UnixFS DAG of 11
     blocks (`dns-artifact-recovery/RESULT.md:10-12`).
   - `fetchVerified` keeps ONLY raw-CID components on disk (`rawCidDigest`, `heldComponent`), so this one was re-fetched
     through the gateways on EVERY verification (`relay/measurement-predict.mjs:632-663`). Each fetch was bounded only by
     the predictor's `timeoutMs` (default 240 s, line 225).
   - The gateways serve it from the s3-ipfs-adapter / sia-s3 path, which was itself unstable. Slow means past the 60-s
     abort; failed means "catalog component could not be CID-verified" (a transient refusal).

## 2. How the node's retry reacts to `app_evidence_required` and to the abort

- **Both count as failures** (`windows/node/hvcert.mjs:121-149`). The relay's 403 `app_evidence_required` carries no
  retry hint, and the abort throws. The wait is `30 s × 2^(n−1)`, up to 1 h. Only a 202 with `retryAfterSec`
  (`certPending`) is excluded from the count.
- **The wait is measured from the attempt's START** (`t = now()` at the top of `one()`). This explains the timeline
  exactly:
  - refused ~00:00:55 → 240 s;
  - 00:04:55 → abort at 00:05:46 → 480 s;
  - 00:12:55 → abort at 00:13:46 → 960 s;
  - next attempt at 00:28:55 = the install.
- **Effect:** a relay-side slowdown of a few minutes turned into a 16-minute certificate gap, and the next one would be
  32 minutes.

## 3. Why the DNS route was missing after the certificate was installed

- **The route needs a current LOCAL guest proof** from the privacy agent (`network/privacy-agent.mjs:117-136`,
  `admission.allows`, line 339).
- **For an app without startup egress, that proof's TLS uses default WebPKI verification.** `LocalAppHttpsAgent` gets
  `attestationOnly: startupEgress` (`network/guest-probe.mjs:43`); otherwise `tls.connect` keeps
  `rejectUnauthorized` (`network/local-app-transport.mjs:36`).
- **So the self-signed fallback failed every proof.** network.log shows "local guest proof 0x59f1273d: self-signed
  certificate" every minute until 00:28:33. Egress was off and no route was published.
- **After the install it recovered by itself.** The proof passed and network.log has "app 0x59f1273d egress back" at
  **00:29:14**.
- **`routes.json` (updatedAt 00:29:09) was written 5 s before that**, so its missing 59f1 entry is ordering, not a new
  fault. Root's 00:30–00:31 probes confirm both routes.
- **Policy note, root's decision, not changed here.** The WebPKI requirement on the LOCAL proof is the default, not a
  decision:
  - `attestationOnly` was added in 4972d0ff7 (2026-10-02) only for startup egress.
  - fd35560b2 states the intent that "the locally attested key authenticates a route even before its WebPKI certificate
    is installed".
  - Relaxing it would publish routes for apps still on their self-signed certificate. That is a TLS-gating change, so it
    is not made.

## 4. Is serving-first e7 + keeper sufficient?

**No.**
- e7e5057a and the 2afa keeper change `windows/node/host.mjs` only: pass ordering and lease renewal.
- The certificate pass runs from `windows/node/agent.mjs:1140` (hvcert).
- The slow path is in the relay, and the route gate is in the privacy agent.

None of the three is touched by e7 + keeper.

## 5. Candidate fix (isolated; every authorization stays fresh)

**Workspace.** `dns-tls-investigation/candidate`: a `git clone --local --no-hardlinks` of ad074e2 (the installed relay
lineage for these files), branch `work/cert-verdict-reuse`, uncommitted. The patch is `dns-tls-fix.patch`
(`40499a45…`).

**The withdrawn first attempt.** A whole-verdict reuse in `shieldMarketplace.certificate` is kept only as
`rejected-verdict-reuse.patch` (`25b29207…`) for review and as a mutant. Root found it would skip `admit`'s fresh
`confirmRow` and catalog checks for up to 120 s. `relay/shield-marketplace.mjs` is back to the installed `463f11fe`.

| file | base → candidate | change |
|---|---|---|
| `relay/measurement-predict.mjs` | a6372f41 → `b2a39242…` | `fetchVerified` keeps the CAR-verified bytes of a **DAG** CID in `components/` and serves them again only while they hash to the sha256 THIS process recorded when it verified them. The digest lives in memory only, bounded by `cacheMax`, so a restart fetches again and disk alone is never trusted. A changed copy or a smaller `maxBytes` is never served. Raw CIDs are unchanged. |
| `relay/certs.js` | 237834d8 → `77a0d398…` | 6c (Shield app evidence) is bounded. One verification per (endpoint, deployment, CSR key) runs at a time, and requests for the same key join it. If it has not settled within `CERTS_EVIDENCE_WAIT_MS` (40 s, under the node's 60-s abort), the answer is **202 `retryAfterSec: 30`**, which issues and serves nothing. A settled verdict answers only the requests waiting on it; the next request verifies afresh. |

**What stays fresh on every request** (unchanged code):
- `confirmRow` ×2;
- `readCatalog` and `versionRefusal` (listing, approval, yank, pending + owner exception);
- the secrets rule and the session;
- the fresh guest evidence with its nonce;
- the CSR key == the attested key;
- certs.js steps 1–6b (operator signature, lease holder, eligibility).

**What is cached:** only the bytes of an immutable CID that a fresh catalog read named.

**Effect on the node:** a slow evidence round now yields a 202. The node's issuer treats that as pending
(`hvcert.mjs:91-98`), so the back-off no longer escalates.

**Not changed (root's options):**
- the local-proof WebPKI requirement (§3);
- counting `app_evidence_required` as a failure on the node;
- the per-request evidence fetch itself (still fresh, by design).

## 6. Tests (one queued job, cap 512, offline netns; `logs/run3.log` b08f56bf…, peak 180 MiB)

`jobs-run.sh` runs root's `job-tests.sh` copy (only `HERE` differs) on three trees, all at ad074e2.

| tree | files | result | expected |
|---|---|---|---|
| **candidate** (fix + tests) | shield-market-cert-authority (new), shield-marketplace, shield-app-verifier, relay-shield-app-fresh, certs, measurement-predict | **108/110**. The 2 failures are the pre-existing rule pins below | all pass except the pre-existing pins |
| **base** (installed sources + new tests) | shield-market-cert-authority | **5/5** | pass: the installed code already re-authorizes every request |
| **base** | certs + measurement-predict | fails exactly: the new **202 test** (an assertion at 1.09 s: the unbounded wait answered 200, not 202) and the new **DAG-cache test**, plus the 2 pre-existing pins | the new tests FAIL without the fix |
| **rejected** verdict-reuse patch | shield-market-cert-authority | **4 of 5 FAIL** (fresh chain/catalog reads, catalog change under the same appRef, a stale caller row, an unavailable read) | catches the regression root found |

**New tests.**
- `test/shield-market-cert-authority.test.mjs` (`da3c0019…`, new):
  - every request reads the chain row twice and the catalog once, even right after a success;
  - a catalog change under the SAME appRef (rejected, yanked, back to pending, delisted, unreadable) refuses;
  - the chain row decides over the caller's stale row (lease moved, ended, deployment stopped or private);
  - a PENDING version is certified only while its owner is served; staged secrets refuse;
  - an unavailable chain or catalog read refuses, and the earlier grant is not extended (it lapses at its own TTL).
- `test/certs.test.mjs` (`effc810a…`, +1 test, env `CERTS_EVIDENCE_WAIT_MS=300`):
  - a slow verification answers 202 with no certificate and no order;
  - the retry for the same key joins the same verification (one call) and gets 200 when it settles;
  - the next request verifies afresh and is refused (403 `app_evidence_required`) even though a certificate for that key
    is now cached.
- `test/measurement-predict.test.mjs` (`ed148964…`, +1 test): for a DAG CID,
  - the kept copy is served with the gateway down;
  - a tampered copy is never served (unavailable, or re-fetched and verified);
  - a smaller `maxBytes` is not served from it;
  - a new predictor on the same work directory (a restart) fetches again.

**Pre-existing, unchanged by this patch, NOT fixed here.** `measurement-predict.test.mjs` "the supervisor's rule is
pinned…" and "V4 predictor matches the committed Shield scheduler rule" fail identically on the unchanged installed
sources: `supervisor.js` 89ebb50a carries rule sha `2ab8d678…`, while the predictor pins `0c059670…`. The patch touches
neither file. It is a predictor-vs-supervisor pin drift in this lineage that root should know about separately.

**A note on my own test.** My first owner-exception case assumed losing the owner exception refuses an APPROVED version.
It does not, by design (the exception only unlocks pending versions), so the test was corrected to a pending version
before this run. Market apps are not refused on an ownership transfer alone. That is certs.js's `ownerServesDeployment`
gate for hv-node rows, unchanged.

## 7. Source commit

- **Commit `a2b8fabd2c0b5685aeff6ef159a745a1f3b889c5`** on branch `work/cert-verdict-reuse` of `candidate/` (parent
  ad074e2).
  - Author and committer: SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>.
  - Five files: relay/certs.js `77a0d398…`, relay/measurement-predict.mjs `b2a39242…`, and the three test files of §6.
  - `node_modules` is NOT committed: it is an untracked symlink.
- **`dns-tls-fix.patch` (`40499a45…`)** is byte-identical to `git diff ad074e2 a2b8fabd -- relay/`.
- **The app source bytes are final** and unchanged since root's review.

## 8. Root-run two-file rollout (`rollout/`; prepared and tested offline only: nothing was staged, sent or restarted)

| file | sha256 |
|---|---|
| `rollout/deploy-two-file.py` (local, root runs it) | `0d6e269c5df81914c5adf4a5280d210ca739f15bbe7f20675c020f9f916017b0` |
| `rollout/remote_two_file.py` (sent over SSH; pinned in the deployer as `REMOTE_SHA`) | `460ee850e9d53fb5b246c28c29c8210bbc1dcddd311cfdb7b56c35d9e90ea672` |
| `rollout/test_two_file.py` | `658bb92ade11d582cb438707be87e23165abb90c63cfecea3ad517d5151d3955` |
| `rollout/run-tests.sh` | `fbee5780…` |

**Pattern.** It is the same as `relay-release-live/deploy-reviewed.py` (r2):
- one `sudo python3 -` over `ssh -p 32423 controladmin@127.0.0.1` with `UserKnownHostsFile=work/control-vm/known_hosts`
  and key `~/.ssh/minipc`, run from the `wo/` root (the deployer sets `cwd` itself);
- pinned bytes, exact-hash CAS, a backup before any swap, `node --check` on a temp beside the target, `os.replace`, one
  restart, loopback probes and a JSON receipt (`rollout/results/<mode>-<UTC>.json`).

**What it does not do:** read a key, send a log, run any command or path that is not pinned, or touch any other source,
config or environment.

**Pins.**
- Commit `a2b8fabd`: the new bytes are read with `git show <commit>:<path>`, never from the working tree.
- Old hashes: certs.js `237834d8eed6e0f3…`, measurement-predict.mjs `a6372f419adcb724…` (root's control-VM read).
- New hashes: `77a0d398…`, `b2a39242…`.
- Unit `enclave-api-relay`, MainPID `222659`. A different PID refuses: re-read it and pass `--expected-pid N`, accepted
  for preflight/apply only.
- Files: `/opt/nan-relay/{certs.js, measurement-predict.mjs}`; backup `/var/backups/enclave-dns-tls-20261023` (0700,
  files 0600); temps `<stem>.dns-tls-candidate.<ext>` beside each target.
- `/usr/bin/systemctl`, `/usr/bin/node`, probes on `http://127.0.0.1:8100`.

**Commands** (root, from `work/resume-after-checkpoint-20261022/dns-tls-investigation/rollout`):
1. `python3 deploy-two-file.py preflight` (read-only). It checks:
   - the unit is active with the pinned MainPID;
   - both files are at their exact OLD sha256;
   - `node --check` accepts both INSTALLED files (otherwise the method is invalid on this VM: an ESM `.js` on an older
     Node refuses here, safely);
   - no backup or temp exists;
   - the baseline probes are EXACTLY `GET /v1/certs/issue` → 405 `method_not_allowed` and
     `GET /v1/secrets/release-status?id=0x59f1273d…` → 200 `{id, listed: true}`. An unchanged 500 refuses.
2. `python3 deploy-two-file.py apply`. It runs the same checks, then:
   1. writes both temps (sha256 + `node --check`; a refusal removes them and leaves no backup);
   2. backs up both old files, re-read and verified;
   3. **re-checks the identity and both old hashes immediately before the first swap**;
   4. replaces both and verifies both new;
   5. **ONE restart**, recorded as an attempt BEFORE the call;
   6. waits up to 60 s for a NEW MainPID, active, answering exactly the expected probes;
   7. → `DEPLOYED_READY`, with `pending` = the functional proof (the next Shield certificate request answers 200 or 202
      within 40 s, and the node shows no new 60-s abort).
3. `python3 deploy-two-file.py status` (read-only): hashes, MainPID, probes, and `<backup>/result.json`.
4. `python3 deploy-two-file.py rollback` (explicit): both backups verified old, and each target old or new (anything
   else refuses). It restores both, verifies, makes ONE restart, waits for the expected probes, and returns
   `ROLLED_BACK_READY`, or `ROLLBACK_NOT_READY` (a failure) or `NOTHING_TO_ROLL_BACK`.

**Automatic recovery inside `apply` (root review 2026-10-23):**
- **Every target not at its old sha256 is restored** and verified. This covers a partial swap in which the second
  replace failed.
- **If a restart was attempted, even one that timed out after starting the service:** one rollback restart (also
  recorded before the call), then a NEW MainPID must answer the expected probes. The result is `ROLLED_BACK` only if
  that is verified; otherwise `ROLLBACK_NOT_READY` (a failure; root acts).
- **If no restart was attempted:** the ORIGINAL process must still be the MainPID and answer the expected probes.
- **A file that cannot be proven back** gives `RESTORE_UNVERIFIED`, and nothing more is done.
- **Nothing is retried** beyond that one rollback restart.

**Bounds and uncertain outcomes.**
- Per call: systemctl reads 5 s, a restart 45 s, `node --check` 15 s, each probe 5 s, readiness 60 s plus one
  iteration.
- Worst path (all checks, the apply restart and readiness, then the rollback restart and readiness): **347 s**
  (`REMOTE_WORST_SEC`, derived in the deployer). The SSH wait is **420 s** (asserted ≥ worst + 60).
- **If the deployer gets no result** (timeout or dropped session), it writes `UNCERTAIN` and exits 2. Never re-run
  apply or rollback on that; run `status`.
  - The remote program ignores SIGHUP, so it finishes and records `result.json` in the backup directory.

**Exit codes:** 0 for PREFLIGHT_OK, STATUS, DEPLOYED_READY, ROLLED_BACK_READY or NOTHING_TO_ROLL_BACK; 1 for any other
status; 2 for UNCERTAIN.

**Tests** (`logs/rollout-r3.log`, queue 256, offline netns, ssh stubs, 19/19 in 29 s, peak 92 MiB). They use the real
`node --check` on the real old (ad074e2) and new (a2b8fabd) bytes, a fake `systemctl` with a state file, and a stub relay
on loopback. The cases:
- the pins equal the commit and the installed lineage; a tampered remote program, an unknown mode or a malformed PID
  refuse before any SSH;
- preflight is read-only; preflight and apply refuse on PID, inactive unit, old sha, an existing backup, a leftover temp
  and a silent relay;
- **an unexpected but unchanged baseline (500/500) refuses**;
- `node --check` must accept the installed files;
- success: both new, one restart, a new PID, backups 0700/0600, mode kept; a second apply refuses;
- a new file `node --check` refuses: nothing changes and no backup is left;
- a failed restart: restored, one rollback restart, verified;
- a relay answering differently on the new code: restored and verified;
- **a restart that TIMES OUT after starting the service: `[apply, timeout] + [rollback, 0]`, the old code verified on a
  process started after the restore**;
- **both restarts time out: `ROLLBACK_NOT_READY`**; a failed rollback restart: `ROLLBACK_NOT_READY`, no third restart;
- **the second replace fails: the first is restored, nothing restarted, the original process verified**;
- **the identity re-check before the swap: another MainPID refuses with nothing swapped**;
- **the hash re-check before the swap: a file changed after the backups refuses with nothing swapped**;
- an explicit rollback (one restart), then NOTHING_TO_ROLL_BACK; rollback refusals (no backup, unknown bytes, a changed
  backup); `status`.

**Timing (root):** do not overlap the relay restart with the Windows updater (01:13:36) or the node-only window after
01:15. The relay restart briefly interrupts api.enclave.host certificate, secrets and release-status answers; the probes
bound that to the readiness window.

## 9. Publication allowlist and scans

- **`ALLOWLIST.txt`** lists the 18 exact files for the shared checkpoint (publication is worker E's scope; I did not
  copy, commit or push anything there). It excludes `candidate/node_modules`, the `base/` and `rejected/` scratch clones,
  `stubs/`, `tmp/`, `logs/`, `rollout/tmp/`, `rollout/results/` and `__pycache__/`.
- **Scans** on exactly those files (queue 256): the repository's `.githooks/scan-crypto-keys.py --files` exits 0, and
  `gitleaks dir --config .gitleaks.toml` over a staged copy of only those files finds 0 leaks (`logs/allowlist-scan*.log`,
  `logs/allowlist-gitleaks.json`). They were re-run after this RESULT's last edit.
- **No secret is in any of these files.** The cold-storage secrets are not part of this work.

**Separate, not fixed:** the predictor rule-pin tests fail identically on the installed sources (§6). No pin was edited to
make them pass.

These files are frozen after this report.
