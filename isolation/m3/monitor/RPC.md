# Distinct native RPC monitor integration

The `native_rpc` monitor build now routes `load` through the actual V9 parser,
`rpcstorage.Acquire`, `rpcdomain.Prepare`, `ComposeCommand` and the monitor's
existing register-before-Start/Wait/TLS relay path. It is mutually exclusive
with `native_desktop`. Ordinary and desktop parsing remain distinct. This is
source integration; no new monitor or platform has been installed or admitted.

The RPC dominit retains PID1 as an independent C supervisor and launches the
monitor as its gated child. The supervisor's absolute kernel timer covers the
child's mount/TPM/native preparation and monitor execution; its exact pidfd stays
valid through exec. Child exit or original deadline requests guest poweroff.
There is no restart, renewal or persistent-serving adoption. This source still
requires actual target boot qualification and the external host watchdog.

The dedicated T0-hv bootstrap supplies a sealed ERPCONE4 original interval on
FD3 before monitor initialization. Missing, unsealed, wrong-boot, shifted-time,
expired or incompatible clocks refuse. The monitor never replaces the origin
with the time a load request arrives. The outer bootstrap/host guardian must
also cover earlier preparation on its own clock: this same-boot frame alone
does not prove a cross-boot or host-wide 900-second startup deadline.

Requests cannot supply commands, storage paths, names, probes or different
CPU/memory limits. A validated request permanently consumes the single monitor
attempt, including broker refusal or ambiguous response. Before any cgroup/root
preparation, the fixed measured storage broker must acknowledge the exact
request with owner-bound writable volume capabilities and its independently
armed original-deadline/owner-death supervision. See `../rpcstorage/README.md`:
the control broker now implements owner authorization and proof verification,
but writable-root attachment, writer settlement and independent watchdog
integration remain incomplete. The local peer check and response do not prove these properties.
No substitute broker or forged response is an admissible production workaround.

After composition, the actual parent cgroup kill control stays held. The front
is registered under UID1053577 before its first instruction and relayed through
its own private Unix socket. Other roles cannot obtain app-bound reports by
stating a different AppID. Grant loss is checked immediately before clone and
watched until the original deadline. Independent broker supervision is required
for a blocked preparation, clone, read or kill; the monitor's goroutine does not
replace it. The entry's owner/deadline watcher and front owner-approval gate
remain ahead of chain work.

RPC shutdown bypasses legacy `MNT_DETACH`, directory deletion and timed reclaim.
It requests exact parent cgroup termination once and retains all mounts, COWs,
capabilities and the consumed attempt. Lifecycle remains Ending, not Ended, while
writer settlement is unknown. Stop/destroy explicitly report that uncertainty;
local routing withdrawal is not ledger Offline, clean DB shutdown or reservation
release. A successful load denotes a process launch, not RPCReady, adoption,
ledger Running or a production-serving result.

Reports now scan all held RPC role groups, not just their empty parent. The
scanner requires the fixed tree, exact directory identities, all essential roles,
expected UIDs, readable W^X maps, active runtime seccomp filters, held live pidfds
and unchanged process sets before/after scanning. Unknown, vanished, unfiltered
or partial populations refuse. The current native process graph has not yet
installed a qualified syscall filter; the scanner must refuse such a graph.
Positive live role-tree/seccomp attestation remains unqualified.

The complete serving storage broker, accepted bootstrap/profile2,
network and DNS provisioning, role filters, Base coverage input, full attestation,
readiness-to-persistent-serving adoption and real Enclave app deployment remain
necessary. This build is not a production default or a manual VM replacement.
