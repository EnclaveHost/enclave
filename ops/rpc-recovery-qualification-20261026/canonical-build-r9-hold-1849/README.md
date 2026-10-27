# Canonical build wrapper r9: source preserved, tests and activation held

R9 adds recursive read-only namespace handling, strict guard-result checks and output-capture changes. Before running its tests, root identified a process-lifetime bug: the code confuses an exited but unreaped leader with loss of ownership and consequently cannot terminate surviving owned group members. EOF and sink-error cleanup also need correction. R9 has not passed tests and must not be activated. A new r10 correction is in progress; old stages remain frozen.

The prior r8 tests actually passed31 cases, but they do not qualify this changed version. Canonical Rust remains uncompiled; all265 recovery parts, structural validation, state verification and chain anchoring remain prerequisites. No USB writes, downloads, RPC VM startup or production changes occurred here.
