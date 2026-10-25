# M7 test validation and negative control: COMPLETED (root foreground run, exec54162, 2026-10-25 19:11Z)

**Run:** `test-offline-r3.sh` (sha256 `f617eaf7f4861377a63973fa3ca297980378d53221a9c1b69b26310ae3a0c5ec`) with
`artifact.py` (`cce2895c752a1fa297961b0e8022e704a61b62474948a280e9f0394fa07a53d9`). These are the exact executed copies.

```
python3 work/claude-test-queue.py --mib 1792 --log $W/control-recovery/logs/test-offline-r3.guard -- unshare -rn bash $W/control-recovery/test-offline-r3.sh
```

- **Environment:** offline (`unshare -rn`), the installed shared queue `b7de4344…` (`../recovery-preparation/root-installed.sha256`)
  at 1792 MiB with the 16 GiB floor, and the pinned `jobs/env.sh`.
- **Result:** **rc 0**. Guard peak 1550 MiB, host minimum 19303 MiB (`logs/test-offline-r3.{out,guard,rc}`).
- **Patch:** `../patch/base-l1-verify.patch` == `e9dfb8c6…`, unchanged.

| phase | provider source sha256 | providers test binary | result |
|---|---|---|---|
| patched | `201d9b8c…` | REBUILT (`fresh:false`), sha256 `6f447ae9…` | **14/14** = 7 new M7 + 1 pre-existing `chain_provider` + 6 pre-existing `l2_chain_provider` |
| CLI `l1::` (patched) | — | recompiled against the rebuilt providers | **5/5** (1 new) |
| CONTROL (both checks disabled) | `f4773918…` (2 lines differ: `if false && !self.trust_rpc {`) | REBUILT (`fresh:false`), sha256 `5d0423ea…` **≠ patched** | **rc 101: 9 passed, 5 failed**, exactly the five expected |
| patched again | `201d9b8c…` | REBUILT (`fresh:false`), sha256 `6f447ae9…` (identical to the first) | **14/14** |

**The five faults the control shows the M7 checks detect:**
- `altered_log_is_refused`;
- `forged_header_cannot_vouch_for_forged_receipts`;
- `omitted_receipt_is_refused_and_not_cached`;
- `reordered_receipts_are_refused`;
- `transactions_must_match_the_verified_transactions_root`.

The forged-header test fails in the control because its header fetch is inside the disabled receipts check (provider
source, lines 484–493 test / 258–259 check).

**Rebuild evidence:**
- `build-artifacts/<phase>.providers-artifacts.jsonl` holds Cargo's `compiler-artifact` records for
  `base_consensus_providers` only, extracted from the full `--message-format=json` output.
- The full JSON files (~457 KB each) are not published; their sha256 values are in `build-artifacts/full-build-json.sha256`.
- Clean and build logs: `logs/<phase>.{clean.out,build.err,test.out}`, `logs/cli.test.out`.

**Why this harness exists:** see `../earlier-failures/`.

**NOT established:** a production binary build of patched `base`, activation, or a full authenticated bootstrap. These
are unit and integration tests of the patched provider and CLI code with httpmock JSON-RPC fixtures.
