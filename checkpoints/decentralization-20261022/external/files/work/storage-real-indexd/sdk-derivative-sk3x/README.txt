TEST-ONLY DERIVATIVE of the SDK worker's frozen tree (work/storage-fencing-implementation, FINAL-tree.sha256
323d30385f293a135140f9b571101c0c835dd85856b172a238212ea72b3f8abc, 98 files; copied from sdk-snapshot-final, which was
verified against that manifest). Exactly ONE file differs: src/real_fencing.rs, where ONE test is APPENDED
(real_fence_blocked_then_explicit_unblock_recovers_v2_converges_and_resurrects_nothing); TEST-ONLY.patch is the exact
diff and removes nothing. No production SDK code, no SDK worker source and no frozen hash is changed. Purpose: close the
3-indexer post-unblock recovery assertion gap (coordinator finding). Owner: indexd worker 6b7af721.
