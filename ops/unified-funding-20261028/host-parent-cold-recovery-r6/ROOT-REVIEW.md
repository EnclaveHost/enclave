# Parent journal cold recovery and ownership regression closure

Staged only; no production change. Base candidate is the exact published commit/path in BASE.json. Apply the two overlay files to that candidate; external generated closure dependencies remain pinned in each driver. No product source changed between r16, r17 and r18. Full goal remains active.

## Actual failures and repair

R15 ran four new cases against the prior candidate: two passed and two failed. In a fresh child process, injected final ACK directory-sync failure combined with failed history recording and failed ACK retraction leaves visible state/intent/ACK. A fresh owning process can use it only after real boot fsync and recorded verification; injecting boot fsync failure refuses. These positive cases use real files, processes and flock, not the old process's UNPROVEN map.

The failures: deleting an established parent file was accepted as empty; an external TEST write could be overwritten from the old parent's cached state. R16 adds durable parent-established provenance before first use, boot file/provenance/directory sync, and content/provenance comparison before cached reads or mutations. Unknown changes latch refusal and notify composition withdrawal. A marker without its file refuses instead of creating an empty replacement.

An existing unmarked parent requires explicit importSha256 (parentImportSha256 in composition), matched under the held lock. The actual journal validates and syncs the existing bytes; only separate provenance is added. Wrong/missing hashes refuse. Existing pending bytes are preserved exactly. This is a deliberate adoption path, not automatic reconstruction from chain flags or loss of pending records. New tests prove import, restart, missing-file and changed-provenance behavior.

## Qualification

- R16: six new cold/import cases PASS, zero skipped/cancelled.
- R17 on the final product: composed ownership 33 PASS, raw effects 3 PASS, stale parent 2 PASS, cold/import 6 PASS. Adapted historical ownership suite 8 PASS / 1 FAIL.
- The sole R17 failure was old O2 test ordering: it awaited owner release before allowing the in-flight readiness operation to settle, and attached its rejection assertion only afterward. The new contract deliberately holds ownership until that work settles. This caused an unhandled verification deadline in the test; it did not demonstrate an emitted signature or early owner release.
- R18 changes only O2 observation/order: install the rejection assertion immediately, require release still pending, then finish readiness and verify refusal plus successful release. The one affected case PASS, zero skipped/cancelled. Product source is unchanged.

Together the final product has 53 distinct passing relevant cases (33 + 9 + 3 + 2 + 6). Do not describe R18 as a 53-case repeat. Every failed run is retained. Resource caps: 512 MiB outer, 450 MiB process tree, 27648 MiB availability floor, one CPU, no swap, isolated network namespace/loopback. No compiler, Anvil, public RPC, real manager VM, signatures for production, payments or production state were used. Child durability faults operate on owned temporary files only.

## Remaining work

This qualifies the tested Linux file/flock and generated composition paths. It does not qualify a Windows process lock, actual installed manager continuing authorization, VM/ingress/storage/secret withdrawal after controller or manager death, independent live authority, full fresh-process native-chain migration, or total loss of all private journal/provenance files. Filesystem rollback to a consistently old private directory is not covered by a local hash check; canonical monotonic authority and migration proof remain necessary. Actual capacity/attestation-before-listing, paid-work/provisioner sponsorship, protected canonical Offline gas, automatic funding and the full censorship-refusal demonstrations remain open.
