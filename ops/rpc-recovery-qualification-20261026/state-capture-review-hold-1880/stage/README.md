# state-fixture-capture-stage/r1: capture-authenticated receipts for the frozen r11 compiled fixtures (PREPARED by Claude 1877; NOT run; NOT PASS)
Report: ../../logs/claude-state-fixture-capture-1877.md. Root 1872 applies. **Nothing runs automatically. No receipt exists yet.**

## What it does
`capture.py run positive|fixtures BUILD_OUT_DIR` runs ONE frozen r11 script (`jobs/positive.sh`, 26 runs, or `jobs/fixtures.sh`, 6 cases)
as its OWN child, captures that child's combined output itself, and validates the output. It writes
`BUILD_OUT_DIR/fixture-captures/<kind>-<UTC>-<pid>/{capture.txt, receipt.json}` on **/vm**, not root or USB.

**Receipts:** a receipt is `synthetic: false, authenticatedBy: "capture"` **only** because this process spawned and captured the run.
**A consumer must re-verify it:** `receipt_errors` + re-running acceptance `check_fixture_capture` on the sha-bound `capture.txt`.

## Reused, NOT reimplemented: pinned frozen code loaded from its hashed bytes
**From r11 `jobs/bsro_gate.py` (`42cf6b47…`, r11 SUMS `246ff06b…`):**
- `run_capture`: owned new session/group, 1 MiB-kept bounded NEW capture file, signal forwarding, deadlines, owned-group cleanup, single reap;
- `verify_binaries` before and after the run;
- `qualified`: r11 guard + ns PASS;
- `live_completion`: all 265;
- `no_live_sessions`;
- `root_floor_ok`: plus 128 MiB for the scripts' own `r11/runs` files;
- `maps_inside` / `propagation_private`;
- `group_alive`, `file_sha`, `write_new`.

**From acceptance r1 (`81c3fd3c…`, SUMS `25ca8ece…`, its passing 38-test receipt `1f6ec605…` pinned):**
- `check_fixture_capture`: exact lines/labels/end markers, rc 0, no timeout or truncation, identities;
- the 1 MiB capture bound.

**Local only:**
- a 512 MiB lane check (r11 `own_lane` is hard-wired to the 4096 MiB build lane), with the same 16 GiB host floor + 256 MiB headroom;
- `timeout -s TERM -k 60` (positive 12600 s, fixtures 900 s) inside the owned group;
- leftover `/tmp/bsro-r11-{pos,fix}-*` dir/mount checks;
- the exactly-one verified build receipt lookup (`verify_binaries`' own rule);
- the receipt.

## Fails closed on
- **Pins and gates:** any pin or SUMS mismatch (wrapper, r11, acceptance; re-verified after the run); not exactly the `unshare -Urnm` maps / private propagation / no IPv4 route; r11 not qualified; not all 265 complete; a live session or stage mount; the lane / host / root / /vm floors.
- **Build output:** not a `/vm/…/run-<UTC>-<pid>/out` real path; not exactly one verified build receipt; binaries / script / SUMS / build receipt changed before vs after.
- **Leftovers:** before or after the run.
- **The run itself:** spawn errors, timeout (124/137), an abandoned or truncated capture, a sink error, a nonzero rc, an incorrect output, a live group, or a failed post-run `verify_binaries`.

**Exit codes:** 3 = refused, nothing ran; 4 = ran and failed (`pass:false` receipt when writable); 0 = pass.

## Commands (root, manual, only after: all 265 CONFIRMED, r11 guard + ns PASS, a verified r11 build receipt naming BUILD_OUT_DIR)
```
bash jobs/q-exit-status.sh sfc-r1-tests    256 unshare -Urn bash state-fixture-capture-stage/r1/jobs/tests.sh            # pure: Ran 12, OK
bash jobs/q-exit-status.sh sfc-r1-positive 512 bash state-fixture-capture-stage/r1/jobs/run.sh positive <BUILD_OUT_DIR>
bash jobs/q-exit-status.sh sfc-r1-fixtures 512 bash state-fixture-capture-stage/r1/jobs/run.sh fixtures <BUILD_OUT_DIR>
```

## Scope limits (see the report)
- **The namespace:** the frozen `positive.sh`/`fixtures.sh` need a WRITABLE `/tmp` and `r11/runs`. So they run in a private `unshare -Urnm` namespace, as their own headers document, **not** inside the RO-hardened build namespace (`ns_harden /home/steven /tmp`). Running them there needs a future r12 script with an explicit /vm work dir.
- **Where outputs land:** the scripts' own per-case evidence lands in `r11/runs/positive-*` on root, bounded ≤ 1 MiB each. Only this wrapper's capture and receipt are on /vm.
- **What a receipt shows:** it proves that this wrapper ran and captured the frozen script. It does not defend against a malicious same-user writer.
- **What a pass means:** a pass qualifies the compiled fixtures only. It is NOT a production state result, NOT canonical, and NOT recovery acceptance.
