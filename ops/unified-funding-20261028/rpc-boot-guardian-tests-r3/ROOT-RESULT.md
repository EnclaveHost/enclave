# Independent RPC PID1 boot supervisor integrated and qualified

Previous goal turn PROGRESS1618576b1. This turn changes the actual maintained
RPC dominit: original PID1 stays a C supervisor; a gated child performs mounts,
TPM/native preparation and execs the Go monitor. No full target boot/deployment.
The supervisor is armed before mounts and Go, with absolute timerfd at kernel
origin0+900. Exact child pidfd held; child installs PDEATHSIG and parent check
before its ready byte; parent checks timer/process before one release. Parent
caps only its own AS32MiB/core0, keeps no storage/network/credential callbacks,
and polls kernel timer/child identity. Deadline, child exit or invalid handshake
requests actual poweroff without blocking sync/console/write/wait. No restart,
retry, extension or persistent adoption. NonRPC/desktop topology unchanged.

Guest-process independence does not cover frozen kernel/poweroff failure or
host preparation. Host's independently owned earlier deadline remains required.
The32MiB AS cap is post-fork, NOT prior-allocation peak/whole physical envelope.
Admission must count guardian/worker bootstrap and all support overhead. Existing
20GiB whole-stack proposal is not measured/admitted. Shutdown does not establish
remote writer death, clean DB shutdown, owner fencing or reservation release.

## Actual qualification

R1 dfe7e02714ab43cb84251053b9ee042a terminal1/Main0,0.231761467s/586pins unchanged:
frozen bundle omitted existing rpc-boot-clock.h; refused BEFORE compilation or
native execution. Preserved full failure. R2 adds real existing boot-stage C
include closure, no runtime/cap/floor/window change or completed job replay.

R2 089e2097415440b587dbd9fc389af4f8 terminal0/Main0/collected,2.911170224s/588pins
unchanged. Actual RPC boot-stage builder and ordinary/desktop init branches all
compile -static -O2 -Wall -Wextra -Werror; new guardian fixture compiled. Canonical
profile is explicit synthetic fixture, not owner acceptance or installed media.
Seven actual isolated namespace scenarios PASS. Testfixture refuses initial user
namespace and requires namespacePID1; rootlessbwrap ownuser/PID namespace with
CAP_SYS_BOOT. No reboot mock: namespace POWER_OFF reports130, externalSIGKILL137,
invalid-beforegate72. Fallback _exit125 is not successful poweroff.

External controller obtained exact kernel pidfds before action. Blocked preparation
worker SIGSTOP:2actors all dead1.496440ms after original500ms deadline. Executed
worker retains sameprocessidentity through exec, then SIGSTOP, descendant stays
live until guardian:4handles all dead1.883068ms after original800ms deadline.
Early child exit:2handles dead156.202094ms from launch, before original5s.
External exact guardian kill:4handles all dead2.153801ms after signal, before5s.
Actual parent limits readbackAS33554432/core0 after childgate release; guardian
PID differs fromworker; W/E pid same. Future/overflow/expired originaltime refuses
before any worker receipt, exactexit72. All actors are disposable; no production
boot/VM/TPM/modulemount/chain/export/data/credentials/wallet/consumer mutation.

R2 actual RPCinit1034840B SHA103a37becc4769c97f83316fc76b6432592cd09810c92ec9f828b1bb9e637bbe;
rpc-boot1038240B SHA4458fc17a7a1f38af46bbf2a503ee8aa3e02a200d330c319f04bfce5750b5ee4;
fixture1021088B SHA3a94be7ec6c8e8771e24a8388c0ad8235380a07d41339af366ec22fe70af411b.
All artifacts independently rehashed. Local only, NOT rebuilt full image/new
accepted platform. Historical7e48candidate remains unchanged and predates source.

Post-pass root review tightened future test exit assertions to require130/137/72,
reject125. R2 already recorded those exact statuses. R3 2874b63b45df4d4ea8d84ae5ca3921d0
terminal0/Main0/collected,0.086467704s/588pins unchanged: ONLY new assertion tested
against7SHA-pinned actualR2 receipts plus4negative125 cases,11checksPASS. No new
native execution/build/reboot/successful qualification replay. Only test qualifier
changed afterR2; maintainedruntimeC unchanged. Frozen prior qualifier preserved.

Fresh authenticated admissions R194657/R294706/R394672MiB available;pending0
ACTUALLYreported, installed18432/unread0;retained27648+640.512hard450RSSCPU1noSwap
120suite/60compile/150outerstop5. R1peak69/min94643,R2peak124/min94690MiB;
R3too short tosampleRSS, notzeroallocation. Windowsprospective39388 unchanged and
not omitted for a Windows admission. Actualrootjobs terminal; never rerun.

## Remaining integration

The boot supervisor is implemented in actual dominit but its exact target VM
boot/poweroff/guest context remains unqualified. Accepted guest bootstrap still
must provision bounded broker fixedinputs and authenticate actual guest identity,
wait its exact listening signal, connect nonce-bound request to owner preparation
and framed relay, and deliver clientcredentials bound to owner/export authority.
Current broker still grants no roots. Real ownercommitment/namespace/previouswriter
settlement precede writable grants. Native NBD/verity/optical/TPM/network/rolefilters/
Basecoverage/fullfit/sync/finality/readiness/event-drivenauthorization/persistent
adoption/consumer deployment remain unproven. No hostJSONattestation/fakegrant/
guestlocalownerjournal/manualVM-as-app or Windows5a replay/adopt/release. Original
8091 preserved. Catalogpreview alreadyLIVE, no republish/sign/spend. Full goal,
including cold recovery/new user/storage failure/independent hosting under Enclave
refusal, remains active and unachieved. Publicsource/evidence only; binaries and
private data excluded; unchanged frozenfiles actuallygitcat-fileverified.
