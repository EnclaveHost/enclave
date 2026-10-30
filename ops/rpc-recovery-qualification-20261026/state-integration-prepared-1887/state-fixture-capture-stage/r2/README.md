# state-fixture-capture-stage/r2: confined capture of the frozen r12 compiled fixtures (PREPARED by Claude 1879; NOT run; NOT PASS; PARSER BINDING PENDING)
Report: ../../logs/claude-state-capture-confinement-1879.md. r1 (`178f4c3a…`) is HOLD (root) and preserved.

**Status:** **every `precheck`/`run` currently REFUSES first (rc 3, nothing created).** `ACCEPTANCE = None`: the only output parser (acceptance r1) is pinned to the r11 scripts and r11 end markers and can never accept r12 output. It is not re-implemented here. Follow-up (report §5): pin an acceptance revision that binds r12. Nothing runs automatically, and no receipt exists.

## Layout (root review 1879)
**Only `/vm` is writable,** inside the reviewed build namespace:
- `jobs/run.sh` → `capture.py precheck` (OUTSIDE, before any mount clone);
- then `unshare -Urnm bash jobs/inner.sh`: the pinned r12 `jobs/ns.sh` (byte-checked) → `ns_harden /home/steven /tmp`;
- then `capture.py run`, which re-checks every gate and VERIFIES the namespace with the pinned r12 `bsro_gate`: `maps_inside`, `ns_checks` = private propagation + `read_only([/home/steven, /tmp, r12, this stage], rw=[BUILD_OUT_DIR])` + `ro_tree_ok`.

**Writes:** everything goes under the NEW run dir `BUILD_OUT_DIR/fixture-captures/<kind>-<UTC>-<pid>/`:
- `capture.txt` and `receipt.json`;
- `work/`, created by the frozen r12 script itself: `work/trees` (removed by the script) and `work/out` (evidence, kept).

There is no `/tmp`, no stage `runs/` and no root path. The scripts have no defaults (proved by tests 11 and 13).

## Reused, not reimplemented
- **The process lifecycle:** r12 `bsro_gate.run_capture` (= r11's: owned group, bounded capture, forwarding, deadlines, cleanup, single reap).
- **The gates:** `verify_binaries` (before and after), `qualified`, `live_completion` (all 265), `no_live_sessions`, `root_floor_ok`, the /vm floor + 256 MiB, and the 512 MiB lane + 16 GiB host floor (local; r12 `own_lane` is 4096-only).

## Fails closed on
- pins/SUMS (re-verified after the run);
- the pending parser;
- namespace/RO checks;
- any gate;
- not exactly one verified build receipt;
- an identity change;
- timeout (124/137), truncation, abandonment, a sink error, a nonzero rc;
- incorrect output;
- **cleanup/confinement:** a mount left under the run dir, `work/trees` left, `work/out` missing, a live group, the RO check failing after the run, r12 `runs/` changed;
- a failed `verify_binaries` afterwards.

## Commands (root; only after the follow-up pin AND: all 265 CONFIRMED, r12 guard + ns PASS, a verified r12 build receipt)
```
bash jobs/q-exit-status.sh sfc-r2-tests    256 unshare -Urn bash state-fixture-capture-stage/r2/jobs/tests.sh          # Ran 14, OK
bash jobs/q-exit-status.sh sfc-r2-positive 512 bash state-fixture-capture-stage/r2/jobs/run.sh positive <BUILD_OUT_DIR>   # refuses while pending
bash jobs/q-exit-status.sh sfc-r2-fixtures 512 bash state-fixture-capture-stage/r2/jobs/run.sh fixtures <BUILD_OUT_DIR>   # refuses while pending
```
