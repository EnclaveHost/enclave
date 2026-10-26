# RPC recovery and credit work, October 26

Credit source committed at 12b41d4592f4a8d216c827b1bccc8f4d79b51c07: 31 checks passed, plus both actual credit bundle modes. Endpoint selection only; no browser cryptographic verification or live cutover.

Actual test exit codes: {'root-a1-capture-0232': '1', 'root-reanchor-recovery-0232': '1', 'root-finality-prototype-r2-0234': '0'}. Capture original ran25 with24pass1fixtureERROR; retained unedited. Finality r2 ran20JS+27Python passing after correcting fixture identity; product replay checks unchanged. Finality prototype qualifies a running process only. Re-anchor results are in actual outputs, never inferred from prepared reports.

Composition r7/r8 and restart design are preserved drafts, not qualified runtime. r8 remains partial. All activation HOLD flags remain false. All test data synthetic except explicitly recorded original receipt gate tests. No live installation, configuration, or admin changes.

Outer SHA256SUMS covers all published files. Source and jobs retained, but clones, binaries, caches, node_modules and active new revisions are omitted. Inner manifests can refer to omitted files; they are provenance, not a claim of complete published checkout. Later source work continues separately.
