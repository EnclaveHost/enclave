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

## Opt-in retained-manager routing (source only)

The control library can retain the original legacy manager, the pinned native
manager and one separately enrolled creation manager. Existing IDs keep their
original control, DELETE, custody and ciphertext data route. New non-native IDs
use the strict `nx` namespace; caller IDs, collisions and cross-role inventories
are refused. All three inventories count once toward the same advertised pool.
The enrolled manager requires the shared ledger, a distinct VM ownership marker,
CPU accounting and exact guest quota confirmation even for direct requests.

`retainedLegacy` is an installation-supplied trust boundary. Its legacy image pin
must come from protected installation provenance. Compatibility preserves old
served capabilities and protocols while allowing absent optional old fields;
the exact retained health method is exercised in an inert source-shape fixture.
The fixture is not a live capacity or installation observation.

Without an `admit` provider this mode is adopt-only: existing per-ID routes work,
but health and creation stay closed. A provider must establish an exclusive old
creation fence (including direct callers), settle queued/inflight submissions,
seed the shared ledger and bind the original journal transition. It returns a
synchronous guard checked before and after journal intent; asynchronous truthy
values are refused. Full inventory/capability state is rechecked after admission.
A trusted callback in tests does not establish any of those production facts.

The router executable is still the two-manager entrypoint. The enrolled manager
entrypoint is opt-in with `ENCLAVE_ENROLLED_INSTANCE=1`, fixed 8101/8102 ports,
`enclave-enrolled-` scope, guest CPU enforcement and all shared-pool pins.
No production transition provider, stream handoff or installed enrollment is
activated by these source changes. Do not restart the original manager or reset
its journal: retained relay/readiness keys and ambiguous submissions must survive.
