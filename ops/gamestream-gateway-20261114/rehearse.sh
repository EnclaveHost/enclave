#!/bin/bash
# Rehearsal of run.sh on this machine, touching no edge: the real bundle, the real installer and the real run.sh, with
# ssh and scp replaced by local stand-ins and the box's systemctl, ufw, ss, ip and journalctl by small ones that keep
# their state under a temporary staging root per box. It runs in a private user and mount namespace (root only there,
# an empty /root). Two boxes, siblings of each other: their gateways really listen on 127.0.0.5 and 127.0.0.6, so the
# checks "from outside" and the questions between the two are real connections.
#
#   bash rehearse.sh        activate, status, check, links, a question on the sibling port by hand, activate again
#                           (skipped), an update of one box over its running gateway, revert; then: nothing is left
#
# What it cannot show: systemd's sandboxing of the unit, real ufw (here the gateway itself turns a stranger away from
# the sibling port, on an edge ufw does before it), the named path and with it a client carried from one box to the
# other (nothing serves 443 on these addresses; test/wg-provider-gamestream-gateway.test.mjs does that with two
# gateways and a stand-in router), and anything about the edges themselves.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BOXES=(rehearsal-a rehearsal-b) ADDRS=(127.0.0.5 127.0.0.6)
if [ "${1:-}" != --inside ]; then exec unshare -rm bash "$HERE/rehearse.sh" --inside; fi
mount -t tmpfs none /root
W=$(mktemp -d "${TMPDIR:-/tmp}/enclave-gsgw-rehearsal.XXXXXX")
export REHEARSAL_BASE=$W/boxes REHEARSAL_SS; REHEARSAL_SS=$(command -v ss)
mkdir -p "$W/bin" "$W/remote" "$W/evidence"
for i in 0 1; do mkdir -p "$REHEARSAL_BASE/${BOXES[$i]}/.state"; echo "${ADDRS[$i]}" > "$REHEARSAL_BASE/${BOXES[$i]}/.state/addr"; done
cleanup() { for b in "${BOXES[@]}"; do if [ -f "$REHEARSAL_BASE/$b/.state/pid" ]; then kill "$(cat "$REHEARSAL_BASE/$b/.state/pid")" 2>/dev/null || true; fi; done; rm -rf "${W:?}"; }
trap cleanup EXIT

# ssh / scp: options are dropped and the alias picks the box; the command runs here, against that box's staging root
# and the box stand-ins
cat > "$W/bin/ssh" <<'EOF'
#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done
export REHEARSAL_ROOT=$REHEARSAL_BASE/$1 REHEARSAL_ADDR; REHEARSAL_ADDR=$(cat "$REHEARSAL_ROOT/.state/addr"); shift
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
  status) echo "Status: active"; echo
          while read -r a b _ d _ f; do
            if [ "$a" = from ]; then echo "$d $f/tcp           ALLOW       $b             # enclave gamestream gateway"
            else echo "$a                 ALLOW       Anywhere                   # enclave gamestream gateway"; fi
          done < $S/ufw ;;
  allow) if [ "$2" = from ]; then k="from $3 to $5 port $7"; else k=$2; fi
         echo "ufw allow $k" >> $S/calls; grep -qxF "$k" $S/ufw || echo "$k" >> $S/ufw ;;
  delete) if [ "$3" = from ]; then k="from $4 to $6 port $8"; else k=$3; fi
          echo "ufw delete allow $k" >> $S/calls; grep -vxF "$k" $S/ufw > $S/ufw.new || true; mv $S/ufw.new $S/ufw ;;
  *) echo "rehearsal ufw: unexpected: $*" >&2; exit 1 ;;
esac
EOF
# ss: the real one, narrowed to the box's address (other programs hold Sunshine's ports on 127.0.0.1 here)
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
node -e 'const fs=require("fs"),[from,to,...boxes]=process.argv.slice(1),p=JSON.parse(fs.readFileSync(from,"utf8"));p.edges=boxes.map(b=>{const [alias,address]=b.split("=");return {alias,address};});fs.writeFileSync(to,JSON.stringify(p))' "$HERE/plan.json" "$GSGW_PLAN" "${BOXES[0]}=${ADDRS[0]}" "${BOXES[1]}=${ADDRS[1]}"
APP=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).probeApp)' "$GSGW_PLAN")

step() { echo; echo "### run.sh $*"; bash "$HERE/run.sh" "$@"; }
fail() { echo "REHEARSAL FAILED: $*"; exit 1; }
step activate
step status
step check
step links

echo; echo "### the sibling port, asked by hand"
# this machine (127.0.0.1) names the app at box a: the request itself fails (nothing serves 443 here), the name is bound
curl -s -o /dev/null -m 5 --connect-to "$APP:47989:${ADDRS[0]}:47989" "http://$APP:47989/serverinfo" || true
# -> what <to> answers when <from> asks it about <client>
ask() {
  node -e 'const net=require("net"),[from,to,client]=process.argv.slice(1);let got="";const c=net.connect({host:to,port:47997,localAddress:from});
c.setTimeout(3000,()=>c.destroy());c.on("connect",()=>c.write("enclave-gs-binding/1 "+client+"\n"));c.on("data",d=>{got+=d;});c.on("error",()=>{});c.on("close",()=>process.stdout.write(got));' "$@"
}
heard=$(ask "${ADDRS[1]}" "${ADDRS[0]}" 127.0.0.1); echo "box b asks box a about 127.0.0.1: ${heard:-(nothing)}"
[[ $heard =~ ^"$APP"\ [0-9]+$ ]] || fail "box a did not tell its sibling the name this machine gave it"
heard=$(ask "${ADDRS[1]}" "${ADDRS[0]}" 127.0.0.9); echo "box b asks box a about 127.0.0.9: ${heard:-(nothing)}"
[ "$heard" = - ] || fail "box a did not say that it knows nothing of a client it never saw"
heard=$(ask 127.0.0.1 "${ADDRS[0]}" 127.0.0.1); echo "this machine asks box a about itself: ${heard:-(nothing)}"
[ -z "$heard" ] || fail "box a answered a machine that is no sibling"

step activate
echo; echo "### evidence"; ls "$GSGW_EVIDENCE"; sed 's/"verifiedAt": "[^"]*"/"verifiedAt": "(time)"/' "$GSGW_EVIDENCE/${BOXES[0]}.verified.json"
echo; echo "### an update: box a was verified with another bundle"
node -e 'const fs=require("fs"),f=process.argv[1],v=JSON.parse(fs.readFileSync(f,"utf8"));v.bundleSha256="0".repeat(64);fs.writeFileSync(f,JSON.stringify(v))' "$GSGW_EVIDENCE/${BOXES[0]}.verified.json"
step activate
grep -q '"bundleSha256": "'"$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).bundle.sha256)' "$GSGW_PLAN")"'"' "$GSGW_EVIDENCE/${BOXES[0]}.verified.json" || fail "box a was not verified again with the planned bundle"
step revert
echo; echo "### what is left"
left=$(ls /root; for i in 0 1; do (cd "$REHEARSAL_BASE/${BOXES[$i]}" && find . -path ./.state -prune -o -type f -print); cat "$REHEARSAL_BASE/${BOXES[$i]}/.state/ufw"; "$REHEARSAL_SS" -H -ltn | grep -F " ${ADDRS[$i]}:" || true; done)
[ -z "$left" ] || { echo "$left"; fail "the revert left something"; }
for b in "${BOXES[@]}"; do [ ! -f "$REHEARSAL_BASE/$b/.state/pid" ] || fail "the gateway of $b still runs"; done
echo "nothing: no file under either staging root, no staging directory in /root, no rule, no listener on ${ADDRS[*]}"
for b in "${BOXES[@]}"; do echo; echo "### what $b was asked to change, in order"; grep -v -e 'systemctl is-' -e 'systemctl show' "$REHEARSAL_BASE/$b/.state/calls"; done
echo; echo "REHEARSAL PASSED"
