# TEST2-MINI: the delegation ADD and REMOVE on node f1461271

Written by enclave-5d for enclave-87, with enclave-d1's feasibility check. enclave-d1 executes it; enclave-bf reviews it.
It runs AFTER the v42 reboot acceptance (REBOOT-GO-v42.md, step 12 done) and BEFORE the v43 manager-path canary. It
takes about 30 minutes.

## Why

TEST2 (E15-E19) proved the delegation path on nodes `07fc4f55` and `317b3152`. Node `f1461271` (main, `682dc63d` +
`8d036dff`) changed exactly that path:
- an owners change now re-attaches **make-before-break when the served set GROWS**: a standby tunnel, and the relay swaps it
  in with no gap (agent.mjs:825, relay/tunnel.js `bind` "newest wins");
- it re-attaches **break-before-make when an owner is REMOVED**: every tunnel ends at once, then it attaches again
  (agent.mjs:828);
- the app zone refuses an unserved owner's deployment (Host.appZoneTarget).

Until now these were tested only against the relay's code in tests (enclave-5d's DONE audit). This test runs them live,
once, on the production node.

## What it proves (each a PASS line below)

- **A1:** adding a delegation re-attaches with NO gap. No relay-row sample is absent, and every test-1 request started
  through the ADD reaches a tunnel and gets 200 on test 1's key.
- **A2:** after the ADD, the row serves exactly {the operator, the delegated owner}, and nobody else. The zero id is
  refused, 503.
- **A3:** the delegated owner's partition app (ID2) is claimed and served on its OWN key. This is the path Steven's apps
  will take, including f1461271's new app-zone gate for a delegated owner. **C1**, its publicly trusted certificate, is
  INFO.
- **A4:** removing the delegation ends the tunnel first. From the break on, the relay never again lists the owner or ID2,
  and the row is back with [the operator] within 60 s.
- **A5:** test 1 across the REMOVE has ONE bounded gap, which is expected, since break-before-make ends every tunnel. The
  gap is ≤ 60 s, and every request after it gets 200 on test 1's key. Test 1's instance and key never change.

**So "test 1 served throughout" holds for the ADD only.** On the REMOVE, a gap of about 10 s is the designed behaviour
(E18 measured 05:06:49 → 05:06:58 on 317b3152), and A5 bounds it.

## The hard rule (enclave-87): no negative probe aimed at a live id

- **The only negative probe is `mini-watch.mjs zero`.** Its id is hard-wired to the ZERO id, which names no deployment.
  With the row attached, the relay's `ownerOnlySplice` refuses it: 503. A 404 means the row is absent.
- **ID2 is probed ONLY while the relay's row lists it** in `servesDeployments`, read at most 3 s earlier. After the REMOVE
  nothing probes ID2. Its refusal is read from the row instead: `/enclaves`' `servesDeployments` is computed by
  `servesDeploymentUntil`, the same predicate nan's `/x` gate applies (relay/api-relay.js `ownerServedDeployments` and
  `ownerOnlySplice`).
- **Test 1 is probed positively only.** It is expected to be served, and the REMOVE's gap is measured, not relied on.
- **Box-side negative probes (A9) are not part of this test.**
- The tool's own test (`test/test2-mini-watch.test.mjs`, 14 cases, fakes only) proves:
  - `zero` opens only the zero id's splice, whatever arguments it gets, and exits 1 if that is ever served;
  - ID2 is opened only while a fresh row lists it, and never on a stale one;
  - the only HTTP call is a GET of `/enclaves`.
  19 mutants of the tool are killed. The suite passes in a network namespace with no route (control: a public fetch
  fails EAI_AGAIN).

## What it does NOT prove

- **The public hostname path.** us-west step 1b is HELD, so every probe goes through nan's `/t/nucbox-k11/x` splice.
- **A single-cause stranger refusal on the data plane.** The box never claims a stranger's deployment, so no stranger
  can hold a live lease on this row. The zero id's refusal has several causes (no owner, no lease). The single-cause
  case, an owner with a live lease who is not served, is A4. It is read from the relay's own predicate, not probed.
- **The app zone's refusal on its own.** The relay refuses first, so nothing reaches the node's gate from outside.

## Names

| Name | Value |
|---|---|
| test 1 | `0x31136008aa0cf1d826d223777bed396efdf73e89ee5c82a5aabce2ca1aeeeee3` (operator-owned, hello-world 1.0.4) |
| K1 | test 1's transport key AFTER the reboot: the full sha256, read in step 0 |
| ID2 | `0x958ae6e9d6cb638901d97d2f29d9775d8143b14fa46f6c37aaa4e3f2c78cdd42` (TEST2's, hello-world 1.0.4, `isolation.require` = `hyperv-partition-per-app`, owner = the agent wallet `0x29479bf0…647c`, cancelled and refunded at 06:03:58Z) |
| K2 | ID2's transport key in its new partition: the full sha256, read in step 3 |
| the file | `agent-2947-mini60.json`: a NEW 60-minute delegation. TEST2's `agent-2947.json` and `agent-2947-10m.json` stay untouched in `delegations\removed\` |
| E | the evidence dir: `~/enclave-bench/test2mini-<UTC stamp>/` on warden-host |
| MW | `cd ~/Projects/enclave && node <rollout worktree>/windows/node/ops/hv-node-rollout/test2/mini-watch.mjs` (`ws` resolves from the current directory) |
| CLI | exactly as TEST2.md defines it: `bash -ic '… HOME=<empty> … ENCLAVE_KEY="$ETH_AGENT_WALLET" node cli/enclave.mjs …'`, the agent key in that one process only, never printed |

**Every step records its time, READ from a clock:** `date -u +%FT%T.%3NZ` on warden-host, and
`(Get-Date).ToUniversalTime().ToString('o')` in the same ssh call for a box action. Times are never estimated.

## Preconditions (each a STOP if missing)

1. **The reboot acceptance is done, and 87 has said go.** REBOOT-GO-v42.md is done through step 12, and enclave-87's go
   for TEST2-mini is recorded with its time. The uefi-dev-boot freeze does not matter here: nothing here boots a
   dev-boot VM.
2. **f1461271 is running.**
   - node.log's last start ran from `hvnode\f1461271\windows\node`;
   - `run-node.cmd` sha256 is `5f1a79b4c192743360344c640291457249b25c51f6bdafde1e12d9c0888a4507`;
   - there has been one `attach ACCEPTED` since the boot, and no `REMOVED` line.
3. **K1 agrees three ways** (enclave-d1):
   - the manager's `GET /vms`: test 1's ONE record, `transportKeySha256`;
   - REBOOT-GO step 7's printed NEW key;
   - step 11's `after-once` `spkiSha256`.
   If they disagree, do not start.
4. **The soak has ended** (16:01Z), and no other prober or lab is running on the box.
5. **`delegations\` holds no `*.json`.** `removed\` holds TEST2's two files. `/availability` `owners` = [0x389c…].
6. **Balances, read:**
   - the agent wallet has ≥ 0.00005 ETH and ≥ 0.01 USDC;
   - the operator has ≥ 0.0005 ETH (R3).
7. **`CLI status 0x958ae6e9…`** reads `active=false`, balance 0. Save it as `$E/id2-status-before.txt`.

## 0. Baseline (about 2 minutes)

- Box, read and saved to E:
  - `GET 127.0.0.1:8091/vms` (`vms-before.json`);
  - `/availability` `owners` (`owners-0.txt`);
  - free memory;
  - node.log's line count N0 (the excerpt in step 6 starts there).
- Start ONE watcher for the whole test, and leave it running:
  ```
  MW watch --test1 <test 1> --key1 <K1> --id2 <ID2> --seconds 3600 --out $E/watch.jsonl
  ```
  It samples the row every 2 s and starts a test-1 request every 1 s. It probes ID2 every 2 s, only while the row lists
  it; otherwise it writes `skipped` lines, as it will until step 3. Ctrl-C ends it cleanly.
- Wait ≥ 60 s.
  - The last row samples must read `present:true`, owners [0x389c…], with test 1 in `deps`.
  - Every `t1` line must be `x:"open"`, `code:"200"`, `spki` = K1, `ca:true`.
  - If not, STOP: the baseline is not clean.

## 1. ADD (make-before-break)

```
bash -ic 'node <rollout>/windows/node/ops/hv-node-rollout/test2/delegation-sign.mjs \
  --operator 0x389C3f030a209D04D026228D2D053fEB75DbadcA --box nucbox-k11 --minutes 60 \
  --expect-owner 0x29479bf04ed889d46a7afb7f292b9bb26e12647c --out $E/agent-2947-mini60.json' | tee $E/sign.txt
cd $MAIN && node scripts/host-delegation.mjs verify $E/agent-2947-mini60.json \
  --operator 0x389C3f030a209D04D026228D2D053fEB75DbadcA --box nucbox-k11 | tee $E/verify.txt
```
- `verify` must say VALID, and the file must not be `.INVALID`. Record the expiry, which is the backstop (see
  Rollback), and the file's sha256.
- **Copy it** to a box scratch dir. Then, in ONE ssh call, `Move-Item` it into
  `C:\Users\claude\vbs-like\hvnode\state\delegations\` and print the box's UTC time. That time is **T_add**; also record
  warden-host's time when the call returns. Read the ACL back: SYSTEM + Administrators only (as step1-box-acl.txt).
- Expect in node.log, within about 60 s (the 30 s tick; the re-attach needs 2 min since the last one, which after the
  reboot has long passed):
  - `the owners this node serves grew since its attach: attaching again make-before-break, so the relay serves the new set with no gap`;
  - `dialing wss://… (standby: the live tunnel serves until the relay accepts this attach)`;
  - `sent windows-hv-node/v1 evidence …, attach signature v2, 1 delegation(s)`;
  - `attach ACCEPTED tier=hv-node …`;
  - `re-attach: the standby tunnel serves now; the replaced one is closed, with no gap on the relay`.
  - **None** of: `tunnel closed` (a LOST tunnel), `REMOVED`, `attach REJECTED`.
  - `/availability` `owners` = [0x389c…, 0x2947…] (`owners-1.txt`).
- **ABORT (R1)** if, between T_add and 2 minutes after the `standby tunnel serves now` line, the watcher shows any row
  sample `present:false`, or any `t1` line that is not `x:"open"` (a 404 is the row absent). Also abort if there is no
  `attach ACCEPTED` within 3 minutes.

## 2. Stranger still refused

About a minute after the handover:
```
MW zero | tee $E/zero.txt        # exit 0 = refused(503); exit 1 = anything else
```
- It must print `"x":"refused(503)"`. `refused(404)` means the row is absent: repeat once after 10 s. Anything that
  opens is a FAIL, and it goes to enclave-87 at once.
- The row's owners must be exactly {0x389c (op), 0x2947 (until the file's expiry)}. The summary checks every sample.

## 3. The delegated owner's app is served (the path Steven's apps take)

```
CLI status 0x958ae6e9…        | tee $E/id2-status-1.txt     # active=false, balance 0
CLI resume 0x958ae6e9… --yes  | tee $E/id2-resume.txt       # setActive(true); a claim hint
CLI fund 0x958ae6e9… --usdc 0.01 --yes | tee $E/id2-fund.txt
CLI status 0x958ae6e9…        | tee $E/id2-status-2.txt     # active=true, balance $0.01
```
- `fund` needs an ACTIVE record (EnclaveDeployments `_requireActive`): a fund before the resume reverts `inactive`. The
  refund message's "`enclave fund …` brings it back" is wrong; that is a separate CLI fix.
- The rate is 0 (the box's payout wallet is the owner), so the cent is fully refundable in step 5.
- Expect, with times:
  - node.log `ledger: considering 0x958ae6e9`, then `claimed 0x958ae6e9 (tx …)`;
  - `0x958ae6e9 isolation spawned: hv… status=running image=0891c740…`;
  - `GET /vms`: TWO records, test 1's unchanged (same id, K1) and ID2's. **K2** = ID2's `transportKeySha256`, the full
    hex; save the record as `vms-2.json`;
  - the watcher's `id2` lines stop reading `skipped` once the row lists ID2, and then read `open 200` with `spki` = K2.
  - C1 (INFO): node.log `0x958ae6e9 certificate: 958ae6e9.app.enclave.host installed …`, and `ca:true` on the `id2`
    lines. It took about 2 min on TEST2. Wait at most 10 minutes for it, and record it either way. ID2's name already has
    two certificates today; a third is within LE's limits, and the relay fails over to ZeroSSL.
- **ABORT (R2)** if there is no `claimed 0x958ae6e9` within 5 minutes of the fund, or its partition is not running within
  5 minutes of the claim.
- Let `id2` read 200 on K2 for at least 3 consecutive samples (6 s). Then wait until the handover is at least 2 minutes
  old: the node re-attaches at most every 2 minutes, so a REMOVE sooner would be delayed.

## 4. REMOVE (break-before-make)

- In ONE ssh call, `Move-Item` `delegations\agent-2947-mini60.json` into `delegations\removed\` and print the box's UTC
  time. That time is **T_rm**. Never delete the file: it is the signed consent, and evidence.
- Expect in node.log, within about 30 s:
  - `an owner this node served was REMOVED since its attach: ending the tunnel now so the relay stops serving it at once, then attaching again`;
  - `tunnel closed`;
  - about 5 s later, `dialing wss://… as nucbox-k11` (NOT a standby);
  - `sent … attach signature v2, 0 delegation(s)`;
  - `attach ACCEPTED`.
- Expect about ID2 on the node:
  - held: loopback `/v1/deployments` shows ID2 `held`, with the owner-not-served reason (save it);
  - no `renewed 0x958ae6e9` from T_rm on;
  - `/availability` `owners` = [0x389c…] (`owners-2.txt`).
- The watcher, with no action from you:
  - a short `present:false` run (the break), then the row back with owners [0x389c];
  - test 1's requests refused(404) for about 10 s, then 200 on K1 again;
  - `id2` lines `skipped` from the break on.
- Keep it running 3 minutes after the row is back.

## 5. Teardown

```
CLI refund 0x958ae6e9… --yes  | tee $E/id2-refund.txt       # returns the cent, cancels the record
CLI status 0x958ae6e9…        | tee $E/id2-status-after.txt # active=false, balance 0
```
- Expect, within about 30 s (the next tick):
  - node.log `stopped 0x958ae6e9: the deployment was stopped on the ledger`;
  - `GET /vms` holds test 1's ONE record, the same id and K1 (`vms-after.json`);
  - Hyper-V holds one VM.
- Check `delegations\` holds no `*.json`, and `removed\` holds three files. Read and save free memory and both balances.
- Then Ctrl-C the watcher.

## 6. The verdict

```
MW summary --in $E/watch.jsonl --key1 <K1> --id2 <ID2> --key2 <K2> --add-at <T_add> --rm-at <T_rm> | tee $E/summary.txt
```
It prints A1-A5, C1 and the gate (ID2 never probed after the break), and `TEST2-MINI … PASS` only if every line but C1
passes. It judges the relay's and warden-host's view. **The node.log lines above are checked by hand:**
- steps 1, 3, 4 and 5 each saw every expected line, and none of the forbidden ones;
- test 1 had no `isolation spawned`, `retired` or `respawn` line for `0x31136008` in the whole run;
- `vms-before`, `vms-2` and `vms-after` show the same test-1 instance and K1.
**TEST2-MINI PASSES only if the summary says PASS AND all of these hold.**

## Evidence (E), then a commit

- **Warden-host:**
  - `watch.jsonl`, `summary.txt`, `zero.txt`;
  - `sign.txt`, `verify.txt`, `agent-2947-mini60.json` (a signed consent, not a secret);
  - every `id2-*.txt`;
  - `owners-*.txt`, `vms-*.json`, the balances, and the times file (every T with its clock).
- **From the box:**
  - node.log from line N0 to the end (`node-log-excerpt.txt`);
  - manager.log over the same span;
  - the ID2 `held` record;
  - the ACL read.
- `SHA256SUMS` over all of it. Commit it to `evidence/nucbox-test2-mini` and send the sha to enclave-87 and to whoever
  maintains DEPLOYMENT.md.
- The agent key appears in NONE of it: grep for the ADDRESS only.

## Rollback and aborts

- **R1, the ADD misbehaves** (a gap, no `attach ACCEPTED` within 3 minutes, or `REMOVED` / `tunnel closed` / `attach
  REJECTED` after T_add):
  - move the file into `removed\` at once (step 4's move) and record the times;
  - if ID2 was already resumed or funded, refund it (step 5);
  - FAIL, and report to enclave-87.
  If the node does not attach again within 3 minutes of the move, the node rollback (`hvnode-install.ps1 -NodeOnly` back
  to `317b3152`, DEPLOYMENT.md §4) is enclave-87's decision, never taken on the executor's own.
- **R2, ID2 is not claimed or does not run:**
  - refund ID2 (step 5): cancelling stops anything the node started, at its next tick;
  - then REMOVE (step 4);
  - FAIL(A3).
- **R3, test 1's instance or key changes at ANY point:** STOP and report. This test caused nothing that should do that,
  and it rolls nothing back on test 1.
- **The backstop:** the delegation expires 60 minutes after signing. At that moment the relay stops serving 0x2947 at
  decision time, without an attach (E19), and the node ignores the file. So a missed REMOVE cannot leave the owner served
  past the hour.
- **Money:**
  - ID2's cent comes back at the refund (rate 0);
  - gas: the agent wallet sends 3 transactions (resume, fund, refund); the operator sends 1 claim and at most 1 renewal.
  All well under a cent.
