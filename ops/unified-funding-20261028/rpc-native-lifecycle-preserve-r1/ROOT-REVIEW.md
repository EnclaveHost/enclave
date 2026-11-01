
Native lifecycle/start composition candidate (not activated)

Explicit start-owner/start-observer/start-child roles now use a protected start
lease, independently armed SYSTEM lifecycle peer and a second pre-resume gate.
The owner prepares the original start intent before creating its suspended child.
It publishes exact worker contract registration after observer binding and waits
for the lifecycle process to pin the original worker image, boot, nonce, PID,
creation and SYSTEM identity for all three peers. The lifecycle process publishes
workers/bound records before the owner resumes; the child rechecks those records
and fresh physical admission before one NativeRpcStart.Submit. Definition commands
still end owned-Off; manager default behavior is unchanged.

NativeRpcLifecycleEntry is a separate SYSTEM entrypoint with an independent watch
thread armed before publishing authority. Original deadline or failed original
worker triggers one cleanup dispatch independent of a blocked caller/main loop.
A dedicated short cleanup owner/observer receives query/sync-only duplicates of
the retained original peers, after exact death. It invokes the existing original
stop-only worker. Task creation and Run are one-shot, no retry on ambiguity.
Cleanup time is clipped to original D+30s, never a start extension. All result
fence/release claims remain false; no adoption or readiness claim is added.

Still missing: trusted manager launcher that prepares/schedules the lifecycle
contract and worker copy, secondary protection if the lifecycle process itself
dies after a successful start, actual SYSTEM scheduler/process-transfer/provider
qualification, and original bootstrap/enrollment. A successful short worker exit
only keeps the watch until original D; there is no persistent-service adoption.
The independent callback cannot establish VM death if provider response is lost.
Target activation remains unadmitted. Start asset checks still require original
VMGS hash; definition/TPM may mutate that file, so real mutable VMGS custody must
be qualified/implemented before target start rather than relaxing that check.

Shared strict NativeControllerFiles extracted byte-identically into its maintained
file. Native-only compiler symbol excludes unused ordinary ProviderStart reducer
and ordinary HyperVStartProvider.Start entrypoint; shared exact provider helpers
and all native provider behavior remain. Legacy compilation without the symbol
is unchanged. No cap increase.

Twelve new checks. Real independent watch thread while caller sleeps; actual held
inert child process death before deadline; observed exact exit; one-shot failed
dispatch; clockrollback and invalidwindow; actual administrator start/lifecycle
namespace write separation, pinned originalcontract/image/boot/window, foreign
attempt refusal and non-SYSTEM identity refusal. Native SYSTEM TaskScheduler/WMI
provider/VM operations compile ONLY. Both independent lifecycle binary and explicit
SYSTEM worker compile; current manager/controller is not rebuilt by this new test
(the extracted file helper is byte-identical). No old primitive suites replayed.
Finite fixed20s each, CPU1, self256MiB, observed512private450RSS, image262144,
output65536, total1MiB, hosted3min unchanged. Local helper27648+384+actualpending.
No target account/native/task/VM/export/funds/catalog changes. No author retry or
delegation. Initial source-edit helper failed only at shared-helper class search
(used wrong declaration string); prior profile edits retained, subsequent exact
partial declaration extraction audited unchanged. No native attempt occurred.
