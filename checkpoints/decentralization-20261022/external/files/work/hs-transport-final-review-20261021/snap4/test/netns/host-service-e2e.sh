#!/bin/bash
# End-to-end test of HOST-SERVICE transport (work/host-service-transport-20261021) on real kernel WireGuard + nftables, in
# unprivileged network namespaces (modelled on wg-e2e.sh): host H --guard G--> exit X; visitors V --> X:80/443/53 --> H's own
# loopback roles. Usage (no root): unshare -r -n -- bash test/netns/host-service-e2e.sh <enclave-wg binary>
# Prints PASS/FAIL/SKIP lines; exits non-zero on any FAIL.
set -uo pipefail
WG_BIN=$1
D=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
FAILED=0
pass(){ echo "PASS $1"; }
fail(){ echo "FAIL $1: $2"; FAILED=1; }
pids=()
cleanup(){ for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT
mk(){ unshare -n sleep 3600 </dev/null >/dev/null 2>&1 & pids+=($!); printf -v "$1" %s $!; }
nsx(){ local p=$1; shift; nsenter -t "$p" -n -- "$@"; }
link(){ ip link add "$1" type veth peer name eth0 netns "$2"; ip addr add "$3/24" dev "$1"; ip link set "$1" up
  nsx "$2" ip addr add "$4/24" dev eth0; nsx "$2" ip link set eth0 up; nsx "$2" ip link set lo up; nsx "$2" ip route add default via "$3"; }
ip link set lo up
sysctl -q -w net.ipv4.ip_forward=1
mk G; mk X; mk H; mk V
sleep 0.2
link vG "$G" 46.0.0.1 46.0.0.2
link vX "$X" 47.0.0.1 47.0.0.2
link vH "$H" 45.0.0.1 45.0.0.2
link vV "$V" 49.0.0.1 49.0.0.2
cd "$D/../.."
key(){ node -e 'import("viem/accounts").then(a=>console.log(a.generatePrivateKey()))'; }
addr(){ node -e 'import("viem/accounts").then(a=>console.log(a.privateKeyToAccount(process.argv[1]).address))' "$1"; }
HOST_KEY=$(key); GKEY=$(key); XKEY=$(key)
HOST_OP=$(addr "$HOST_KEY"); HOST_ID=0x$(printf 'a1%.0s' $(seq 32)); OTHER_ID=0x$(printf 'b2%.0s' $(seq 32))
names(){ node -e 'import("./network/host-service-names.mjs").then(m=>console.log(JSON.stringify(m.hostServiceNames(process.argv[1],"svc.test"))))' "$1"; }
N=$(names "$HOST_ID"); O=$(names "$OTHER_ID")
DIR=$(node -e 'console.log(JSON.parse(process.argv[1])["directory-replica"])' "$N"); BOOT=$(node -e 'console.log(JSON.parse(process.argv[1])["bootstrap-replica"])' "$N")
POL=$(node -e 'console.log(JSON.parse(process.argv[1])["policy-mirror"])' "$N"); OTHER=$(node -e 'console.log(JSON.parse(process.argv[1])["directory-replica"])' "$O")
# DNS DNAT needs nft_nat, nft_limit and nft_connlimit in the running kernel (a user namespace cannot load modules)
DNS=0
# the provider's OWN DNS ruleset (kernel.mjs), checked by this kernel in X's namespace (nft -c: nothing is applied)
node -e 'import("./network/wg-provider/kernel.mjs").then(k=>process.stdout.write(k.ruleset({publicAddress:"47.0.0.2",dns:true})))' > "$T/dns.nft"
# control: the same check of the plain ruleset must pass, or the probe itself is broken (never a silent skip)
node -e 'import("./network/wg-provider/kernel.mjs").then(k=>process.stdout.write(k.ruleset({publicAddress:"47.0.0.2"})))' > "$T/plain.nft"
nsx "$X" nft -c -f "$T/plain.nft" 2>"$T/plainprobe.err" && pass "probe control: this kernel accepts the plain provider ruleset" || fail probe-control "$(head -c 200 "$T/plainprobe.err")"
if nsx "$X" nft -c -f "$T/dns.nft" 2>"$T/dnsprobe.err"; then DNS=1
else echo "SKIP dns: this kernel refuses the provider's DNS ruleset ($(grep -m2 -o 'Error: [^^]*' "$T/dnsprobe.err" | tr '\n' ' ' | head -c 200))"; fi
nsx "$G" node test/netns/hs-provider-node.mjs 46.0.0.2 guard,ingress,egress "$T/g" "$T/g.json" "$GKEY" '[{"address":"47.0.0.2","ports":{"exit":51820,"control":51822}}]' "$(printf 'a7%.0s' $(seq 16))" "$HOST_ID" "$HOST_OP" 0 "$T/ban" 2>"$T/g.err" & pids+=($!)
nsx "$X" node test/netns/hs-provider-node.mjs 47.0.0.2 guard,ingress,egress "$T/x" "$T/x.json" "$XKEY" '[{"address":"46.0.0.2","ports":{"exit":51820,"control":51822}}]' "$(printf 'e1%.0s' $(seq 16))" "$HOST_ID" "$HOST_OP" "$DNS" "$T/ban" 2>"$T/x.err" & pids+=($!)
for f in g x; do for i in $(seq 75); do [ -s "$T/$f.json" ] && break; sleep 0.2; done; done
[ -s "$T/x.json" ] && [ -s "$T/g.json" ] && pass "providers started (kernel wg + nftables$([ $DNS = 1 ] && echo ' + DNS DNAT'))" || { fail providers "$(cat "$T/g.err" "$T/x.err" | tail -5)"; exit 1; }
host_up(){ : > "$T/host.json"; nsx "$H" node test/netns/hs-host-node.mjs "$WG_BIN" "$T/g.json" "$T/x.json" "$HOST_KEY" "$HOST_ID" > "$T/host.json" 2>>"$T/host.err" & HOST_PID=$!; pids+=($HOST_PID)
  for i in $(seq 150); do [ -s "$T/host.json" ] && return 0; kill -0 $HOST_PID 2>/dev/null || return 1; sleep 0.2; done; return 1; }
info(){ nsx "$V" curl -s -m 5 http://47.0.0.2:51822/v1/info | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).status.peers.service)}catch{console.log("?")}})'; }
get(){ nsx "$V" curl -s -m 8 -H "Host: $1" "http://47.0.0.2$2"; echo " rc=$?"; }
host_up && pass "service circuit up: guard grant, service grant through the guard, exactly the derived names" || { fail host "$(tail -20 "$T/host.err")"; exit 1; }
r=$(get "$DIR" /v1/network/records); case "$r" in "directory-replica /v1/network/records host=$DIR rc=0") pass "HTTP by Host reaches the host's directory role, raw (no redirect, Host intact)";; *) fail dir "$r";; esac
r=$(get "$BOOT" /ipfs/bafkqaaa); case "$r" in "bootstrap-replica /ipfs/bafkqaaa host=$BOOT rc=0") pass "bootstrap role by its own name";; *) fail boot "$r";; esac
for n in "$POL:a granted name of a role this host does not run" "$OTHER:another host's derived name" "abababab.app.test:an app-shaped name" "unknown.example:an unknown name"; do
  r=$(get "${n%%:*}" /); case "$r" in *" rc=52"|*" rc=56"|" rc=52") pass "closed: ${n#*:}";; *) fail "closed ${n#*:}" "$r";; esac; done
r=$(nsx "$V" curl -sk -m 8 --resolve "$DIR:443:47.0.0.2" "https://$DIR/" 2>&1; echo " rc=$?"); case "$r" in *" rc=0") fail tls "TLS answered without a terminator: $r";; *) pass "443 closed for a role without a TLS port (no termination on the transport or the host worker)";; esac
[ "$(info)" = 1 ] && pass "the exit holds one service peer" || fail info "service peers $(info)"
sleep 7; r=$(get "$DIR" /after-renewal); case "$r" in "directory-replica /after-renewal"*" rc=0") pass "still routed after a grant renewal (names re-checked)";; *) fail renewal "$r";; esac
if [ $DNS = 1 ]; then
  r=$(nsx "$V" dig @47.0.0.2 +short +time=3 +tries=1 anything.app.test A); [ "$r" = 192.0.2.53 ] && pass "DNS over UDP 53 reaches the host's DNS role (packets, DNAT)" || fail dns-udp "'$r'"
  r=$(nsx "$V" dig @47.0.0.2 +tcp +short +time=3 +tries=1 anything.app.test A); [ "$r" = 192.0.2.53 ] && pass "DNS over TCP 53 reaches the host's DNS role" || fail dns-tcp "'$r'"
  ok=$(for i in $(seq 120); do nsx "$V" dig @47.0.0.2 +short +time=1 +tries=1 q$i.app.test A & done | grep -c 192.0.2.53; wait)
  [ "$ok" -lt 120 ] && [ "$ok" -ge 20 ] && pass "a burst of 120 queries from one source is rate-limited ($ok answered)" || fail dns-rate "$ok of 120 answered"
  r=$(nsx "$V" curl -s -m 4 http://47.0.0.2:53/ 2>&1; echo " rc=$?"); case "$r" in *" rc=0") fail dns-tcp-http "$r";; *) pass "TCP 53 carries no HTTP routing";; esac
fi
# revocation: the host withdraws its grant on stop; the name closes at once and the peer is gone
kill -TERM $HOST_PID; for i in $(seq 50); do kill -0 $HOST_PID 2>/dev/null || break; sleep 0.2; done
[ "$(info)" = 0 ] && pass "revoked: the host's signed revoke removed its service peer" || fail revoke "service peers $(info)"
r=$(get "$DIR" /); case "$r" in *" rc=52"|*" rc=56"|" rc=52") pass "a revoked host's name is closed";; *) fail revoked-name "$r";; esac
[ $DNS = 1 ] && { r=$(nsx "$V" dig @47.0.0.2 +short +time=2 +tries=1 x.app.test A); [ -z "$r" ] && pass "DNS 53 forwards to nobody once the host is gone" || fail dns-after "'$r'"; }
# the admin's ban (platform host policy): a sweep removes the peer within its interval
host_up && pass "host back up" || fail host2 "$(tail -5 "$T/host.err")"
touch "$T/ban"; sleep 5
[ "$(info)" = 0 ] && pass "banned by the platform host policy: the sweep removed the service peer" || fail ban "service peers $(info)"
r=$(get "$DIR" /); case "$r" in *" rc=52"|*" rc=56"|" rc=52") pass "a banned host's name is closed";; *) fail banned-name "$r";; esac
grep -q "platform host policy: banned" "$T/x.err" && pass "the provider logged the ban as the reason" || fail ban-log "$(tail -3 "$T/x.err")"
exit $FAILED
