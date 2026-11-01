# Host bootstrap sequence implemented; production RPC remains offline

Previous goal turn PROGRESS: authenticated guest-to-owner TLS integration. This
turn adds maintained rpc/host/bootstrap.mjs, a usable sequencer over already-held
monitor and TPM streams, rather than another owner/guest primitive trial. It does
not create native processes, keys, VMs, jobs or services. No provider/export/funds/
route/catalog mutation. Existing held node key signs host proof; no private export.
No Enclave-operated identity/registry/relay or default authority is consulted.

Enrollment validates the guest's exact loaded deployment/profile/volumes/runtime,
public request, certificate and SPKI, then obtains keys from the actual TPM line
protocol. The two original storage-owner keys authenticate the offered endpoint,
manifest, guest certificate, request/runtime and challenge before TPM activation.
The existing buildHvNodeFrame performs log/read/activate/quote/PCR/keys using the
held TPM stream. It refuses changed EK/AIK after enrollment. The guest monitor
produces its own bootstrap-purpose report; host checks unchanged identity and
forwards only host evidence plus public owner inputs, never a replacement guest
report or key. The monitor's owner-input acknowledgment must precede acquisition.
All acknowledgments explicitly deny root grant and readiness. The broker still
independently verifies CURRENT deployment authority and storage consent.

A caller-protected exclusive regular journal FD must be empty and single-linked;
phase intents fsync before command transmission. Unknown response consumes phase,
retains journal, closes both transports, and never sends the next command/retries.
Unshared line streams have bounded aggregate buffers, duplicate TPM field refusal,
exact monitor JSON and no late-response reuse. Per-command3s is clipped to the
ORIGINAL caller-supplied host monotonic window; original900 is never reset. Guest
and owner clocks are not compared to this host clock. Loss AbortSignal or original
expiry closes transports; synchronous filesystem/crypto and native worker death
STILL require the caller's independently armed original supervisor. A JS timer,
AbortSignal or held stream alone is NOT proof of that native boundary.

Actual invocation9d72a2473a6b40d8a50db46dd1d6c5ad terminal0/MainPID0/collected,
0.910278166s/787pins unchanged. SIX new behavior methods PASS plus syntax check:
(1) actual private-loopback streams and durable journal sequence, software TPM
activation/quote/signature and full owner verifier accept produced host+guest
report, once; (2) bad owner signature or signed wrong request refuses BEFORE
TPM activation; (3) TPM or guest identity substitution refuses BEFORE installation;
(4) lost install acknowledgment retains intent, no acquire/no retry; (5) blocked
TPM log command is refused at original400ms deadline (401.976274ms test duration);
(6) supplied supervisor loss refuses before guest attestation (46.528476ms test).
Synthetic TPM/VBS keys/reports and simulated monitor; actual socket/file operations,
existing TPM command builder and full owner verifier. This does NOT prove native
TPM execution, physical attestation, Hyper-V channel identity, Windows ACLs,
independent native death or complete owner/guest/export composition. No historical
successful test/helper/build/native attempt repeated; no full image rebuilt.

Fresh authoritative Warden available94587MiB/pending0 ACTUALLY observed, installed
18432/unread0. Retained27648+640 allowance; queue512hard/450RSS/CPU1/noSwap and
120suite/150outer/5stop unchanged. Actual peakRSS165MiB/min94571. Not Windows39388
prospective admission. Private namespace loopback and ephemeral keys/journals/data
excluded Git; unchanged public1739B bootstrap vector only. Frozen runtime/source
closure hashed before/after; unchanged files verified via actual git cat-file
against c3976bba. README corrected stale bridge.sock/three-command descriptions.

NEXT: bind THIS sequencer to the protected Windows original-attempt worker with
exact held VM/TPM channels, qualified clock adapter and protected journal; prepare
owner configuration from the enrollment and pass the original signed offer.
Then qualify independently supervised full composition and accepted actual target
hardware/image. No old launcher fallback or assumption that transport exit proves
native death. Original owner durable journal/current deployment commitments and
ALL previous writer settlement precede writable roots. Actual NBD/attachment/boot,
role filters/network/Base coverage/whole-stack fit/sync/finality/readiness,
persistent adoption/event-driven serving and consumer cutover remain unproven.
Full cold recovery/new-user/storage-failure/Enclave-refusal/independent hosting
not demonstrated. Goal active/unachieved; preview live, production RPC offline.
Original8091 preserved; Windows5a ambiguous/held/no replay/adopt/release.
