# Actual inert broker launch review

Unit/build b8208802a2764418b83a8317f1c23a0a is terminal0/Main0/5.317171089s;
606pins unchanged, new source/refusal tests and actual broker/native+ordinary
monitor compiles PASS. Native test binary includes the same compiled launch code;
release broker is actual cmd/rpc-storage-broker, no command stub. Exact binary
pins copied independently and all frozen/current source verified before/after.
No rebuild/replay of completed unit. No targets/VM/exports/chain/funds touched.

This new independent unit512MiB/swap0/CPU1/tasks64/35sstop5 delegates only its own
subtree, controller subgroup before any work. Native test broker128MiB/swap0/CPU1/
tasks32 CLONE_INTO_CGROUP with atomic pidfd, no fallback. Unit controller verifies
all outer kernel limits and empty parent before enabling its own three controllers.
Read-only actual cgroup root, only this delegated parent RW, private user/PID/net/
mount/IPC/UTS namespaces. No cgroup namespace unshare: actual cgroup paths resolve
in broker. Compiler never inside native fixture. Two fresh private /run namespaces
and distinct random attempts: actual ready/guestkey/heldkill/exactdeath; original
500ms expiry/exactdeath. No writable root or owner service contacted. Hardware
report is explicitly mocked in the native fixture; key actually guest-generated.
Native test passes held real delegation because target guest cgroup root differs;
production always opens fixed guest root. Not target boot/PID1/whole-stack proof.

Fresh authenticated pending-aware27648floor+640 for entire outer512+128overhead.
Existing guard450RSS/noSwap/CPU1, runner20s/eachcase6/test4 clippedoriginalwindow.
No cap/floor/reset/automatic retry. First failure stops later cases and is preserved.
Private generated keys remain only private ephemeral tmpfs and never public output.
Group/intents remain consumed; systemd collects only this disposable unit on exit.
