# Recovery follow-up, 2026-10-26

Root1550 completed the125,195,719,424-byte gvs5h copy and fresh destination SHA256 verification against the unchanged source inventory. Six files/eight entries, logical digest566784a08712e71eae9f6484e08f1a0f5392ba0f3355abdb651b23c19e4b76d2. Main512 with200MiB/s cap and16GiB host floor; peak37MiB/minhost27387MiB. Original remains intact; NO NVMe reclamation yet. Alongside prior44GB gguf copy,169GB is now verified. hf-convert159GB remains un-copied.

Root1553 writer r3 slice passed158/158, zero skips/failures. Peak243MiB/minhost28837MiB. The fixture shape fix is qualified. This is source/fixture evidence, not full build/image/SNP or owned-node timing. Cold-history recovery and driver are still being implemented.

Root1560 reclaim r1 fixtures passed10/10. The r1 tool is SUPERSEDED and NOT safe for production use: it depends on the insufficient r8 path-only scanner and ignores destination users. r2/r9 fixes remain required. No cutover or deletion has occurred.

The proposed committed positive-authority lease index was rejected after review; partial implementation remains unqualified and unactivated. The selected alternative verifies backward header links from the authenticated bootstrap anchor and verifies complete receipt/transaction roots for relevant blocks, retaining existing authority gates. Driver work is separate. Neither is yet a production replacement.

Fetch1552 briefly yielded the small lane for the user-signed native policy receipt check. All108,649,250,816 committed bytes survived; fetch1562 resumed from exactly that offset. Existing apps/admin controls unchanged by this work.
