# Full Windows verifier code-path qualification

Root-owned job root-consumer-head-windows-1150 completed successfully against exact candidate64156dcd91ff1e769e74f9c26a846be19254c716: six tests passed, zero failures/cancellations/skips/todos. Duration329.9s, peak process-tree memory723MiB, minimum physical host available16589MiB. All tracked source files were compared with the exact Git archive, and the EIP-2935 genesis/runtime binary pins were checked.

Tests exercised state enumeration, administrator AddressBook migration and outsider refusal, endpoint ownership, session termination, tampered/missing/stale proof rejection without BASE_RPCS fallback, and SessionVault owner policy. This runs the Windows JavaScript code paths on the Linux canonical-trie test rig. It is not evidence of deployment on the Windows host, production SNP attestation, or live mainnet cutover.

The earlier Claude-owned attempt stopped without a terminal receipt after its CLI exited. Root confirmed all of its test/queue/node processes were absent before launching this independent complete run. No partial result was counted as a pass. The accompanying agent report predates the final root receipt; this status and result.json supersede its pending test status.

Remaining feature-preserving cutover includes complete lease-event history for the secret-release writer, custody v2 authority/freshness qualification, paid-provider derived authority, and real mainnet proof/transaction/blackout/recovery validation. Administrator rights remain intact. No production configuration changed in this qualification.
