# Pool 128 Shield release deployed on metal0

Source commit `adcfe5e76a38e4cd66ed8bfd0371a3ebfea573c0` was pushed and deployed on
2026-09-27 America/Phoenix (2026-09-28 UTC). Active Shield release:
`9b088f90cfbe2284587b255e66cf5885d19209925ef638824a9ee0f61ec51347`.
The CPU-only app release remains unchanged.

## Change

27B uses a 128-pad pool, refill unit 32 and cost-priority refill scheduling.
The masking arithmetic, verification and GPU worker binaries are unchanged.
The 27B guest floor is now 61,440 MiB, including for an older bundle whose
policy requests less memory. The 0.5B floor stays 8,192 MiB. The manager pool
is 81,920 MiB with the existing 2,400% CPU budget. The physical host guard
still reserves 16,384 MiB; it was not bypassed.

The active guest manager is `guestd.adcfe5e7`, SHA-256
`5929c8880add96273366929e485fe2525670dbfd89ec863397a1b3f5decd14c5`.
Nan predictor, domain and certificate admission include the new release;
previous admissions are retained. Nan independently reproduced the local
prediction exactly. The release uses the qualified pool128 init and existing
production backend, not the development-only native SHM backend.

## Validation and performance boundary

Contract and guest-manager tests passed, including the raised physical
memory floor, refusal below that floor, and advertised model floor.
The same release passed repeated attested 0.5B inference before activation.
The previously qualified isolated 60 GiB runs completed ordinary and MTP
requests with identical output tokens; the longer MTP aggregate was
**21.34 tok/s**, with samples of **22.85 and 20.02 tok/s**. The **25.34 / 25.37
native** measurements are not production or isolated-guest throughput.
See [qualification](../shield-target25-2026-09-27/README.md).

After activation, the production manager accepted an old 51,200 MiB-policy
27B fixture and assigned 61,440 MiB. The guest booted, verified the model,
and passed fresh AMD attestation and TLS identity checks. Its benchmark
request did not complete (connection reset, with a proxy-unreachable log);
the production supervisor's orphan reconciler subsequently removed this
directly created, unregistered diagnostic guest. This attempt
is retained as a failure and supplies **no new 27B performance result**.
A shorter post-activation production smoke test completed **two attested
0.5B inference requests**, both HTTP 200, with identical expected tokens,
9.30 and 9.22 tok/s. That diagnostic guest was explicitly removed after
success. This confirms the active production pipeline serves masked
inference; it is not a 27B throughput measurement. Final inventory contains
only the five app guests, all running.

Do not leave manually created diagnostic guests in the production manager;
use the separate qualification manager for sustained benchmarks.

## Operational events

Initial production admission correctly refused the 60 GiB guest because
physical available memory minus existing guest headroom would cross the
16 GiB host floor. The control-only VM was reduced from 6 to 4 GiB and
restarted. Twelve inactive, day-old test fixture logs (about 1.5 GiB) were
moved from RAM-backed `/tmp` to disk with hash verification and original-path
symlinks. No test data was discarded. The memory guard then admitted the guest.

Both GPU worker processes remained unchanged (PIDs 3882218 and 3882221).
Four app guest processes survived the control restart unchanged. API-MCP
was initially refused adoption for temporary free-capacity reasons, was
reaped by the supervisor and automatically relaunched; its certificate was
then reissued. This was a brief real service interruption, not uninterrupted
preservation of all five guests. All five public app endpoints subsequently
passed fresh attestation and HTTP 200 checks, including API-MCP. The final
inventory comparison identifies its old and new guest IDs.

The adoption path's capacity check can reject an already running guest
while the control VM is recovering its leases; the orphan reconciler can
then remove it. This rollout did not change that supervisor logic. Future
control restarts should wait for all lease adoptions before reserving test
capacity. A code fix should distinguish adoption from a new allocation and
keep reaping gated while owned leases remain unresumed.

## Rollback and local artifacts

Private backups of the previous guest-manager drop-in and control config
are retained under the deployment work directory's `private-backup` (0700);
they are intentionally not committed. Nan's private environment backup is
`/root/enclave-pool128-backup-20260927/api-relay.env` on Nan. The prior guest
manager binary and `fef26ae1` Shield release remain installed and admitted.
Rollback must first remove any guest using the new release, then restore
the prior manager configuration. Never recreate or truncate the GPU rings.

The archived serial log normalizes ANSI escapes and CRLF; the raw copy
remains in the local work directory.

Local work: `/home/steven/enclave-bench/v100-shield-20260927/deploy-pool128`.
