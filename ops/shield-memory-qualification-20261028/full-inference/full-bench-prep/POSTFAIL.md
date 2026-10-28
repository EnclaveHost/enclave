# Post-failure `/ping` diagnostic (next canary only)

**Status: source only.** Nothing was run, built, booted or tested. **The tests have not been run.** No guest image,
firmware, client, probe, production unit, ring, worker or wallet was touched. Production Qwen holds the RAM/GPU and the
test window is not approved; this prepares the next canary only.

## Why

Root reviewed BASELINE-502: inconclusive (the read test was scratch, not installed, so it is **not authoritative**).

- r4: a fresh attested HTTP 502 after 113.5 s; no DOM error on the serial.
- r3: the "GET unreachable" was the client's own 60 s abort (CLIENT-TIMEOUT.md). It is **not** evidence of the same
  cause as r4's real 502.

One narrow question, with no new guest image: right after the first application failure, does the same guest still
attest and does the app still answer?

## What changes (`fullbench.py`)

**Opt-in at plan time.** `plan --post-failure-diagnostic` writes `p["post_failure_diagnostic"]`:

- `client` / `client_sha256`: the plan's own pinned client and pin, named explicitly;
- `path`: `/ping` (probe-bench `lib.rs:205`, liveness only, touches no model);
- `hold_sec` 15, `request_sec` 10.

Without the flag the plan holds `null` and behaviour is exactly as before. Plans made before this change have no key and
run no diagnostic. Preflight refuses a record that is not the pinned client, not `/ping`, or has a window above 10 s / 15 s.

**When it runs.** `post_failure_diagnostic()` is called in exactly one place, in `run_arm`. That is after `classify_failure` has set
the primary outcome, on the arm's **first** application failure. It runs at most once: a second call is a no-op.

It does **not** run on:

- success;
- preflight refusal;
- startup-readiness timeout or a DOM error;
- any watchdog or harness stop, including the primary's `request_timeout`;
- a primary that never got `VERDICT attested`. A startup quote rejection is not followed by a second attestation.

`model_declined` and `graph_not_found` still run it, and stay failures.

**Gates before the child starts.** Each failing gate records a `skipped` reason and starts no child:

1. The config is valid, and the client file **re-hashes now** to `client_sha256`.
2. Some primary result was attested.
3. The forwarder is still alive.
4. One full `guard()` tick passes. That tick covers:
   - the wall deadline;
   - production qemu inventory;
   - every owned unit's InvocationID and active state (a dead or replaced guest/worker is refused);
   - the guestd probe;
   - GPUs;
   - MemAvailable.

**The request.** The argv comes from `diag_argv()`. It is built separately, not through `client_argv`, but it is
token-for-token what `client_argv(..., "/ping")` would give. It uses the same node, the pinned client, `--measurement`,
`--app-sha`, `--runtime`, `--vcek`, `--min-tcb`, `--no-kds`, `--answer-within 600000` and `--amd-chain`. No
measurement, app hash, min-TCB, seccomp, W^X, pinned-key or replay check changes: they all live in the client and are
untouched.

- stdout goes to `diag-<seq>.out` and stderr to `diag-<seq>.out.err`, both new 0600 files.
- The window is `min(10 s, 15 s hold, arm wall deadline)`.
- `guard()` runs every second. On any stop reason, or at the window, the client is killed and reaped. The child is also in `procs`, so cleanup reaps it again.
- The hold is a cap, not a wait: the arm returns as soon as the client is reaped.

**What is recorded.** Only `h["post_failure_diagnostic"]` is written, under a label that says it is not a bench result:

- `ran`, `skipped`, `stop`, `held_s`, `samples` (its own list), `error`.
- `result`: `verdict`, `status`, `pinned`, `app_requests_sent`, `status_trusted`, `exit`, `killed_by_harness`,
  `output_oversize`, and bounded printable `stderr`. **No body.**
- If the verdict is not `attested`, `status` and `pinned` are cleared. Any status line is kept only as
  `untrusted_status_ignored`.
- `before` / `after` snapshots contain:
  - public serial `DOM `/`MODEL ` lines (last 32, 200 chars each, printable) and the serial byte count;
  - for owned units only: `ActiveState`/`SubState`/`Result`/`ExecMain*`, same InvocationID, same MainPID start, and
    the cgroup's `memory.events` `oom`/`oom_kill`/`max`.
- `conclusion` has only two values:
  - **OK:** attested, pinned, status 200, exit 0, not killed, not oversize. The text reads "current runtime covered by a
    fresh attestation and the app answers /ping now; cannot rule out an earlier OOM, restart or native-child death
    behind the primary failure".
  - **Inconclusive:** anything else. Nothing more is inferred.

**What it never changes.** `h["outcome"]`, `h["requests"]`, `failure_evidence`, `h["samples"]`,
`host_peak_last_sample`, `host_current_max`, `summarize()`, `arm_ok()` and `receipt["ok"]`. A failed primary stays failed.
There is no retry and no branch that turns it into a success. A diagnostic exception is caught into `error`, and cleanup
runs exactly as before.

**Not collected.** The worker journal and app stderr are not collected. Matching user-unit journal entries by
InvocationID (`_SYSTEMD_INVOCATION_ID` vs `USER_INVOCATION_ID` for `systemd --user` transient units) was not verified
from source here, so they are left out rather than risk an empty or wrongly scoped read. `memory.events` of the owned
cgroups is the host-side OOM signal instead.

## Limitations

- **10 s may not cover a full attestation.** The derived client's attestation GETs keep a 60 s idle timeout. A slow
  quote is killed at 10 s and recorded as `diagnostic_timeout`, inconclusive.
- **A `/ping` 502 is not seen as a 502.** client.mjs retries a 502 for up to 60 s, so the harness kills it at 10 s. That
  is inconclusive too, and stderr may show the retry.
- **Host-side OOM counters only.** The `memory.events` counters belong to the host qemu/worker cgroups. An OOM inside
  the guest is not visible there. The serial is untrusted guest output.
- **The OK conclusion is narrow.** It speaks only for the moment of the ping. It cannot rule out an earlier OOM, an app
  restart, or a native child dying and coming back.

## Tests (written, **not run**)

`cd full-bench-prep && python3 -m unittest -v test_fullbench`

New class `PostFailureDiagnostic`. FakeHost gained `sha256`/`shas` and a `/ping` branch in `popen` (`diag_out`,
`diag_err`, `diag_exits`). Existing tests do not use these.

| test | checks |
|---|---|
| `test_ping_ok_keeps_primary_outcome_and_metrics` | Compared with a no-diagnostic baseline, `outcome`, `requests`, `failure_evidence`, `samples` and peaks are identical. The primary 502 stands. The scoped OK conclusion is given. No body is recorded. The summary has no diagnostic. |
| `test_explicit_argv_same_pinned_client_and_trust` | The argv equals `client_argv(..., "/ping")`. The `diag-0.out`/`.err` files are siblings. |
| `test_config_or_identity_mismatch_skips` | The diagnostic is skipped, with no child, for each of: another client, another path, hold 20, request 11, or the client re-hash differs. |
| `test_attestation_rejection_trusts_no_status` | A reject followed by forged status/pin lines gives status `None`, the status kept only as untrusted, `app_requests_sent=0`, and inconclusive. |
| `test_timeout_bounded_and_killed` | The client is killed at no more than 10 s. Its stderr is kept. The result is inconclusive and cleanup is clean. |
| `test_wall_deadline_clips_window` | The arm wall deadline clips the window to about 3 s. |
| `test_resource_stop_during_diagnostic_yields` | MemAvailable drops at +3 s. The stop is `low_host_memory`, the client is killed, the primary outcome is unchanged, and rings and bank are removed. |
| `test_unsafe_or_dead_or_changed_identity_skips` | No child starts for each of: production guest appears, low memory, guest unit died, InvocationID replaced. In the replaced case cleanup refuses to touch the unit, and `workload_outcome` is still `request_failed`. |
| `test_not_run_outside_first_attested_app_failure` | No diagnostic on success, quote rejection (one client only), readiness timeout, primary harness timeout, or preflight refusal. |
| `test_declined_and_graph_not_found_stay_failures` | The outcome is unchanged, and `arm_ok` is false. |
| `test_exactly_once` | A second call starts nothing and changes nothing. |
| `test_diagnostic_error_recorded_cleanup_runs` | An unreadable output gives `error`, no conclusion, and clean cleanup. |

The existing 75 fixture tests and the 13 derivation tests (`client-timeout/test_derive_client.py`, not touched) should
still pass unchanged. This was not verified.

## Root commands (not run)

```
cd full-bench-prep && python3 -m unittest -v test_fullbench
cd full-bench-prep/client-timeout && python3 -m unittest -v test_derive_client
python3 full-bench-prep/client-timeout/derive_client.py verify --manifest <dir>/derivation-manifest.json
python3 full-bench-prep/fullbench.py plan ... --client <dir>/client-bench-timeout.mjs --post-failure-diagnostic
python3 full-bench-prep/fullbench.py execute --plan <plan.json> --approve-plan-sha256 <sha>          # dry run
# --execute --coordinated-slot ... only in an approved test window, after production yields RAM/GPU
```
