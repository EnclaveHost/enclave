
Native cleanup integration candidate (not production activation)

`NativeRpcStart.Prepare` consumes the immutable lifecycle-bound start intent
before a future independent owner releases the start work gate. `Submit` now
requires that prepared record and repeats current authority/device/admission;
it cannot create missing intent. The definition lease remains unable to start.

`NativeRpcCleanup` settles the exact original returned start operation only after
all three original owner/observer/provider-child handles prove death, then
consumes one stop intent/submission and invokes RequestStateChange(3) once.
Lost or incomplete start/stop responses remain held. Pending/abnormal/recurring
jobs do not authorize stop or release. Completed failed start jobs may require
cleanup; a successful stop still needs original owned Off/zero-memory readback.
All provider-fenced/reservation-release claims remain false.

An explicit cleanup worker profile has a separate <=30s supervised lease, clipped
to original startup deadline+30s. This cannot extend start authority. Protected
cleanup journal grants only stop submission and exact-operation observations;
reconcile grants observations only. The cleanup owner transfers query/sync-only
original process handles into its suspended child before observer release. The
child checks original protected contract, worker image, boot, nonce, PID, creation,
SYSTEM identity and all three exact deaths. No PID lookup or task-state shortcut.

**Still missing:** independent lifecycle owner/dispatcher, protected start lease
and start-group record producer, durable pre-workgate registration/handle transfer,
and manager start/bootstrap integration. The new cleanup entrypoint is not
automatically dispatched and is not target-qualified. Native VM cleanup is not
provided by merely killing local helpers. Hosted tests mock provider, runtime,
clock and worker-death witness; administrator namespace checks are real. Actual
SYSTEM topology and handle transfer remain compile-only. No target VM has started.

Root review:23 new composed tests including three actual administrator protected
namespace methods, all new no old completed suite replay. Existing start fixture
updated for split preparation; no historical workflow dispatched. Hosted compiler/
harness/production entrypoint compilation20s each, image262144/output65536/total1MiB/
self256MiB CPU1, external observed512private450RSS, hosted3min unchanged. Local
helper128MiB/queue256/RSS220/27648floor+384+actualpending. Existing rawhandles owned
by bounded process lifetime; witness owns minimal duplicate handles. Sole original
start-group producer is intentionally absent until independent owner integration;
no fake SYSTEM bypass/digest implemented. Stop is restricted to settled known start
and exact original owned VM; refusal never deletes/replays/adopts/frees resources.
Provider method only compiled, never invoked in CI. Native target and full
decentralization remain unqualified. Source refs moved into WMI closure, controller
excludes actual provider/start/cleanup. All source files finite <=65536.
