# rpc-fixtures-qualified-20261026 (preservation snapshot; nothing run by Claude)

These are targeted fixture and test-only fixes plus root's actual evidence. **Test qualification ≠ production qualification.**
- The external public backend stays in use until the live gates pass.
- Admin authority is preserved. Custody v2 stays REFUSED, and lease consumers and A1 capture stay on HOLD.
- No product source was changed. Earlier ops snapshots are kept as historical records and were not rewritten.

## Actual results: executed vs reused (counts from the copied verdicts/TAP)
| Root job (rc) | Executed by root | Reused | Evidence |
|---|---|---|---|
| `root-mcp-authority-r8-0415` (0) | **8**: cli-combined 4/4 base + 4/4 candidate, with P8 | **65** from root's r7 (6 rows); builds + comparator 23/23 + EQUAL `426a7135…` from r6 | `evidence/mcp-r8-0415`, `evidence/mcp-r7-0407` |
| `root-provider-verifier-r2-loopback-0349` (0) | patched **61/61** (chain-verifier 15, paid-provider 11, collateral 8, route-composition 7, agent-verifier 5, metal-measured 15); negative `pre-attested-chain-verifier` 14/15, whose 1 failure is the expected G5 refusal | — | `evidence/provider-loopback-0349` |
| `root-scripted-adapter-fix-0359` (0) | **16/16** (renewal-keeper) | — | `evidence/scripted-adapter-0359` |
| `root-native-readiness-0359` (0) | **9/9**, with the native gate run (actual PowerShell) | — | `evidence/native-readiness-0359` |
| `root-offchain-registration-0407` (0) | **3/3** heartbeat, on actual Linux + Windows paths; the negative is historical | — | `evidence/offchain-registration-0407` |
| `root-lease-fixture-fix-0342` (1) | P3 lease **26/26** (designated 5, host-relay 3, pinned 4, migration 8, windows-current 3, windows-host-app-funded 3); windows-release-journal **6/7** | — | `evidence/lease-fixture-0342` (**original fail receipt kept**) |
| `root-release-journal-unprivileged-0407` (99) | none: the 512 MiB memory guard stopped it. **Not a test verdict.** | — | `evidence/release-journal` |
| `root-release-journal-unprivileged-0409` (1) | journal **7/7** (journal.rc 0) with DAC override dropped. The job rc 1 came from the runner's own summary-parser SyntaxError (`pass=`) | — | `evidence/release-journal` |
| `root-review-journal-receipt-0420` (0) | none: it parses the existing 0409 TAP/rc without re-running, giving 7/7 `ok: true` (tap `93abac3b…`, rc `9a271f2a…`) | — | `evidence/release-journal/root-journal-review-0420.json` |

**Why the original journal permission test failed:** the 6/7 in 0342 ran as root, whose DAC override bypassed the permission negative. The unprivileged 0409 run passes it.

## Correction to an earlier claim
The rig-rerun-r2 `cli-combined-independent` result was **NOT 4/4**. It was **3/4 in both trees**: the regex still had the old flag list without `--chain-verifier`.
- **The fix:** P8 (`stages/standalone-mcp-authority-stage-r8/patches/`, test-only) corrects the diagnostic. r8 then ran it **4/4 on base and 4/4 on candidate**.
- **The same rerun's other rows:** lease-relay-host-policy 9 + 9 and cli-independent-sessions 13 + 13 passed in both trees, **44** in all.
- **Still open:** offchain-heartbeat-writers was 2/3 in both trees in that rerun. It is addressed separately by the offchain stage (3/3 above).

## Contents
- **`stages/`:** exactly the files listed by each stage's own `SHA256SUMS`, plus `SOURCE-PINS.txt`. The inner manifests verify. The stages are scripted-lease-adapter-fix, windows-native-readiness, offchain-registration-fixture, remaining-composition-triage, standalone-mcp-authority r7 and r8.
- **`evidence/`:**
  - root queue `out`/`rc`/`guard` files;
  - verdicts, TAP and rc files, and logs from the actual result directories (each file under 256 KiB);
  - the release-journal job scripts (`work/jobs/root-release-journal-unprivileged-040{7,9}.sh`).
- **`reports/`:** the Claude result reports for these stages.

## Omitted (deliberately)
- **Trees and other bulky output:** clones and trees (`tree/`, `base/`, `cand/`, `repo/`, …), `node_modules`, forge `out/` and `cache/`, binaries, the 0407 `check.index` (1 MiB), and every file of 256 KiB or more or not UTF-8. That is about 39k tree files per run directory.
- **r6/r7 build trees:** the existing full builds stay in place in r6's run. r7 and r8 pin them through `R6-RUN-RECEIPT.sha256` and `R7-RUN-RECEIPT.sha256`.
- **External inner references:** r2's stage (patch, BASE/CANDIDATE pins, EXPECTED-TAP), r6's stage and run, the r12 final tree (P8 pre-image) and `relay-consumer-source` are referenced by hash only.
