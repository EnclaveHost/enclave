# Canonical verifier build storage plan — not implemented or tested here

This preserves the source-only storage review. The existing r7 canonical Rust verifier has not been compiled. Its build wrapper writes outputs on root and leaves TMPDIR unset; the rejected1804 admission wrapper must not be used.

A new r8 implementation is being prepared separately. It will keep scratch, logs, temporary files and binaries in one guarded /vm run, require all265 recovery parts independently confirmed, and retain the40GiB disk floors, full8GiB root native reservation and16GiB host memory floor. No actual build or production validation was performed for this record.

Root review refinements: read-only home/tmp binds must occur only inside a private mount namespace with propagation made private; this does not make the whole root filesystem read-only. Limit captured metadata without inheriting a1MiB file limit into compiler outputs. Root free-space delta is advisory because other processes can write; explicit floor checks remain mandatory. No USB writes, resumed downloads or RPC VM startup are authorized by this plan.
