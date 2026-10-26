# base-state-readonly-stage/r2 = r1 + exact pins for alloy-primitives/alloy-consensus/serde_json/eyre (review 1695)
# (PREPARED by Claude, SOURCE ONLY; nothing built or run by Claude)
Tiny OFFLINE READ-ONLY helper against the exact reth 7134be3 crates (Base v1.5.1 lock): (1) DbStateRoot::root() vs the Finish
header stateRoot, (2) FULL plain->hashed account/storage equality + counts (v1 layouts only; v2 = NOT_APPLICABLE), (3) storage
settings, all stage checkpoints, explicit INCOMPLETE history integrity. Details/limits: logs/claude-base-state-readonly-tool-1695.md.
Root order: build (4096) -> fixtures (512) -> review -> only then the real read-only view run (separate authorization).
