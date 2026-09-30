# Isolated app RAM share enforcement — 2026-09-30

The isolated backend previously treated CPU share as a price fraction and admitted a separate, manifest/model-sized guest. Eyesoff-AI's 7% CPU/RAM share therefore launched a 72 GiB model guest (72.75 GiB host unit cap). Its approximately 52.5 GiB observed host use was possible without exceeding that incorrect-for-the-share reservation. This was an admission bug, not evidence of a leak.

## Enforcement

`guestd` rejects a launch before allocation when its effective app RAM exceeds `floor(cpuShare * guestPoolBudgetMiB)`. A model's minimum guest memory is a requirement, never an exemption. Invalid/missing shares are rejected. This check precedes duplicate-name reconciliation. Existing immutable guest RAM and systemd MemoryMax limits bound admitted instances.

The manifest policy and attested identity are unchanged. Fixed kernel/runtime, generic minimum boot size and QEMU overhead remain explicit platform reservations in the aggregate pool. They are not extra model/app RAM. Free host memory never overrides a share.

The supervisor source mirrors the check before claiming, when adopting a held guest and immediately before launch. It reads the manager's model floors instead of an obsolete hardcoded 50 GiB floor. This is a separate measured control-image rollout; the production enforcement below does not depend on that precheck.

## Production result

- metal0 manager configured pool: 90,112 MiB (88 GiB). This is the actual running configuration, not the previously discussed 64 GiB target.
- Eyesoff share: 70 milli (7%); allowance 6,307 MiB.
- Current 27B profile requirement: 73,344 MiB app/runtime allocation excluding fixed 384 MiB guest overhead. Required whole-percent share is at least 82% on this pool. This is the current configured profile, not a measured minimum for the model itself.
- Other apps already hold 40% CPU share, so 82% is not an immediately available allocation; rebalancing or a smaller memory profile would also be necessary. No owner-controlled shares were changed.
- Binary-only manager rollout preserved all six guest instances. A live POST using the real 27B bundle and its existing deployment name returned HTTP 422 `ram_share_too_small`, allowed 6307 / required 73344 MiB, without allocation.
- The one pre-existing oversized Eyesoff guest was then removed through the normal manager API. The old control image's automatic restart was rejected by the new manager; its normal failure/lease-release path ran.
- The five remaining guest identities and reservations were preserved.
- Measured guest/runtime images, masking, verification, guest release lists and the control image were not changed. The supervisor precheck is source-tested but is NOT in the running measured control image yet.

Binary: `guestd.ram-share-cf12c195d6ef`; SHA-256 is recorded with the rollout evidence. The active unit override points to the installed binary under `enclave-prod/bin`, not a build worktree.

Operational evidence (local): `/home/steven/enclave-bench/ram-share-enforcement-20260930/`: `preflight.json`, `production-refusal.json`, `stop-result.json`, `verified-live.json`, `rollout.log`, `manager-sha256.txt`. Saved previous service configuration permits an explicit rollback; a rollback would remove the new admission guard.

Legacy adoption does not infer chain shares from old manager records. The one-time live chain audit was therefore required before removing the oversized guest. The old control image still learns the refusal at provision time; the prepared supervisor precheck avoids taking that lease in the first place after its measured rollout.

## Validation

- Full guest-manager Go suite passed.
- 46 supervisor claim-gate, guest-pool and release-ticket tests passed.
- Added boundary/invalid-share tests, 27B model-floor bypass tests, no-allocation and duplicate-name tests, ordinary-app rejection, and held-guest adoption checks.
- Live production rejection and automatic restart rejection verified separately from unit tests.
