# Cold-scan handoff v3 (1615): fixture-only repair of root's failed v2 supervisor tests. Prepared 2026-10-26 20:00–20:06Z; NOT run

## Root's v2 result
`logs/root-cold-scan-v2-tests.out` / `.rc` = 1: `Ran 8 tests`, `FAILED (errors=1)`, 7 ok.
- **The error:** `test_normal_exit…` → `assert_group_gone` → `gone()` (`test_root_scan_supervisor.py:21`). `f.read()` on an already-open `/proc/<pid>/stat` raised `ProcessLookupError` (ESRCH) because the grandchild vanished between `open` and `read`. The fixture caught only `FileNotFoundError`.
- **What it means:** this is the "process is gone" case. It supports the supervisor's group kill rather than contradicting it, but it fails the test.
- **ResourceWarnings:** from `read_pid()` (`:33`) and the `out` read (`:79`), which opened files without closing them.

## The fix (test fixture only; supervisor byte-identical)
- `gone()`: `except (FileNotFoundError, ProcessLookupError)` (ENOENT at open, ESRCH while open), exactly those two and not all `OSError`. The `Z` (zombie) check is moved outside the `try`.
- `read_pid()` and the `out` read use `with open(...)`. The heartbeat creation `open(self.hb, "w").close()` already closed at once.
- **No other test change:** the same 8 tests and assertions.

## Pins
| file | sha256 |
|---|---|
| `outputs/…/cold-scan-v3/SHA256SUMS` | **`6a4fda7edab4be6c52c2177a6ef1852ce65ebbceea689c3c43efcb6fe42e8aac`** |
| `cold-scan-v3/root_scan_supervisor.py` | `d57de0b0c6098342c0ff4fbbc5de4b81fd342c1110a10a740186df04825c7774` (**= v2**, `cmp` identical) |
| `cold-scan-v3/test_root_scan_supervisor.py` | `a00dc794d235e210bb9615fb92fe64bb80c353c758124c64272efbf4189c2cc4` |
| `cold-scan-v3/run-supervisor-tests.sh` | `72c3912d362c7460c81cb2926fca69ec4f730aa2f710c155a672d0e75bec8706` (v2's job; only the paths and the `cold-scan-v3-tests` names) |
| `outputs/…/run-read-only-cold-scan-v3.sh` | **`174e0081c6d89b236269cf775365363a526ebbb1fe100b8901f0ed74bf4de530`** |

**`run-read-only-cold-scan-v3.sh` = v2 with only these differences:**
- `V` → `cold-scan-v3`, `V_SUMS` → `6a4fda7e…`;
- `TT` → `logs/root-cold-scan-v3-tests`, and the required test line `## cold-scan-v3-tests rc=0`;
- the root body's `V` path → `cold-scan-v3`;
- run dirs `run-v3-*`;
- comments.

The root body, supervisor pin, r10 pins, sudo flow, gate and validator are unchanged.

**Preserved:**
- `cold-scan-v2/` (SUMS `3bcae555…`, re-verified);
- `run-read-only-cold-scan-v2.sh` `1dcb57ae…`;
- v1 `41825996…`.

**What I did not do:** no tests, builds, sudo, live actions, network or USB.

## Root
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh root-cold-scan-v3-tests 512 unshare -Urn bash /home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/cold-scan-v3/run-supervisor-tests.sh
```
**PASS** = `## verified SHA256SUMS 6a4fda7e…`, `Ran 8 tests`, `OK`, no skips, `## cold-scan-v3-tests rc=0`. v3 refuses to run unless that log's last queue attempt shows exactly this.

**Not claimed:** that the 8 tests pass. They have not run in this form.
