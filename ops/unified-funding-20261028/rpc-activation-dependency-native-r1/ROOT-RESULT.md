# Actual systemd dependency result

PASS: frozen notify/watchdog owner and two SIGTERM-resistant dummy attachment processes exited within 3.257073 seconds, proven through three preheld pidfds. Exact cgroups empty/removed. Owner Result=watchdog; dependents reached bounded stop escalation. A new late dependent did not execute; the consumed owner refused its dependency-triggered replay.

Host user-systemd mechanism only. Controller128MiB plus four possible32MiB actors reserves256MiB total; CPU1/noSwap, independent12s actor runtime. This does not qualify root guest context, actual128MiB attachment units/30s cleanup, kernel NBD, provider/storage writer fencing or RPC readiness. All exact units settled with MainPID0. Public receipts retain actual identities and commands.
