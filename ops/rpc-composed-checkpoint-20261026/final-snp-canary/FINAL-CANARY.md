# final-proof-canary-stage: SNP hardware canary of the FINAL verifier-only image (PREPARED; nothing run, frozen or launched)

A narrow copy of `snp-verifier-canary-stage` (image 0235e7d96; root PASS 20261025T174309Z; kept unchanged), retargeted to
`final-proof-image-stage/out/dist-direct-10cdf913` and the source 10cdf913 (tree 3b0f8114).
**Scope:** boot, SNP attestation, config/HOST_DATA binding, tamper/replay/wrong-config/wrong-measurement refusal and route fail-closed
while the Base backend is unavailable. **This is NOT production proof serving.**

## Changes vs the old stage (everything else is byte-identical)
- `canary/run-canary.py`:
  - the image is `final-proof-image-stage/out/dist-direct-10cdf913`, with its `receipts/image-verify-direct.json` and `receipts/measurement-B.txt`;
  - the hard-coded measurement is replaced by `EXPECTED-MEASUREMENT.txt`. It is ABSENT now, so preflight and run refuse until root writes it and freezes it;
  - the receipt must ALSO be for commit 10cdf913, every check must be ok, and the image natives must be helios 8250f08a, listener 9ca75047 and witness 4fe0cd3b;
  - `EXPECTED-MEASUREMENT.txt` is a frozen pin.
- `tools/freeze.py`: sourceCommit/sourceTree come from run-canary (10cdf913 / 3b0f8114).
- `tools/stage-tree.sh`: `git archive` 10cdf913 from the clean clone `final-proof-image-stage/src-a`, which root's image build creates. The clone must be clean.
- `tools/env.sh`: the stage path.
- `test/canary-launcher.test.mjs`: the image path, and the commit's `metal/chain-verifier-image.json` sha `c8fde7bb…`, replacing 0235's `23ac96ad…`.
- `test/test_run_canary.py`: `expected-measurement` is required among the frozen pins.
- `canary/verify-canary.mjs`, `canary/owner-config.mjs`, `tools/prepare.sh`: comments only.
- **New:** `tools/write-expected.sh`.

Kept unchanged: all report, config, TLS, HOST_DATA, tamper and replay checks; the ownership-bound cleanup and foreign-process protection; both queue-lane locks; the 16 GiB floor; RPC-active admission (16384 + 3072); the guest at 2048 MiB in a 3072 MiB scope at CPUQuota 200%; 4 vCPU; and the production process checks.

## Root steps (from work/rpc-production-final-20261025)
1. Wait for `logs/root-final-proof-image-0500` to finish with **rc 0** and the line `FINAL-IMAGE-BUILT-AND-VERIFIED measurement <96 hex>`. The independent verifier receipt must be ok.
2. `bash final-proof-canary-stage/tools/write-expected.sh` (set `IMAGE_LOG=<logs/name without extension>` if the job log name differs). It refuses unless the log line, `MEASUREMENT`, `measurement-B`, the artifacts receipt and the verifier receipt (commit, all checks, natives) all agree.
3. `cd final-proof-canary-stage && bash tools/q.sh 512 prepare bash tools/prepare.sh`. This runs stage-tree, the canary's own unit checks (fake QEMU only), freeze → `FROZEN-PINS.json`, and the read-only `--preflight`. Root reviews the `FROZEN-PINS.json` sha256, including expectedMeasurement.
4. In the window root coordinates (KVM chat), with the RPC VM active and NOT restarted:
   `python3 canary/run-canary.py --preflight` (must end PREFLIGHT PASS), then `python3 canary/run-canary.py --run --kds off` (ROOT ONLY). It takes both lanes non-blocking, exiting 98 if busy.
