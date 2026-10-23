#!/bin/bash
# Composition integration test. Run it through work/claude-test-queue.py (1024 MiB lane).
# - Unprivileged host side: a user+mount namespace, with every listener on 127.0.0.1.
# - The guest is a throwaway KVM VM: host kernel package 7.2.11, systemd 262 as PID 1, and its only network path is the
#   guestfwd relay.
# - The run directory's actual allocation is capped at 512 MiB, and the PEAK is sampled while the guest runs.
set -euo pipefail
W=$(cd "$(dirname "$0")/.." && pwd)
RUN=$W/run/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$RUN/out"
echo "run=$RUN"
for r in t s p; do echo "$r $(git -C "$W/$r" rev-parse HEAD) dirty=$(git -C "$W/$r" status --porcelain | wc -l)"; done
rc=0
timeout -k 10 1800 unshare --user --map-root-user --mount -- python3 -u -I "$W/itest/host.py" "$RUN" || rc=$?
echo "host rc=$rc"
for pid in $(pgrep -u "$(id -u)" -f "qemu-(nbd|system-x86_64).*$RUN" || true); do
  echo "safety-net: terminating leftover $pid: $(tr '\0' ' ' < /proc/$pid/cmdline | cut -c1-160)"; kill -TERM "$pid" || true
done
echo "leftover qemu-system: $(pgrep -fc 'enc-hddcompose-test' || true)  leftover qemu-nbd: $(pgrep -fc "qemu-nbd.*$RUN" || true)"
exit $rc
