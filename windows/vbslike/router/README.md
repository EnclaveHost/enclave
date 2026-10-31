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

Owner-committed public and custody-v2 startup packages are forwarded unchanged
only to a direct-capable legacy manager with the matching Shield-direct runtime.
The router checks bounded canonical bytes, package schema, deployment, runtime,
secret mode and custody/config scope before writing a launch intent. This routing
check does not authenticate an owner or derive the actual artifact's AppID. The
manager still fetches the component and verifies the exact AppID/package binding;
the guest independently verifies the live owner commitment. Native desktop
continues to reject these packages. Ambiguous backend errors retain the journal.

Protected installation, shared-pool enrollment and a serving-preserving transition
remain unqualified. Do not activate this as a production bundle based on fixture
results. Restarting a manager can destroy serving continuity even when its VM
remains running.
