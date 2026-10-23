# Rebuilding the frozen-0630 commits

Each `<side>/patches/` series applies with `git am` (or `git apply --cached` per patch) onto its base:

| side | base | how to obtain the base |
|---|---|---|
| root-kernel-lock-336ea56a, s-holder-f6de2364 | none (root commits) | `git am` into an empty repository |
| root-snapshot-lifecycle-fd6a1762, a-native-relay-71448f63 | 2efc4a83 | frozen-0420-export/a-policy-callers-2efc4a83 (itself on the 921d60c2 recipe of frozen-0410) |
| p-deadline-d0775541, e-history-afc443e0 | 7b4dd692 | frozen-0410-export/p-real-history-7b4dd692 |
| p-compose-9e838ba7 | d0775541 | p-deadline-d0775541 above |
| c-carriers-0757085e, f-lifecycle-6c38c048 | 427780bb | frozen-0410-export/c-host-services-cold-427780bb |
| root-holder-c3efff41 | f6de2364 | s-holder-f6de2364 above |
| d-linux-fec43a6a | 493ee9ee | an ancestor of the pushed `candidate/decentralized-control-20261022` (dfe020abf). `git am --committer-date-is-author-date` with committer SteveDeFacto reproduces the exact commit ids |

`../verify-frozen-0630-export.py` does all of this offline and writes `REPRODUCE-CHECK.txt`. `files/` holds every changed
file at its head blob; `INVENTORY.json` records commits, trees, blobs and sha256s.
