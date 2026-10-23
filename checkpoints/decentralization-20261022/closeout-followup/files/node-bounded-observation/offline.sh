#!/usr/bin/env bash
# offline.sh <command...>: a fresh user+network namespace (no route off the host; loopback only), the denial stubs first in
# PATH, TMPDIR on disk. Proves the stub selection and the missing network before running the command.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec unshare -r -n bash -c '
  set -euo pipefail
  ip link set lo up
  export PATH="'"$here"'/stub:$PATH" TMPDIR="'"$here"'/tmp"
  [ "$(command -v ssh)" = "'"$here"'/stub/ssh" ] || { echo "offline: ssh stub not selected" >&2; exit 97; }
  if ip -4 route show default | grep -q .; then echo "offline: a default route exists" >&2; exit 97; fi
  echo "[offline] netns=$(readlink /proc/self/ns/net) ssh=$(command -v ssh) routes=$(ip -4 route show | wc -l)"
  exec "$@"' offline "$@"
