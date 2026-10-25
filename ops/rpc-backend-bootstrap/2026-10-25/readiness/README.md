# Read-only RPC production readiness sampler (staging)

Source and offline tests only. It has not been run against the live VM (the clients are not synced). Nothing here activates anything, sets `coverageVerified` or reads keys or configs.

For the full report, test evidence and limitations, see [`RESULT.md`](RESULT.md), which is `/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/claude-readiness-result.md`. The older pre-review report at `wo/logs/claude-readiness-result.md` is superseded.

## Files

- `readiness_sampler.py`: the Python stdlib CLI.
- `test_readiness_sampler.py`: 74 behaviour tests against synthetic loopback servers.
- `jobs/test.sh`: the queue job, run in `unshare -rn`.
- `jobs/root-probe.sh`: re-runs root's unchanged `../readiness-root-probe.py`.
- `logs/`:
  - `test1.*` keeps the first run (1 fixture failure).
  - `test2.*` is the original 59/59 run (superseded); `reviewfix-*` are the post-review runs.

## Run (inside the RPC guest, as an unprivileged user; rollup port 19545 is not forwarded to the host)

```sh
python3 readiness_sampler.py --out /run/readiness/sample-$(date -u +%Y%m%dT%H%M%SZ).json
# defaults: 8 samples, 120 s apart, advancement window >= 600 s, 5 s/request, 4 MiB/response,
#           <= 360 requests, <= 1050 s total. Exit 0 READY, 3 FAIL, 4 INCOMPLETE, 2 usage/bounds.
```

Until root attaches a reviewed coverage receipt, the best possible result is `INCOMPLETE`, with `historical-coverage: coverage-receipt-absent`. Add the receipt with:

```sh
  --coverage-receipt receipt.json --coverage-verdict verdict.json --coverage-origin origin.json \
  --expect-snapshot-manifest-sha256 <root pin> --expect-chain-config-sha256 <root pin>
```

## Publication review

The sampler bytes are unchanged from the 74-test passing run. Only test/job relative paths were adapted from the staging coverage-stage directory to the published sibling coverage directory; the decoder parity test was checked in the published layout. The independent contradictory-tag probe now returns FAIL (rc 3). The original false-positive sampler must not be installed. This is a read-only diagnostic, not authorization to activate. Runtime configuration and binary provenance require separate operator review; reviewer names in the coverage receipt are unsigned declarations. A live negative probe is diagnostic only.
