# RPC storage authorization and persistent reservation qualification

Invocation `ab5408b26ed0407d9684f25ebe18d53d` is terminal, status 0, MainPID 0.
The frozen maintained source passed 128 test/subtest checks: 17 contract,
80 bootstrap (new authority plus affected owner-authorization regressions),
13 storage client/journal and 18 SDK package checks. One existing contract
`TestScanWXFailsOnAnUnreadableProcess` skipped in the private namespace; no full
role-tree W^X or seccomp qualification is inferred. RPC monitor build passed.
27.527327263960615 seconds, all 556 source pins unchanged. Independent hash:
`monitor-rpc`, 8326046 bytes,
`b51529d5cbe254109a7275885abaf56a8502121aa97f5b5cc5fdb4a2ccdf2bcf`.
Binary retained locally only, not installed, uploaded or executed in production.

Admission: authenticated available 91901 MiB, pending 718 MiB, installed floor
18432 MiB, unread units 0. Retained test floor 27648 MiB plus 640 MiB allowance.
Original 120-second suite /150-second outer limit, 512 MiB hard/450 MiB RSS,
CPU1/no swap. Actual peak tree RSS197 MiB; minimum host available91686 MiB.
No native chain processes, VM, provider operation, live exports or funds used.

Evidence covers real Ed25519 signing/verification using ephemeral generated
fixture keys; actual owner-package commitment verification against mocked
agreeing chain peers; independent keys for L1/Base; mutation of every signed
scope; revocation/expiry; duplicate/alias/unknown/missing fields; old package
compatibility; shared Go/SDK policy vectors. It also covers actual file create,
fsync, restrictive mode, retained read-only descriptor, exact readback and
reopen/replay refusal in disposable files; actual private ext4 pair reservation
and partial pair conflict, plus tmpfs/symlink refusal. No power-cut/reboot test,
real chain owner authorization or production volume ownership is proven.

Maintained BeginBrokerAttempt now combines sealed original boot/clock checks,
owner/storage consent and durable pair reservation before possible export
submission. The reservation namespace still must come from the real storage
owner and be shared by every writer. Signing epochs does not prove an actual
exclusive writer, armed watchdog, export fencing, clean databases or settlement.
The full broker daemon, independent export guard, credential provisioning and
accepted bootstrap are still absent/unqualified. No grant-send or native-start
API is added by this increment. Production RPC remains offline; full goal active.
The existing bootstrap chain-quorum and legacy lease assumptions remain; no
periodic on-chain renewal or replacement-protocol claim is introduced.

All source matches the frozen qualification. Full freeze remains local. Git
preserves changed frozen inputs, all pins, logs, commands and result, with other
inputs independently verified byte-for-byte against base bc01d89c7ff24d216107d9a7b2f5c997465a44bc.
