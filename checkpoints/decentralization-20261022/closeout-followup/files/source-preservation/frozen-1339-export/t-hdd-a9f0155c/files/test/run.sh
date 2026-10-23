#!/bin/bash
# Integration test driver. Run it through work/claude-test-queue.py (1024 MiB lane).
# - Unprivileged: no sudo, no host module, device or mount change.
# - The host side runs in a user+mount namespace, so its bind/tmpfs mounts vanish with it. It shares the host network,
#   and every listener binds 127.0.0.1.
# - The guest is a throwaway KVM VM whose only network path is the guestfwd relay to those loopback ports.
# - Actual allocation of the run directory is capped at 512 MiB, and the test asserts this.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
RUN=$(cd "$REPO/.." && pwd)/run/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$RUN/out"
echo "run=$RUN"
rc=0
timeout -k 10 1500 unshare --user --map-root-user --mount -- python3 -u -I "$REPO/test/host_test.py" "$RUN" || rc=$?
echo "host_test rc=$rc"
# Harness safety net: a process whose argv names THIS run's unique directory and that runs as this user was started by
# this run. Any found here already counts as a failure in host_test (teardown-no-leftover-qemu-nbd).
for pid in $(pgrep -u "$(id -u)" -f "qemu-(nbd|system-x86_64).*$RUN" || true); do
  echo "safety-net: terminating leftover $pid: $(tr '\0' ' ' < /proc/$pid/cmdline | cut -c1-160)"; kill -TERM "$pid" || true
done
echo "leftover qemu-system: $(pgrep -fc 'enc-rpchdd-test' || true)  leftover qemu-nbd for this run: $(pgrep -fc "qemu-nbd.*$RUN" || true)"
du -s --block-size=1 "$RUN"
exit $rc
