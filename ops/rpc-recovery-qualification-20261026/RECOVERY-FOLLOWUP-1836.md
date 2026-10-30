# Recovery and writer follow-up, 2026-10-26

Root1546 performed a bounded read-only Base journal/direntry inspection with the VM off and qemu-nbd/nbdfuse both read-only. The actual Base backing uses discard=ignore. Journal size1GiB, start0, sequence17671. Deleted-directory listing /data/db contained only dot entries: no MDBX inode candidate for the proposed targeted extent-map recovery. Clean unmount, nbdfuse0, unchanged image inode/size/mtime/ctime, no remaining open handles. This does not prove forensic recovery impossible; it supplies no justified faster recovery route. The resumable archive download continues outside the original image.

Writer r2 source is frozen but UNQUALIFIED: root1545 ran158 tests,157 passed/1 failed/0 skipped. Failure is the provisional evidence bounds regression: expected capacity-full refusal, received invalid-evidence refusal. r3 diagnosis/fix is assigned; no activation. Older-claim startup recovery and the derivation driver remain open requirements.

Cold r8 independent review clears owner copy/verify/retry; it does NOT clear privileged cutover as documented. Root-staging of all helper bytes, bounded config reads and inode-aware process visibility are required; r9 is in preparation. No cutover/reclamation has occurred. Existing44GB copy and originals remain intact. Administrator controls preserved; production RPC replacement incomplete.
