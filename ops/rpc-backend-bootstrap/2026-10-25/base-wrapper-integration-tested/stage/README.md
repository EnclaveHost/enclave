# Base wrapper integration (candidate; source-only; NOT run, NOT installed)

- **Base:** `source` `df15955ce`, `ops/rpc-backend-bootstrap/2026-10-25/chain_service.py`, sha256 `75c879ec…`. It is
  byte-identical to root's capture `outputs/rpc-production-final-20261025/m7-m10-release-completed-0055/current-chain_service.py`.
  `base/` holds that file and the unchanged `test_chain_service.py`.
- **Candidate:** `src/chain_service.py` plus the new `src/test_chain_service_release.py`.
- **Patch:** `chain-service-release.patch`.

## What changes (opt-in; without `manifest.json` `baseRelease` the wrapper behaves exactly as before)
**`base_release(MANIFEST)`:** `None` unless `baseRelease` is present. When it is, it must be exactly
`{path, sha256}`, and:
- `sha256` must be the source pin `BASE_RELEASE_SHA256 = 4a7c013a…` (the only tested release);
- `path` must be exactly `/opt/enclave-rpc/releases/base-m7m10-4a7c013a510f8816/base`;
- `binaries.base` must equal that hash, so the UNCHANGED `coverage_activation` requires a coverage receipt and origin
  requalified for this binary;
- every component from `/` to the file must be a non-symlink, owned by root (uid 0) and not group/other writable;
- the file's sha256 is re-checked.

The old `/opt/enclave-rpc/bin/base` is never removed. In release mode it is simply not executed.

**`bootstrap_anchor_args(CONFIG, sha)`** (release mode only) reads root-owned, pinned evidence in
`/etc/enclave-rpc/base-bootstrap/`, with the same `_evidence` rules as coverage and secure directories:
- **`launch.json`** (`enclave-base-bootstrap-launch/v1`): the anchor, `baseReleaseSha256`, and the hashes of the A2–A4
  outputs copied into `qualification/`: `m10-launch.json`, `a2-authenticated.json`, `a4-rebuilt.json`,
  `bytecodes-verified.json`. Each copy must hash as recorded, the `m10-launch` `bootstrapAnchor` must equal the anchor,
  and `bytecodes-verified.a4Sha256` must equal the A4 hash.
- **`lifecycle.json`** (`enclave-base-bootstrap-lifecycle/v1`): bound to `launch.json` by sha.
- **Both sha256 values are pinned** in `chain.json` `baseBootstrap.anchorLaunch {launchSha256, lifecycleSha256}`. The
  `baseBootstrap` section is excluded from the coverage `config_identity`.

**Lifecycle (root-written; the wrapper only reads it):**

| state | wrapper action |
|---|---|
| `anchor-pending` | append `--bootstrap.anchor N:0x…` (the one-time start; the client itself refuses unless its EL head is exactly N) |
| `bootstrapped` | no anchor; requires `finalizedPastAnchor {number > N, hash, recordedAt}` recorded by root |
| anything else | **refuse**. Root decides explicitly; the wrapper never replays after an advance and never skips on ambiguity |

- **Gate order:** every existing gate (mount, profile, history and state files, coverage, L1 readiness, canonical
  safe-origin, receipts, blobs) runs first and is unchanged. `BASE_NODE_L1_TRUST_RPC=false` stays explicit.
- **Argument passing:** the anchor is an argv element, not a shell or systemd string, so no escaping is involved.

## Unresolved guards (fail closed, by design)
- **`LAUNCH_PRODUCER_REVIEWED = False` (source constant).** No reviewed producer of `launch.json` exists. The A2–A4
  `step_release` writes only `m10-launch.json` (`{bootstrapAnchor, at}`, and only when `OPEN_GAPS` is empty). Combining
  it with the A2/A4/bytecode receipts and the release into one record is unreviewed. **Every `anchor-pending` start
  refuses with `HOLD`.**
- **The wrapper does not re-derive A1 or the output root** (no keccak in the standard library). It relies on the
  harness's A2 `authenticate` and on root's review of the copied receipts.
- **Crash after the head moved past N but before finality passed N:** there is no automatic detection before launch
  (the EL is embedded). In `anchor-pending` the client refuses (head ≠ N). Root must then record `bootstrapped` with
  finality evidence, or roll back (re-download). Any other state refuses.
- **No accepted record is fabricated.** Coverage requalification, the launch record, the lifecycle and the
  `OPEN_GAPS` closure are all HOLD.

## Root command (prepared; NOT run)
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-wrapper-integration-stage
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-wrapper-tests.guard -- unshare -rn bash $S/jobs/root-wrapper-tests.sh
```
It runs the existing suite on the BASE and on the CANDIDATE, plus the new release suite. Each must report OK with no
skips.
