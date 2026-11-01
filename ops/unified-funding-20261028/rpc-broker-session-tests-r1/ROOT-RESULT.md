# Broker request/process binding qualification

Invocation `860ad533ad824f56aa61334817846e2c` is terminal, exit0, MainPID0.
16 test/subtest checks passed; one top-level subprocess helper skipped because
its actual executions are invoked by the parent fixtures. Fourteen real inert
child processes exercised the helper. 2.1910972960758954 seconds including
compilation; 558 frozen source pins unchanged and independently rechecked.
No new release executable was produced or installed.

The actual local Linux7.2.8 kernel supplied SO_PEERPIDFD and SCM_RIGHTS pidfds.
Tests verify both kernel references identify the exact connecting child, with
CLOEXEC and current liveness. A live unrelated process, regular FD, missing or
extra FD, duplicate/alias request keys, oversized packet, changed boot and reset
origin refuse at the expected stage; each negative sender completed its packet.
Requester death, socket close while requester remains alive, a second packet,
and expiry of the original interval close the session. The deadline test starts
with only350ms left in the original900s and passes in0.35s, not a new interval.
Failed authorization consumes the session; retry refuses. These tests use no
provider, mounted chain state, real credential or production app process.

Authenticated available91922MiB/pending718/installedfloor18432/unread0;
retained27648floor+640 allowance. Original120s suite/150s outer,512hard450RSS,
CPU1/noSwap. Actual peak118MiB/minhostavailable91870MiB. No floor/cap relaxation.
Unchanged signature/journal cases were not rerun; this is the newly added
broker ingress/lifetime qualification. Prior authority result remains separate.

Maintained ReceiveBrokerSession now accepts the monitor's actual packet;
AuthenticateAndReserve consumes it and invokes the owner/signature/sealed-clock
and persistent pair reservation path. The watcher is armed before return and
performs no authentication/journal/provider work; error cleanup joins it before
closing referenced pidfds. Connection cancellation and refusal are NOT an
independent OS kill guarantee, remote export fence, settlement or release.
There is still no writable-FD grant API, installed complete broker daemon,
accepted bootstrap listener, credential/provider composition, or production RPC.
Target kernel SO_PEERPIDFD capability is unqualified; unsupported kernels refuse
rather than using numeric PID matching. Current source is concrete required
broker ingress, not a finished storage service. Full goal stays active.

Full frozen sources remain local. Git stores changed frozen inputs and all pins,
commands, logs and results; other inputs independently matched base92b89b096b022dc900faa53865c0521f9b3e983c.
