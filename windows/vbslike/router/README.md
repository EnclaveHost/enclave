# Composite Windows app router

This maintained source reconciles the installed two-manager router. Existing
per-domain control, custody callbacks and ciphertext data continue to route to
the original manager. Native desktop creation uses the owner-pinned deployment,
its separate namespace, and a persistent ambiguous-submission journal.

The explicit `native-24g-in-32g-v1` profile must also be selected on the native
manager: 24,576 MiB application RAM reserves 32,768 MiB physical VM RAM here and
there. The generic desktop memory policy is not substituted. CPU allocations use
the same maintained helper as the managers. The composite reports one shared
logical capacity; it is not a third independent memory pool or an atomic host
reservation authority. The installed router's 17 GiB startup headroom check is
preserved here, but does not satisfy the separate RPC admission's actual 18 GiB
floor, prospective commitments and startup overhead. No deployment is implied.

The installed route rejects owner-committed `bootstrap` packages. The newer
manager supports those public/custody-v2 packages directly, so routing its advertised
bootstrap capability through this router still requires explicit integration and
qualification. Existing custody callbacks are preserved; startup package support
must not be inferred from that. Do not activate this as a complete newer-manager
bundle until that mismatch, protected installation and serving transition are
resolved. Restarting a manager can destroy serving continuity even when its VM
remains running.
