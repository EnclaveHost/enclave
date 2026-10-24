# Gate v5 proposal: bounded reset on ONE transient app transport error (root review first; nothing is deployed)

## The 23:43:16Z failure

The fee build's cutover succeeded: the normal setProofKey landed and both original VMs were adopted. Then gate v4 FAILED on a
single EyesOff poll with `HTTP None URLError`, which is no HTTP response at all.

v4 treats ANY problem after its 420 s window has started as a FAIL, so one dropped connection rolled the control back. That
spent the setProofKey and left the operator at 145368427115 wei (ROOT-RECOVERY-OBSERVED.txt).

## The change (v5 = v4 + one rule; everything else is byte-for-byte v4)

**The rule:** after the window has started, ONE poll whose ONLY problem is a transient app transport error (no HTTP response)
resets the window, instead of failing.
- **What counts as transient:** a timeout, connection refused/reset/aborted, a remote disconnect, or a DNS failure.
- **What a reset does:**
  - `good_since` and the vouch cycles are cleared;
  - the next fully clean poll starts a NEW full 420 s window that again needs 3 vouch cycles;
  - elapsed healthy time and old vouch cycles are never counted.
- **How often:** at most `MAX_RESETS = 1`. A second transient after the window started, or any problem before the restarted
  window (past warm-up), FAILs.

**Unchanged:**
- **Deadline:** the absolute deadline (`warmup + window + 4 × poll + 120` = 900 s by default) is never extended. A reset late
  in the gate therefore ends in a deadline FAIL.
- **Still FAIL, as in v4:**
  - any HTTP status other than 200 (incl. 4xx/5xx);
  - a bad payload (not ok/pong, wrong title, size, type);
  - any TLS / certificate error (`ssl.SSLError`, even wrapped in `URLError`);
  - an `/availability` problem;
  - a stale or unvouched vouch;
  - guest id/status/ownership/history faults;
  - journal death/reap/release/respawn lines;
  - an unreadable journal;
  - a transient that coincides with any other problem.
- **App health definition:** the definition stays `apphealth.check`, unchanged. v5 only records the exception that
  `apphealth.fetch` would have swallowed, through a byte-for-byte equivalent fetch, so the problem can be classified.
- **Parent watchdog:** the lease watchdog in the activation kit (600 s floor, 105 s block freshness) still wraps the gate
  unchanged.

## Is it adequate? (honest limits)

- **It fixes exactly the 23:43 case.** The gate started about 23:40 and the transient came about 3 min in. A reset then needs
  ≤ 420 s more, well inside the 900 s deadline.
- **A late transient still fails.** A reset only helps if `reset time + 420 s + one poll ≤ deadline`, i.e. about the first
  ~465 s of the gate. Later, the deadline FAILs (by design, never extended).
- **Lease budget.** With a reset the gate may run up to its deadline. The 1440 s cutover bound
  (600 + 420 + 120 + 300) pre-pays ONE window, so the parent watchdog may stop a reset gate at the 600 s floor (fail closed).
  Covering a reset needs about 600 + 900 + 120 + 300 = **1920 s** at the cutover. Staggered 30-min leases cannot give both apps
  that, so a reset may still end in a watchdog stop. That is safe but costly; root decides.
- **Rollback cost is not addressed here.** A rollback ALSO spends a proof-key registration: the old control must re-register,
  and today it stays unregistered. A future funding gate must require the balance to afford a fresh setProofKey on BOTH the
  candidate and the rollback image. This is not implemented (root: no funding-gate change yet).
- **Ambiguous signal.** A real route withdrawal can also look like "no HTTP response" (a public EOF on a lapse). v5 tolerates
  it at most once, and it then needs a full new clean window. A persisting lapse therefore still FAILs.

## Files and tests (recorded 2026-10-24T00:05:16Z; source only, nothing deployed)

**Files:**
- `verify-operational-v4.py`, `apphealth.py` and `guestrows.py` are BYTE copies of the activation kit's
  (5ef6fa9d…, 3babd979…, 29b7c9da…).
- `verify-operational-v5.py` is v4 plus the rule. `V4-TO-V5.diff` is the complete change.

**Tests:** `tests/test_gate_v5.py` runs the REAL v5 script as a subprocess against in-process 127.0.0.1 fixtures. The clock is
real but scaled: window 4 s, poll 1 s, warm-up 3 s. Result: **11/11** (`logs/t5.out`, queue 512). The cases:
- the happy path;
- one dropped connection resets and needs a full NEW window, after the reset poll;
- old vouch cycles never count, with a vouch advancing every 4 polls and 3 cycles required;
- a second transient FAILs;
- HTTP 500 and a bad payload FAIL at once;
- a transient together with an `/availability` 503 FAILs;
- the deadline never extends;
- an unvouched app or a frozen vouch after a reset FAILs;
- a transient in warm-up is v4's warm-up;
- the classification: timeout / refused / reset / remote-disconnect / DNS are transient; TLS (even a TLS error that is
  also a reset), HTTPError, IncompleteRead and others are not;
- the recording fetch returns exactly what `apphealth.fetch` does (200 / 500 / drop / bad payload / refused).

**Focused mutants:** `mutants-v5.py` covers the v5 rule only, with copies beside the folder and a control that must pass.
Result: **7/7 killed**: two resets allowed, the window kept on a reset, a transient with another problem, TLS counted transient,
any error counted transient, the deadline extended on a reset, the reset not recorded.
- **Equivalent, not run:** dropping v5's `vouch_ats = set()`, because v4's window start already resets the vouch cycles. The
  property is proven end to end instead.

**Not done:**
- No rerun of the old kit's 89 mutants (its helpers are unchanged).
- No change to the activation kit or any deployment.
- No funding-gate change (see "Rollback cost" above).
