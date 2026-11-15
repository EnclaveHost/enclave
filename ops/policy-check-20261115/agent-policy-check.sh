#!/bin/bash
# The NucBox's network agent with rememberVerified (network/owner-signature.mjs): a successful owner-signature check is
# kept for ten minutes, so the agent's refresh round no longer reads the chain five times for one signed policy
# (README.md has what that did on 2026-11-15). The bundle is the one-hop release's with that one change
# (agent-bundle.py); the NucBox side of every step is agent-policy-check.ps1.
#
#   agent-policy-check.sh status   read only: which bundle, the agent, the rounds' cadence, withdrawals
#   agent-policy-check.sh stage    copy the bundle to the NucBox and check it there; nothing running changes
#   agent-policy-check.sh swap     replace the bundle and restart the network agent: every circuit of every app on the
#                                  box is built again (the apps have no route for a minute or two); puts the previous
#                                  bundle back itself if the new agent does not come up
#   agent-policy-check.sh revert   the one-hop release's bundle back, the agent restarted
#
# While this bundle is installed, one-hop-nucbox.sh's agent, near-on, near-off and revert-agent refuse (they do not
# know the file): revert here first.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
WORK=${POLICY_CHECK_WORK:-/home/steven/Documents/Codex/2026-10-23/it/work/policy-check-20261115}
SRC=$WORK/payload/privacy-agent.mjs WANT=2961488:018082345a1058f0f9dd478b61a0b9ba2877dee5717761ae4b9f0f0bd31927b8
DEST='C:/ProgramData/Enclave/policy-check-20261115'
LOG=$WORK/agent-policy-check.log OUT=$(mktemp); trap 'rm -f "${OUT:?}"' EXIT
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 minipc)
say() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }
stop() { say "STOP: $*"; exit 1; }
quiet() { grep -av 'WARNING\|store now\|upgraded' || true; }
box() {
  { printf "\$mode='%s'\n" "$1"; cat "$here/agent-policy-check.ps1"; } |
    timeout "${BOX_TIMEOUT:-0}" "${SSH[@]}" 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"' 2>&1 |
    tr -d '\r' | quiet | tee "$OUT" | tee -a "$LOG" || true
}
did() { grep -q "^$1" "$OUT"; }
answers() { local a; for a in ef514ed3 7ae476a3 d9798e4c a77d0c57 a69dcbba 59f1273d 9a28642b; do say "  $a.app.enclave.host: $(curl -s -m 20 -o /dev/null -w '%{http_code} in %{time_total} s' "https://$a.app.enclave.host/" || true)"; done; }
mkdir -p "$WORK"
case "${1:-}" in
  status) BOX_TIMEOUT=120 box status ;;
  stage)
    [ -f "$SRC" ] && [ "$(stat -c %s "$SRC"):$(sha256sum "$SRC" | cut -d' ' -f1)" = "$WANT" ] || stop "$SRC is not the prepared file; nothing copied"
    BOX_TIMEOUT=120 box verify; if did 'DONE staged'; then say "already staged; nothing running was changed"; exit 0; fi
    BOX_TIMEOUT=120 box prepare; did 'DONE prepare' || stop "the folder could not be made"
    scp -q -o BatchMode=yes -o ConnectTimeout=15 "$SRC" "minipc:$DEST/privacy-agent.mjs" 2>&1 | quiet | tee -a "$LOG"
    BOX_TIMEOUT=120 box verify; did 'DONE staged' || stop "the staged file did not verify on the NucBox; nothing running was changed"
    say "staged; nothing running was changed" ;;
  swap) BOX_TIMEOUT=1500 box swap; did 'DONE swap' || stop "the swap did not finish; see the lines above"; say "public answers:"; answers ;;
  revert) BOX_TIMEOUT=900 box revert; did 'DONE revert' || stop "the revert did not finish; see the lines above"; say "public answers:"; answers ;;
  *) sed -n 2,16p "$0"; exit 2 ;;
esac
