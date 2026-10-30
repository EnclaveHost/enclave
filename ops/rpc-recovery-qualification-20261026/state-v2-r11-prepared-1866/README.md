# Base v2 state validator correction — prepared, uncompiled

The source corrects two typed checkpoint keys and adds conservative handling for snapshots without optional history indices, partial Finish checkpoints, interrupted unwind markers and MerkleExecute progress. It preserves required hashed-state and trie checks. V2 remains partial state verification and never claims full integrity or canonical chain acceptance. Header linkage fields are reported, not authenticated.

Actual wrapper qualification: 32 tests passed (10 storage guard, 6 mount identity, 16 capture/build gate). These tests do not compile or run the Rust validator. Prepared Rust fixture suite: 26 state cases/runs plus 6 argument/corrupt-input cases, not executed. Namespace qualification and the all-265 recovery gate remain prerequisites for an actual guarded build. Read the independent source review for unresolved issues; a source review is not runtime validation.

No original, recovered part or compact-backup data was read for this change. No RPC VM, host policy, wallet or production endpoint was changed. Preserve original media, stopped download and all recovery copies until structural, state and independently authenticated canonical validation succeed.
