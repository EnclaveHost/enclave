# State-v2 validator source audit

Source review only, against pinned reth 7134be3. No recovered database was opened, no build or fixtures executed, and no source guards were bypassed. These findings do not establish database integrity or canonical state.

The saved compact-backup inventory has no RocksDB entries. The helper reads MDBX state and static headers, so a history-index requirement must match that scope. The audit also identifies a StageCheckpoints key type mismatch, incomplete-state refusal conditions, and a Finish codec feature question. The independent review qualifies the proposed implementation; neither report is a runtime test receipt.

Frozen base-state-readonly-stage/r10 remains unchanged. Its Rust helper is still uncompiled; wrapper tests do not qualify Rust compilation. V2 may at most report partial state checks, never full integrity or chain acceptance. Recovery still requires all 265 parts, structural validation, state verification and an independently authenticated canonical anchor before acceptance. Retain original media and all recovery copies meanwhile.
