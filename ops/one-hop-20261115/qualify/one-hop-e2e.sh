#!/bin/bash
# One hop on a real tunnel, in unprivileged network namespaces (the arrangement of test/netns/wg-e2e.sh):
#   guarded app A:  host --outer wg--> guard G --inner wg--> exit X <-- visitors
#   one-hop app B:  host --wg--> exit X <-- visitors          (owner signed guard:false)
# Usage, from the repository root:
#   unshare -r -n -- bash ops/one-hop-20261115/qualify/one-hop-e2e.sh <enclave-wg> <guard's provider> <exit's provider>
# A provider is "source" (main's network/wg-provider) or a provider bundle, installed or patched (prep-bundle.py).
# On a host without the kernel's WireGuard module: through qualify/userspace/wrap.sh.
# Prints "PASS <name>" / "FAIL <name>: ..." / "NOTE ..." and exits non-zero on any failure. What is expected of the
# exit follows from whether it counts direct peers (the one-hop code) or not (an installed build).
set -uo pipefail
WG_BIN=$1; GP=$2; XP=$3
D=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
FAILED=0
pass(){ echo "PASS $1"; }
fail(){ echo "FAIL $1: $2"; FAILED=1; }
note(){ echo "NOTE $1"; }
pids=()
cleanup(){ for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "${T:?}"; }
trap cleanup EXIT

mk(){ unshare -n sleep 3600 </dev/null >/dev/null 2>&1 & pids+=($!); printf -v "$1" %s $!; }
nsx(){ local p=$1; shift; nsenter -t "$p" -n -- "$@"; }
link(){ ip link add "$1" type veth peer name eth0 netns "$2"; ip addr add "$3/24" dev "$1"; ip link set "$1" up
  nsx "$2" ip addr add "$4/24" dev eth0; nsx "$2" ip link set eth0 up; nsx "$2" ip link set lo up; nsx "$2" ip route add default via "$3"; }
ip link set lo up
sysctl -q -w net.ipv4.ip_forward=1
mk G; mk X; mk H; mk W
sleep 0.2
link vG "$G" 46.0.0.1 46.0.0.2
link vX "$X" 47.0.0.1 47.0.0.2
link vH "$H" 45.0.0.1 45.0.0.2
link vW "$W" 44.0.0.254 44.0.0.1
cd "$D/../../.."   # repository root: node resolves viem from node_modules here

key(){ node -e 'import("viem/accounts").then(a=>console.log(a.generatePrivateKey()))'; }
addr(){ node -e 'import("viem/accounts").then(a=>console.log(a.privateKeyToAccount(process.argv[1]).address))' "$1"; }
RUNNER_KEY=$(key); OWNER_KEY=$(key); GKEY=$(key); XKEY=$(key)
export RUNNER_OPERATOR=$(addr "$RUNNER_KEY") OWNER=$(addr "$OWNER_KEY")
A=0x$(printf 'ab%.0s' $(seq 32)); B=0x$(printf 'cd%.0s' $(seq 32))
prov(){ # label, bundle|source -> the value of OH_PROVIDER
  [ "$2" = source ] && return 0
  python3 "$D/prep-bundle.py" "$2" "$T/$1-provider.mjs" && echo "$T/$1-provider.mjs"; }
GPM=$(prov g "$GP") || { fail setup "guard's provider: $GP"; exit 1; }
XPM=$(prov x "$XP") || { fail setup "exit's provider: $XP"; exit 1; }

nsx "$W" node test/netns/web-node.mjs 2>/dev/null & pids+=($!)
OH_PROVIDER=$GPM nsx "$G" node "$D/provider.mjs" 46.0.0.2 guard,ingress,egress "$T/g" "$T/g.json" "$GKEY" '[{"address":"47.0.0.2","ports":{"exit":51820,"control":51822}}]' '["47.0.0.2"]' 2>"$T/g.err" & pids+=($!)
OH_PROVIDER=$XPM nsx "$X" node "$D/provider.mjs" 47.0.0.2 guard,ingress,egress "$T/x" "$T/x.json" "$XKEY" '[{"address":"46.0.0.2","ports":{"exit":51820,"control":51822}}]' '["46.0.0.2"]' 2>"$T/x.err" & pids+=($!)
for f in g x; do for i in $(seq 75); do [ -s "$T/$f.json" ] && break; sleep 0.2; done; done
[ -s "$T/x.json" ] && [ -s "$T/g.json" ] && pass "providers started (WireGuard devices, nftables, SNI router, control)" || { fail providers "guard: $(tail -2 "$T/g.err" | cut -c1-300) exit: $(tail -2 "$T/x.err" | cut -c1-300)"; exit 1; }
peers(){ nsx "$H" curl -s -m 5 http://47.0.0.2:51822/v1/info | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).status.peers;console.log(p.guard+" "+p.exit+" "+(p.direct===undefined?"-":p.direct));}catch{console.log("? ? ?");}})'; }
read -r _ _ d0 <<<"$(peers)"
if [ "$d0" = - ]; then NEW=0; note "the exit does not count direct peers: an installed build, expected to behave as before"; else NEW=1; note "the exit counts direct peers: the one-hop code"; fi

# two enclaves, one per app: the key of each exists only in the host namespace
cert(){ openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$1" -keyout "$T/$2.key" -out "$T/$2.pem" -days 1 2>/dev/null; openssl x509 -in "$T/$2.pem" -noout -fingerprint -sha256 | cut -d= -f2; }
FPA=$(cert abababab.app.enclave.host a); FPB=$(cert cdcdcdcd.app.enclave.host b)
nsx "$H" node test/netns/tls-worker.mjs 9443 "$T/a.key" "$T/a.pem" 2>/dev/null & pids+=($!)
nsx "$H" node test/netns/tls-worker.mjs 9444 "$T/b.key" "$T/b.pem" 2>/dev/null & pids+=($!)
sleep 0.5
visit(){ nsx "$W" node test/netns/visitor-node.mjs 47.0.0.2 "$1"; }
field(){ node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])' "$1" "$2"; }

# 1. app A through the guard, with no policy on record (the default has a guard)
nsx "$H" node "$D/host.mjs" "$WG_BIN" "$A" "$T/g.json" 46.0.0.2 "$T/x.json" 47.0.0.2 "$RUNNER_KEY" 9443 - > "$T/a.json" 2>"$T/a.err" & pids+=($!)
for i in $(seq 100); do [ -s "$T/a.json" ] && break; sleep 0.2; done
[ -s "$T/a.json" ] || { fail guarded "$(tail -3 "$T/a.err" | cut -c1-300)"; exit 1; }
pass "guarded circuit up: the exit's grant asked through the guard"
sleep 1
out=$(visit abababab.app.enclave.host)
case "$out" in *"$FPA"*"enclave says: hello"*) pass "guarded: a visitor at the exit reaches app A's enclave";; *) fail guarded-ingress "$out";; esac
ep=$(nsx "$X" wg show wg-exit endpoints | awk '{print $2}' | sort -u | tr '\n' ' ')
case "$ep" in *45.0.0.2*) fail guarded-hop "the exit sees the host: $ep";; *46.0.0.2:*) pass "guarded: the exit's peer comes from the guard's address, the host's is not there";; *) fail guarded-hop "exit sees '$ep'";; esac
read -r _ e1 d1 <<<"$(peers)"
if [ $NEW = 1 ]; then [ "$d1" = 0 ] && [ "$e1" -ge 1 ] && pass "guarded: the exit counts $e1 exit peer(s), 0 direct" || fail guarded-count "exit $e1 direct $d1"; fi

# 2. the host asks the exit itself, for app B
r=$(nsx "$H" node "$D/ask.mjs" 47.0.0.2 "$RUNNER_KEY" "$B" -)
if [ $NEW = 1 ]; then case "$r" in *"requires a guard"*) pass "direct request with no policy on record: refused ($r)";; *) fail direct-default "$r";; esac
else note "direct request with no policy, installed build: $r"; fi
node "$D/policy.mjs" "$OWNER_KEY" "$B" true 1 "$T/guarded.json"
r=$(nsx "$H" node "$D/ask.mjs" 47.0.0.2 "$RUNNER_KEY" "$B" "$T/guarded.json")
if [ $NEW = 1 ]; then case "$r" in *"requires a guard"*) pass "direct request with the owner's guard:true: refused";; *) fail direct-guarded "$r";; esac
else note "direct request with guard:true, installed build: $r"; fi
node "$D/policy.mjs" "$RUNNER_KEY" "$B" false 2 "$T/forged.json"
r=$(nsx "$H" node "$D/ask.mjs" 47.0.0.2 "$RUNNER_KEY" "$B" "$T/forged.json")
case "$r" in refused*) pass "guard:false signed by someone who is not the owner: refused ($(echo "$r" | cut -c1-80))";; *) fail forged "$r";; esac
node "$D/policy.mjs" "$OWNER_KEY" "$B" false 2 "$T/b-policy.json"
if [ $NEW = 0 ]; then
  r=$(nsx "$H" node "$D/ask.mjs" 47.0.0.2 "$RUNNER_KEY" "$B" "$T/b-policy.json")
  case "$r" in refused*) pass "installed build: the owner's guard:false is refused whole ($(echo "$r" | cut -c1-80))";; *) fail old-validator "$r";; esac
  out=$(visit abababab.app.enclave.host)
  case "$out" in *"$FPA"*"enclave says: hello"*) pass "guarded app A still served";; *) fail guarded-after "$out";; esac
  exit $FAILED
fi

# 3. app B on one hop: the owner's guard:false, the host's runtime with no guard
nsx "$H" node "$D/host.mjs" "$WG_BIN" "$B" - - "$T/x.json" 47.0.0.2 "$RUNNER_KEY" 9444 "$T/b-policy.json" > "$T/b.json" 2>"$T/b.err" & BPID=$!; pids+=($BPID)
for i in $(seq 100); do [ -s "$T/b.json" ] && break; sleep 0.2; done
[ -s "$T/b.json" ] || { fail one-hop "$(tail -3 "$T/b.err" | cut -c1-300)"; exit 1; }
[ "$(field "$T/b.json" oneHop)" = true ] && pass "one-hop circuit up: one grant, asked of the exit at its listed control port, one tunnel" || fail one-hop-kind "$(cut -c1-200 "$T/b.json")"
sleep 1
out=$(visit cdcdcdcd.app.enclave.host)
case "$out" in *"$FPB"*"enclave says: hello"*) pass "one hop: a visitor at the exit reaches app B's enclave; TLS ends there";; *) fail one-hop-ingress "$out";; esac
r=$(nsx "$H" curl -s -m 10 --socks5-hostname "$(field "$T/b.json" egress)" http://web.test/)
[ "$r" = "remote=47.0.0.2" ] && pass "one hop: egress leaves from the exit's address, names through the tunnel" || fail one-hop-egress "got '$r'"
ep=$(nsx "$X" wg show wg-exit endpoints | awk '{print $2}' | sort -u | tr '\n' ' ')
case "$ep" in *45.0.0.2:*) pass "one hop: the exit sees the host's own address (what one hop gives up)";; *) fail one-hop-endpoint "exit sees '$ep'";; esac
read -r _ e2 d2 <<<"$(peers)"
[ "$d2" = 1 ] && pass "one hop: the exit counts 1 direct peer of $e2" || fail one-hop-count "exit $e2 direct $d2"
out=$(visit abababab.app.enclave.host)
case "$out" in *"$FPA"*"enclave says: hello"*) pass "guarded app A still served beside it, by its own enclave";; *) fail guarded-beside "$out";; esac
sleep 12   # renewals every 5 s here
out=$(visit cdcdcdcd.app.enclave.host)
case "$out" in *"$FPB"*"enclave says: hello"*) kill -0 $BPID 2>/dev/null && pass "one hop: still serving after renewals" || fail one-hop-renew "runtime gone: $(tail -2 "$T/b.err" | cut -c1-200)";; *) fail one-hop-renew "$out";; esac

# 4. the owner goes back to a guard: the direct peer ends at its next renewal
node "$D/policy.mjs" "$OWNER_KEY" "$B" true 3 "$T/b-policy.json"
for i in $(seq 60); do kill -0 $BPID 2>/dev/null || break; sleep 0.25; done
if kill -0 $BPID 2>/dev/null; then fail back-to-guard "the one-hop circuit is still up 15 s after the owner signed guard:true"
else case "$(cat "$T/b.err")" in *"requires a guard"*) pass "owner signs guard:true again: the renewal is refused and the one-hop circuit closes";; *) fail back-to-guard "$(tail -3 "$T/b.err" | cut -c1-300)";; esac; fi
out=$(visit abababab.app.enclave.host)
case "$out" in *"$FPA"*"enclave says: hello"*) pass "guarded app A still served";; *) fail guarded-after "$out";; esac
[ $FAILED = 0 ] || { echo "--- exit's log"; tail -8 "$T/x.err" | cut -c1-240; echo "--- one-hop host's log"; tail -8 "$T/b.err" | cut -c1-240; }
exit $FAILED
