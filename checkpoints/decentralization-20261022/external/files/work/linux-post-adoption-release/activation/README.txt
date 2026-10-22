POST-ADOPTION LINUX ACTIVATION (prepared by Claude 2026-10-21; ROOT REVIEWS AND EXECUTES; nothing here was run against
production). Run every script from /home/steven/Documents/Codex/2026-10-18/wo. The c083 and 51516b778 activation
directories (plans, admissions, private backups, results) are evidence: read only (public result/admission fields), never
written. guestd and its guests are never touched: only enclave-metal.service, config.json and its drop-in.

Release: work/linux-post-adoption-release/stage/metal-deabf8f90 (git archive of scratch commit deabf8f90, no node_modules)
Image:   work/linux-post-adoption-release/stage/dist-leasegas-deabf8f90, MEASUREMENT
         ed918e4b393699b3f6251853d2d34317869d7d9e3150b41ffa917df3d392012c682f376a799494d01e6a6dd5bedd2ac2
Exact hashes: ../ARTIFACT-INVENTORY.json and ../INVENTORY.sha256.

ORDER
0. Preconditions root checks: production attached at b8376e15 (the previous control), both apps healthy on it; the
   51516b778 result says rolled back; no 95-app-funded-leases.conf drop-in.
1. python3 work/linux-post-adoption-release/activation/stage.py
   copies release + image to /home/steven/enclave-prod/{metal,dist-leasegas}-deabf8f90 (inventory-compared; 51516b778's
   and c083's stay), checks the lease-gas record, writes plan.json. No config/service change.
2. python3 work/linux-post-adoption-release/activation/prepare-admission.py
   public allowlist + this measurement (additive: 9fcbd925 and c083 stay listed; removing them is root's separate call).
3. python3 work/linux-post-adoption-release/activation/admit.py   (REMOTE API relay, ssh as before)
   CAS on /etc/nan-relay/linux-leasegas-measurements.env against the 51516b778 install (810760c0...), FRESH remote
   backup <env>.before-deabf8f90, drop-in must be 21fadc72...; then recheck the public allowlist lists ed918e4b... and
   set admission.json stage 'verified active; old control still connected'. Undo: unadmit.py (CAS on both versions).
4. Fresh funding/lease preflight (outputs/decentralization-audit/linux-conduit-funding-preflight.json, < 6 min old,
   both apps covered, > 13 min lease left each).
5. python3 work/linux-post-adoption-release/activation/activate.py --availability <metal0's public /availability URL>
   MANDATORY pre-cutover baseline (refuses before any change otherwise): both apps ACTUALLY healthy by apphealth.py -
   EyesOff /ping JSON ok+pong true, image-generator / HTTP 200 text/html >= 1 KiB, its <title> recorded as its identity
   (apps-health.json) - and /availability naming exactly ONE running owned guest per app (guestrows.py: guestd's retained
   "failed" guests are recorded as history and handed to the gate as --known-failed; 2 nonterminal, missing, not owned
   or unknown-status rows refuse) -> fresh private-backup/ here, config dist +
   leaseGas, drop-in WorkingDirectory, restart -> attach (120 s) -> adoption of BOTH apps with exactly those guests
   (300 s) -> operational gate v3 (verify-operational.py: <= 300 s warm-up for the first admit/first reconcile pass,
   then 420 s continuous [gate v4]: the same actual app health, per app exactly one nonterminal guest = the baseline id,
   running+owned, no failed row beyond the baseline history, >= 2 completed vouch
   cycles, vouch never stale > 180 s, journal readable and anchored by both adoption lines (fails closed), no
   death/reap/release/respawn/relaunch; hard overall deadline warmup+window+4 polls+120 s) -> both apps' app-paid
   renewals ("[lease-gas] renew <id> landed in <tx>", <= 3600 s, every poll actually healthy). It ends PROVISIONAL.
   ANY failure: safe rollback - stop the new control first, wait until two public RPCs agree on a block past every
   sponsored deadline it logged (journal unreadable: past stop time + 300 s ttl + 60 s, the bound for anything it could
   have signed), restore config + drop-in by CAS, start the previous control; journals untouched.
6. ROOT VERIFIES before keeping: audit both recorded renewal transactions on chain (paid by each app's reserve, never
   this host's key: work/lease-relay-activation/audit-paid-leases.mjs or root's current audit), then
   python3 .../keep.py --audit <audit output> --verified <id>=<tx> --verified <id>=<tx>
   Otherwise python3 .../rollback.py (same safe rollback).
Gate self-tests: test-gate-v4.py + test-gate-v3.py via run-gate-v4.sh (logs/gate-v4-r2.log; r1 logs/gate-v4.log failed only
because the preserved prior-gate3/ copy lacked its apphealth.py import - fixed by a byte copy, no test change).
Earlier: test-gate-v3.py (logs/test-gate-v3.log): root's three holes reproduced on the preserved v2 gate
(prior-gate2/, its own proof logs/test-gate-v1.log) and failed by v3, v3's strictness cases, the earlier 9 cases on v3.
Root staging (07:50Z, root's files, preserved untouched): plan.json (relays: EU only, temporary - ROOT-STAGING-STATE.txt),
plan.before-relay-retirement.json, admission.json + measurement.env ('prepared only'), check-staged-plan.mjs,
public-baseline.py. stage.py is not re-run; activate.py reads plan.json as root left it.
