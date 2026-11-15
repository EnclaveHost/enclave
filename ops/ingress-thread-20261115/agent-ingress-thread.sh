#!/bin/bash
# The NucBox's network agent with its ingress on a thread of its own (network/ingress-thread-host.mjs): what visitors
# exchange with the box's apps no longer waits whenever the agent's one thread computes (README.md has the measurement).
# Three files: the agent's bundle and the native-startup overlay with the change carried onto the installed files
# (agent-bundle.py), and the thread's file (scripts/network/build-ingress-thread.mjs). The NucBox side of every step is
# agent-ingress-thread.ps1.
#
#   agent-ingress-thread.sh status   read only: which files, the agent, the rounds' cadence
#   agent-ingress-thread.sh stage    copy the files to the NucBox and check them there; nothing running changes
#   agent-ingress-thread.sh swap     replace the files and restart the network agent: every circuit of every app on the
#                                    box is built again (the apps have no route for a minute or two); puts the previous
#                                    files back itself if the new agent does not come up
#   agent-ingress-thread.sh revert   the previous files back, the agent restarted
#
# While these files are installed, agent-policy-check.sh and one-hop-nucbox.sh's agent steps refuse (they do not know
# the bundle): revert here first. ENCLAVE_INGRESS_THREAD=0 in the agent's environment turns the thread off without a
# file change.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
WORK=${INGRESS_THREAD_WORK:-/home/steven/Documents/Codex/2026-10-23/it/work/ingress-thread-20261115}
SRC=$WORK/payload
WANT="privacy-agent.mjs:3b86e03e0d8664c11808a5bfcaf92330b625f7523ee1fe8f8164f329b206474b native-startup-overlay.mjs:62723ec4e99e09dbe0876a8ed75f08383c26b25c560eee798ece5a20a6094ddf ingress-thread.mjs:53420fcd61673be458193cfcc59bba6cb53f5470b00580f21ae88fac92a8ad87"
DEST='C:/ProgramData/Enclave/ingress-thread-20261115'
LOG=$WORK/agent-ingress-thread.log OUT=$(mktemp); trap 'rm -f "${OUT:?}"' EXIT
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 minipc)
say() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }
stop() { say "STOP: $*"; exit 1; }
quiet() { grep -av 'WARNING\|store now\|upgraded' || true; }
box() {
  { printf "\$mode='%s'\n" "$1"; cat "$here/agent-ingress-thread.ps1"; } |
    timeout "${BOX_TIMEOUT:-0}" "${SSH[@]}" 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"' 2>&1 |
    tr -d '\r' | quiet | tee "$OUT" | tee -a "$LOG" || true
}
did() { grep -q "^$1" "$OUT"; }
answers() { local a; for a in ef514ed3 7ae476a3 d9798e4c a77d0c57 a69dcbba 59f1273d 9a28642b; do say "  $a.app.enclave.host: $(curl -s -m 20 -o /dev/null -w '%{http_code} in %{time_total} s' "https://$a.app.enclave.host/" || true)"; done; }
mkdir -p "$WORK"
case "${1:-}" in
  status) BOX_TIMEOUT=120 box status ;;
  stage)
    for w in $WANT; do f=${w%%:*}; [ -f "$SRC/$f" ] && [ "$(sha256sum "$SRC/$f" | cut -d' ' -f1)" = "${w#*:}" ] || stop "$SRC/$f is not the prepared file; nothing copied"; done
    BOX_TIMEOUT=120 box verify; if did 'DONE staged'; then say "already staged; nothing running was changed"; exit 0; fi
    BOX_TIMEOUT=120 box prepare; did 'DONE prepare' || stop "the folder could not be made"
    for w in $WANT; do f=${w%%:*}; scp -q -o BatchMode=yes -o ConnectTimeout=15 "$SRC/$f" "minipc:$DEST/$f" 2>&1 | quiet | tee -a "$LOG"; done
    BOX_TIMEOUT=120 box verify; did 'DONE staged' || stop "the staged files did not verify on the NucBox; nothing running was changed"
    say "staged; nothing running was changed" ;;
  swap) BOX_TIMEOUT=1500 box swap; did 'DONE swap' || stop "the swap did not finish; see the lines above"; say "public answers:"; answers ;;
  revert) BOX_TIMEOUT=900 box revert; did 'DONE revert' || stop "the revert did not finish; see the lines above"; say "public answers:"; answers ;;
  *) sed -n 2,18p "$0"; exit 2 ;;
esac
