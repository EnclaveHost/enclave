# Concurrent main advancement

Read-only GitHub comparison at 2026-10-23T10:36:51Z: main moved from7752a4239b3bec2cf452491cd1b95164a8c2bdb8 to68b82926968c99503d38ae78dbcb04694cc2c56c by three commits. Only README.md, PRODUCT.md and docs/security/nucbox-custom-vm-verifier.md changed. The commits document the E3 box-local Windows memory-isolation experiment and retain operator/external-audit limits. This review identifies source overlap; it does not independently validate those scientific claims or release the ongoing experiment reservation.

Preserve all three commits in eventual integration. No runtime source or contract changes in this delta, so it does not by itself justify rerunning runtime tests. No main or checkpoint ref was modified by this read. Checkpoint remainscadf0ebb at the separate 10:35:54Z remote-ref read. D must report the actual current main, not claim7752 unchanged. Source candidates must not overwrite the newer public documentation.
