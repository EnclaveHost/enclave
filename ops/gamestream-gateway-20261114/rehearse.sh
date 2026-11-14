#!/bin/bash
# Rehearsal of run.sh on this machine, touching no edge: the real bundle, the real installer and the real run.sh, with
# ssh and scp replaced by local stand-ins and the box's systemctl, ufw, ss, ip and journalctl by small ones that keep
# their state under a temporary staging root. It runs in a private user and mount namespace (root only there, an empty
# /root), and the gateway really listens on 127.0.0.5, so the checks "from outside" are real connections.
#
#   bash rehearse.sh        activate, status, check, activate again (skipped), revert; then: nothing is left
#
# What it cannot show: systemd's sandboxing of the unit, real ufw, the named path (nothing serves 443 on 127.0.0.5),
# and anything about the edges themselves.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ADDR=127.0.0.5
if [ "${1:-}" != --inside ]; then exec unshare -rm bash "$HERE/rehearse.sh" --inside; fi
mount -t tmpfs none /root
W=$(mktemp -d "${TMPDIR:-/tmp}/enclave-gsgw-rehearsal.XXXXXX")
export REHEARSAL_ROOT=$W/box REHEARSAL_ADDR=$ADDR REHEARSAL_SS; REHEARSAL_SS=$(command -v ss)
mkdir -p "$W/bin" "$W/remote" "$REHEARSAL_ROOT/.state" "$W/evidence"
cleanup() { if [ -f "$REHEARSAL_ROOT/.state/pid" ]; then kill "$(cat "$REHEARSAL_ROOT/.state/pid")" 2>/dev/null || true; fi; rm -rf "${W:?}"; }
trap cleanup EXIT

# ssh / scp: options and the alias are dropped; the command runs here, against the staging root and the box stand-ins
cat > "$W/bin/ssh" <<'EOF'
#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
ENCLAVE_NETWORK_ROOT=$REHEARSAL_ROOT PATH=$REHEARSAL_REMOTE:$PATH exec bash -c "$*"
EOF
cat > "$W/bin/scp" <<'EOF'
#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done
args=("$@"); dest=${args[-1]#*:}; unset 'args[-1]'; exec cp -- "${args[@]}" "$dest"
EOF
# systemctl: the provider is "active" with a fixed pid; the gateway is a real process started from the unit's ExecStart
cat > "$W/remote/systemctl" <<'EOF'
#!/bin/bash
S=$REHEARSAL_ROOT/.state; G=enclave-gamestream-gateway; words=(); quiet=
while [ $# -gt 0 ]; do case "$1" in -p) shift 2 ;; -q) quiet=1; shift ;; -*) shift ;; *) words+=("$1"); shift ;; esac; done
verb=${words[0]:-} unit=${words[1]:-}
alive() { [ -f $S/pid ] && kill -0 "$(cat $S/pid)" 2>/dev/null; }
stop() { if alive; then kill "$(cat $S/pid)"; while alive; do sleep 0.1; done; fi; rm -f $S/pid; }
echo "systemctl $verb $unit" >> $S/calls
case "$verb/$unit" in
  is-active/enclave-network-provider) echo active ;;
  show/enclave-network-provider) echo "MainPID=4242"; echo "ActiveEnterTimestamp=Fri 2026-11-13 00:00:00 UTC" ;;
  is-active/$G) if alive; then [ -n "$quiet" ] || echo active; else [ -n "$quiet" ] || echo inactive; exit 3; fi ;;
  is-enabled/$G) if [ -f $S/enabled ]; then echo enabled; else echo not-found; exit 4; fi ;;
  show/$G) echo "MemoryCurrent=$(( $(awk '/VmRSS/{print $2}' /proc/"$(cat $S/pid)"/status) * 1024 ))" ;;
  daemon-reload/) ;;
  enable/$G) touch $S/enabled ;;
  restart/$G) stop; cmd=$(sed -n 's/^ExecStart=//p' $REHEARSAL_ROOT/etc/systemd/system/$G.service)
              setsid $cmd >> $S/journal 2>&1 < /dev/null & echo $! > $S/pid ;;
  disable/$G) stop; rm -f $S/enabled ;;
  *) echo "rehearsal systemctl: unexpected: $verb $unit" >&2; exit 1 ;;
esac
EOF
cat > "$W/remote/ufw" <<'EOF'
#!/bin/bash
S=$REHEARSAL_ROOT/.state; touch $S/ufw
case "$1" in
  status) echo "Status: active"; echo; sed 's/$/                 ALLOW       Anywhere                   # enclave gamestream gateway/' $S/ufw ;;
  allow) echo "ufw allow $2" >> $S/calls; grep -qxF "$2" $S/ufw || echo "$2" >> $S/ufw ;;
  delete) echo "ufw delete allow $3" >> $S/calls; grep -vxF "$3" $S/ufw > $S/ufw.new || true; mv $S/ufw.new $S/ufw ;;
  *) echo "rehearsal ufw: unexpected: $*" >&2; exit 1 ;;
esac
EOF
# ss: the real one, narrowed to the rehearsal address (other programs hold Sunshine's ports on 127.0.0.1 here)
cat > "$W/remote/ss" <<'EOF'
#!/bin/bash
"$REHEARSAL_SS" "$@" | { grep -F " $REHEARSAL_ADDR:" || true; }
EOF
cat > "$W/remote/ip" <<'EOF'
#!/bin/bash
echo "1: lo    inet $REHEARSAL_ADDR/8 scope host lo"
EOF
cat > "$W/remote/journalctl" <<'EOF'
#!/bin/bash
tail -n 20 "$REHEARSAL_ROOT/.state/journal" 2>/dev/null || true
EOF
chmod +x "$W"/bin/* "$W"/remote/*
export REHEARSAL_REMOTE=$W/remote PATH=$W/bin:$PATH
export GSGW_PLAN=$W/plan.json GSGW_EVIDENCE=$W/evidence
node -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));p.edges=[{alias:"rehearsal",address:process.argv[3]}];fs.writeFileSync(process.argv[2],JSON.stringify(p))' "$HERE/plan.json" "$GSGW_PLAN" "$ADDR"

step() { echo; echo "### run.sh $*"; bash "$HERE/run.sh" "$@"; }
step activate
step status
step check
step activate
echo; echo "### evidence"; ls "$GSGW_EVIDENCE"; sed 's/"verifiedAt": "[^"]*"/"verifiedAt": "(time)"/' "$GSGW_EVIDENCE/rehearsal.verified.json"
step revert
echo; echo "### what is left"
left=$(cd "$REHEARSAL_ROOT" && find . -path ./.state -prune -o -type f -print; ls /root; cat "$REHEARSAL_ROOT/.state/ufw"; "$REHEARSAL_SS" -H -ltn | grep -F " $ADDR:" || true)
[ -z "$left" ] || { echo "$left"; echo "REHEARSAL FAILED: the revert left something"; exit 1; }
[ ! -f "$REHEARSAL_ROOT/.state/pid" ] || { echo "REHEARSAL FAILED: the gateway still runs"; exit 1; }
echo "nothing: no file under the staging root, no staging directory in /root, no rule, no listener on $ADDR"
echo; echo "### what the box was asked to change, in order"; grep -v -e 'systemctl is-' -e 'systemctl show' "$REHEARSAL_ROOT/.state/calls"
echo; echo "REHEARSAL PASSED"
