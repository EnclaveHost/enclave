# Installed-source manager HTTP and late ownership effects

## Actual manager interface baseline

Three local HTTP cases pass using the exact Windows manager server09085ceecb8dedab1c569b67db4998b8c46e5d360fc8aa2f83425b835c0db0dc from the source archive previously matched to installed releases. All114 archived control files match source-manifest58ca73a0d002619990c25eedc4d66188533dd76b739afdc2cd8e0efbb4d1a929. The full119-entry archive is pinned in PROVENANCE; this review retains three principal source files and all fixture/result/input pins, not a claim of a self-contained source distribution.

Actual manager and HTTP code run; launch/readiness is a TEST backend. No PowerShell, VM, real guest, production pairing key or remote manager is used. The loopback HTTP server is the internal surface normally wrapped by guestd-control; this does not test production authentication. Tests prove: no continuing permit capability claimed in this configured baseline; legacy create/read/explicit stop works; an unimplemented /vms/:id/permit request returns404 and leaves the legacy tenant unchanged. The request path is a proposed extension probe, not an implemented public API contract. These passes establish a compatibility baseline and missing interface, not new deadline enforcement or production support.

The source archive initially refused five root packaging entries under a too-narrow extraction allowlist, after114 control files. Root inspected all five names, explicitly allowed them and compared every already extracted byte; no archive code ran during extraction. The corrected run uses owned net namespace/loopback,256MiB/220RSS/floor27648/CPU1/noSwap. Unit ecda4b764b984ed58710a0e4db4d6edd terminal/MainPID0,3PASS0skip, peak105MiB/minavailable34372MiB. Legacy readiness is not continuing authorization. A separately opted-in manager mode and actual migrated-instance boundary must preserve unmigrated tenants; Linux source-to-installed-binary provenance remains unresolved.

## Raw effects after cancellation and timeout

Root added three cases against the frozen root-r7 generated gate/runtime and sidecars, NOT the concurrently authored r5 candidate. All3 fail at their intended assertions,0cancelled/0skip:

1. The real runtime's allow call times out after3seconds. Its catch path holds the boundary, but then owner release finishes and a second flock owner enters. The TEST raw allow ignores abort and later completes: the externally observable TEST access flag becomes true. Timeout was not proof that the operation had ended.
2. Readiness throws after spawn. The operation ends before the staged instance is registered as an owned resource; owner release succeeds while the TEST VM remains.
3. The exported raw lock release is invoked, and a second real flock owner acquires. The retained durable handle still reads and assertLive succeeds because inode equality alone does not show the original capability still owns the lock.

These tests use actual generated protocol/runtime and real file/flock operations, with explicit TEST manager/remote boundary/authority. They are not production incident claims. Unit470b6c7bfd2e4fb899c8dc2b471d1358 terminal/MainPID0,256MiB/220RSS/floor27648/CPU1/noSwap, owned namespace and no external RPC/compiler/Anvil. Terminal r5 must be tested against these requirements, even if a new authored test incorrectly expects release before raw late effects settle. Do not test mutable author output or waive ambiguity to make a suite green.

No production app, relay, controller, manager, funding or RPC change occurred. Complete censorship resistance still requires independently enforceable manager/ingress/storage/secret boundaries, live proof authority, prelisting attestation/capacity, sponsored protected Offline gas, automatic event-driven funding, actual fenced migration and cold-recovery/refusal demonstrations.
