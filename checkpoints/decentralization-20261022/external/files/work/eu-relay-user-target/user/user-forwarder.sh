#!/usr/bin/env bash
# user-forwarder.sh - the minipc FALLBACK listener (the operator user, on warden-host), a separate step AFTER the relay is
# active. It installs the rendered enclave-host-relay-eu-lan.service: the fixed forwarder (listen ONLY 192.168.8.249:8549,
# peer ONLY 192.168.8.238, target ONLY 127.0.0.1:8549, all in the released code). This workstream prepares it only.
#   bash user-forwarder.sh --check       READ-ONLY: the relay is active and answers as the moved payee; warden holds
#                                        192.168.8.249; nothing listens on 192.168.8.249:8549 or 0.0.0.0:8549/[::]:8549
#   bash user-forwarder.sh --activate    install (create-only), start; verify the ONLY non-loopback :8549 listener is
#                                        192.168.8.249:8549; then enable. Anything else: stopped, disabled, exit 1
#   bash user-forwarder.sh --remove      stop, disable, move the unit aside (no-clobber)
set -euo pipefail
. "$(dirname "$0")/user-common.sh"
MODE=${1:-}; case "$MODE" in --check|--activate|--remove) ;; *) echo "usage: user-forwarder.sh --check | --activate | --remove"; exit 2 ;; esac
need_user
listeners() { ss -Hltn "sport = :$PORT" 2>/dev/null | awk '{print $4}' | sort -u; }
if [ "$MODE" = --remove ]; then
  "${SYSTEMCTL[@]}" stop "$LAN_UNIT" >/dev/null 2>&1 || true; "${SYSTEMCTL[@]}" disable "$LAN_UNIT" >/dev/null 2>&1 || true
  if [ -f "$LAN_UNIT_PATH" ] && [ ! -L "$LAN_UNIT_PATH" ]; then mv --no-clobber -T "$LAN_UNIT_PATH" "$MIG/$LAN_UNIT.removed-$(date -u +%Y%m%dT%H%M%SZ)"; "${SYSTEMCTL[@]}" daemon-reload; fi
  [ "$(show ActiveState "$LAN_UNIT")" != active ] && ! listeners | grep -qv '^127\.0\.0\.1:' && say "REMOVED: $LAN_UNIT stopped and moved aside" || { echo "WARNING: the forwarder did not verifiably stop"; exit 1; }
  exit 0
fi
problems=()
[ -f "$MIG/activate-receipt.json" ] && [ "$(show ActiveState)" = active ] && answers_as_payee || problems+=("the relay is not active and answering as $PAYEE (user-activate.sh first)")
r=$(verify_release 2>&1 | tail -1); [[ "$r" == "release $(release_id) verified"* ]] || problems+=("release: $r")
rc=$(cat "$MIG/staging-receipt.json" 2>/dev/null || true)
owned_file "$MIG/$LAN_UNIT.staged" && [[ "$rc" == *"\"lanUnitStagedSha256\":\"$(sha "$MIG/$LAN_UNIT.staged")\""* ]] || problems+=("the rendered forwarder unit is not the staged one")
ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qx "$LAN_LISTEN" || problems+=("this host does not hold $LAN_LISTEN (the forwarder would not listen; fix the reviewed address first)")
[ ! -e "$LAN_UNIT_PATH" ] && [ ! -L "$LAN_UNIT_PATH" ] || problems+=("$LAN_UNIT_PATH exists (installed or masked)")
others=$(listeners | grep -v '^127\.0\.0\.1:' || true); [ -z "$others" ] || problems+=("something already listens on a non-loopback :$PORT ($others)")
if [ ${#problems[@]} -gt 0 ]; then for p in "${problems[@]}"; do echo "PRECONDITION FAILED: $p"; done; echo "NOTHING CHANGED"; exit 2; fi
if [ "$MODE" = --check ]; then echo "CHECK OK: the forwarder can be installed (read-only; nothing changed)"; exit 0; fi
off() { "${SYSTEMCTL[@]}" stop "$LAN_UNIT" >/dev/null 2>&1 || true; "${SYSTEMCTL[@]}" disable "$LAN_UNIT" >/dev/null 2>&1 || true; journal "forwarder FAILED: $1"; echo "FORWARDER NOT ACTIVE: $1 (stopped and disabled)"; exit 1; }
umask 077
cp "$MIG/$LAN_UNIT.staged" "$LAN_UNIT_PATH.activate-tmp" && chmod 0600 "$LAN_UNIT_PATH.activate-tmp" && mv --no-clobber -T "$LAN_UNIT_PATH.activate-tmp" "$LAN_UNIT_PATH" || off "the unit could not be installed"
"${SYSTEMCTL[@]}" daemon-reload && "${SYSTEMCTL[@]}" start "$LAN_UNIT" || off "systemctl --user start failed"
for i in $(seq 1 20); do listeners | grep -qx "$LAN_LISTEN:$PORT" && break; sleep 1; done
got=$(listeners | grep -v '^127\.0\.0\.1:' || true)
[ "$got" = "$LAN_LISTEN:$PORT" ] || off "the non-loopback :$PORT listeners are '$got', not exactly $LAN_LISTEN:$PORT"
"${SYSTEMCTL[@]}" enable "$LAN_UNIT" >/dev/null 2>&1 || off "systemctl --user enable failed"
journal "forwarder active on $LAN_LISTEN:$PORT"
say "FORWARDER ACTIVE: $LAN_LISTEN:$PORT -> 127.0.0.1:$PORT for 192.168.8.238 only (the code's fixed values)"
