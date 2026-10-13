#!/bin/bash
# End-to-end test of the Enclave network on real kernel WireGuard + nftables, in unprivileged network namespaces:
#   host --outer wg--> guard --inner wg (inside outer)--> exit --> "internet"; visitors --> exit:443 --> host's enclave.
# Usage (no root needed): unshare -r -n -- bash test/netns/wg-e2e.sh <enclave-wg binary>
# Prints "PASS <name>" / "FAIL <name>: ..." and exits non-zero on any failure.
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
link(){ # veth name, ns pid, router ip, ns ip
  ip link add "$1" type veth peer name eth0 netns "$2"
  ip addr add "$3/24" dev "$1"; ip link set "$1" up
  nsx "$2" ip addr add "$4/24" dev eth0; nsx "$2" ip link set eth0 up; nsx "$2" ip link set lo up; nsx "$2" ip route add default via "$3"
}
ip link set lo up
sysctl -q -w net.ipv4.ip_forward=1
mk G; mk X; mk H; mk W; mk C; mk V
sleep 0.2
link vG "$G" 46.0.0.1 46.0.0.2
link vX "$X" 47.0.0.1 47.0.0.2
link vH "$H" 45.0.0.1 45.0.0.2
link vW "$W" 44.0.0.254 44.0.0.1
link vC "$C" 48.0.0.1 48.0.0.2
link vV "$V" 49.0.0.1 49.0.0.2
# a private address that is really reachable: only the exit's rules may stop it
nsx "$W" ip addr add 10.9.9.9/32 dev eth0; ip route add 10.9.9.9/32 via 44.0.0.1

key(){ node -e 'import("viem/accounts").then(a=>console.log(a.generatePrivateKey()))'; }
addr(){ node -e 'import("viem/accounts").then(a=>console.log(a.privateKeyToAccount(process.argv[1]).address))' "$1"; }
RUNNER_KEY=$(key); CHECKER_KEY=$(key); GKEY=$(key); XKEY=$(key)
export RUNNER_OPERATOR=$(addr "$RUNNER_KEY")
CHECKER=$(addr "$CHECKER_KEY")
cd "$D/../.."   # repo root: node resolves viem from node_modules here

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=test-ca -keyout "$T/ca.key" -out "$T/ca.pem" -days 1 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=web.test -keyout "$T/web.key" -out "$T/web.csr" 2>/dev/null
printf 'subjectAltName=DNS:web.test\n' > "$T/san.ext"
openssl x509 -req -in "$T/web.csr" -CA "$T/ca.pem" -CAkey "$T/ca.key" -CAcreateserial -out "$T/web.pem" -days 1 -extfile "$T/san.ext" 2>/dev/null
nsx "$W" node test/netns/web-node.mjs "$T/web.key" "$T/web.pem" & pids+=($!)
nsx "$G" node test/netns/provider-node.mjs 46.0.0.2 guard,ingress,egress "$T/g" "$T/g.json" "$GKEY" '[{"address":"47.0.0.2","ports":{"exit":51820,"control":51822}}]' "$CHECKER" & pids+=($!)
nsx "$X" node test/netns/provider-node.mjs 47.0.0.2 guard,ingress,egress "$T/x" "$T/x.json" "$XKEY" '[{"address":"46.0.0.2","ports":{"exit":51820,"control":51822}}]' "$CHECKER" & pids+=($!)
for f in g x; do for i in $(seq 50); do [ -s "$T/$f.json" ] && break; sleep 0.2; done; done
[ -s "$T/x.json" ] && [ -s "$T/g.json" ] && pass "providers started (kernel wg + nftables)" || { fail providers "did not start"; exit 1; }

# the "enclave": a TLS server whose key exists only in the host namespace
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=abababab.app.enclave.host -keyout "$T/k.pem" -out "$T/c.pem" -days 1 2>/dev/null
FP=$(openssl x509 -in "$T/c.pem" -noout -fingerprint -sha256 | cut -d= -f2)
nsx "$H" node test/netns/tls-worker.mjs 9443 "$T/k.pem" "$T/c.pem" & pids+=($!)
sleep 0.5
nsx "$H" node test/netns/host-node.mjs "$WG_BIN" 46.0.0.2 47.0.0.2 "$RUNNER_KEY" 9443 > "$T/circuit.json" 2>"$T/host.err" & pids+=($!)
for i in $(seq 100); do [ -s "$T/circuit.json" ] && break; sleep 0.2; done
[ -s "$T/circuit.json" ] || { fail circuit "$(cat "$T/host.err")"; exit 1; }
pass "circuit up: guard grant, exit grant through the guard, inner tunnel"
EGRESS=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).egress)' "$T/circuit.json")

r=$(nsx "$H" curl -s -m 10 --socks5 "$EGRESS" http://44.0.0.1/)
[ "$r" = "remote=47.0.0.2" ] && pass "egress reaches the internet from the exit's address" || fail egress "got '$r'"
r=$(nsx "$H" curl -s -m 10 --socks5-hostname "$EGRESS" http://web.test/)
[ "$r" = "remote=47.0.0.2" ] && pass "names resolve through the tunnel" || fail dns "got '$r'"
ep=$(nsx "$X" wg show wg-exit endpoints | awk '{print $2}')
case "$ep" in 46.0.0.2:*) pass "the exit sees the guard ($ep), never the host";; *) fail guard-hop "exit sees '$ep'";; esac
nsx "$H" curl -s -m 5 --socks5 "$EGRESS" http://10.9.9.9/ >/dev/null && fail client-policy "private destination reached" || pass "host refuses a private destination"

out=$(nsx "$W" node test/netns/visitor-node.mjs 47.0.0.2 abababab.app.enclave.host)
case "$out" in *"$FP"*"enclave says: hello"*) pass "public HTTPS reaches the enclave; TLS ends there (same certificate)";; *) fail ingress "$out";; esac
out=$(nsx "$W" node test/netns/visitor-node.mjs 47.0.0.2 www.example.org)
case "$out" in *"$FP"*) pass "custom domain routes to the same enclave";; *) fail custom-domain "$out";; esac
GS=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).guardSocks)' "$T/circuit.json")
r=$(nsx "$H" curl -s -m 10 -k --http0.9 --socks5 "$GS" --resolve abababab.app.enclave.host:443:47.0.0.2 https://abababab.app.enclave.host/ 2>&1)
case "$r" in *"enclave says: GET /"*) pass "route probe through the guard: TLS to the enclave via the public address";; *) fail route-probe "$r";; esac
r=$(nsx "$H" curl -s -m 5 --socks5 "$GS" http://44.0.0.1/ 2>&1; echo " $?")
case "$r" in *" 97"|*" 7") pass "guard SOCKS refuses anything but the exit's public ports";; *) fail guard-socks "$r";; esac
out=$(nsx "$W" node test/netns/visitor-node.mjs 47.0.0.2 unknown.example)
case "$out" in CLOSED|ERROR*) pass "unknown SNI is refused (no open proxy)";; *) fail unknown-sni "$out";; esac

# provider-side enforcement, seen by a raw kernel WireGuard client holding a checker probe peer (no host policy)
nsx "$C" node test/netns/probe-node.mjs http://47.0.0.2:51822 probe "$CHECKER_KEY" > "$T/probe.json" 2>"$T/probe.err" || fail probe-grant "$(cat "$T/probe.err")"
wgup(){ # ns, grant file, iface
  local priv peer ep addr
  priv=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).priv)' "$2")
  peer=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).grant.providerPublicKey)' "$2")
  ep=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).grant.endpoint)' "$2")
  addr=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).grant.clientAddress)' "$2")
  echo "$priv" > "$T/$3.key"
  nsx "$1" ip link add "$3" type wireguard
  nsx "$1" wg set "$3" private-key "$T/$3.key" fwmark 51820 peer "$peer" endpoint "$ep" allowed-ips 0.0.0.0/0 persistent-keepalive 1
  nsx "$1" ip addr add "$addr/32" dev "$3"; nsx "$1" ip link set "$3" mtu 1340 up
  nsx "$1" ip route add default dev "$3" table 100; nsx "$1" ip rule add not fwmark 51820 table 100
}
wgup "$C" "$T/probe.json" wgc
sleep 1
r=$(nsx "$C" curl -s -m 10 http://44.0.0.1/)
[ "$r" = "remote=47.0.0.2" ] && pass "probe peer: outbound through the real tunnel" || fail probe-egress "got '$r'"
refused(){ # ns, url, name: must be refused quickly (RST/ICMP), never time out
  local s=$(date +%s%N) code; nsx "$1" curl -s -m 8 -o /dev/null "$2"; code=$?
  local ms=$(( ($(date +%s%N)-s)/1000000 ))
  if [ $code -eq 7 ] && [ $ms -lt 3000 ]; then pass "$3 refused in ${ms} ms"; else fail "$3" "curl exit $code after ${ms} ms"; fi
}
refused "$C" http://10.9.9.9/ "exit: private destination"
refused "$C" http://47.0.0.2:80/ "exit: its own public address"
refused "$C" telnet://44.0.0.1:25 "exit: SMTP"
refused "$C" http://10.77.0.1:51822/ "exit: its own tunnel address"
refused "$C" http://169.254.169.254/ "exit: cloud metadata"
nsx "$C" ip rule del not fwmark 51820 table 100; nsx "$C" ip link del wgc

# the guard forwards only to providers: a raw guard peer (runner-signed) may reach the exit's control port, nothing else
nsx "$C" node test/netns/probe-node.mjs http://46.0.0.2:51822 guard "$RUNNER_KEY" > "$T/guard.json" 2>"$T/guard.err" || fail guard-grant "$(cat "$T/guard.err")"
wgup "$C" "$T/guard.json" wgg
sleep 1
r=$(nsx "$C" curl -s -m 8 -o /dev/null -w '%{http_code}' http://47.0.0.2:51822/v1/info)
[ "$r" = "200" ] && pass "guard: reaches a provider's control port" || fail guard-control "got '$r'"
refused "$C" http://44.0.0.1/ "guard: any non-provider destination"
nsx "$C" ip rule del not fwmark 51820 table 100; nsx "$C" ip link del wgg

# an unregistered key gets no handshake from the exit (WireGuard's silence) while registered peers keep theirs
priv=$(wg genkey); echo "$priv" > "$T/u.key"
nsx "$C" ip link add wgu type wireguard
nsx "$C" wg set wgu private-key "$T/u.key" peer "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).keys["wg-exit"])' "$T/x.json")" endpoint 47.0.0.2:51820 allowed-ips 10.77.0.1/32 persistent-keepalive 1
nsx "$C" ip addr add 10.77.250.250/32 dev wgu; nsx "$C" ip link set wgu up
nsx "$C" ping -c 2 -W 1 10.77.0.1 >/dev/null 2>&1
hs=$(nsx "$C" wg show wgu latest-handshakes | awk '{print $2}')
[ "$hs" = "0" ] && pass "unregistered key: no handshake" || fail unauthorized "handshake at $hs"

# the host's real runtime (WgCircuitRuntime + ingress worker + broker), a second circuit on the same providers
nsx "$H" node test/netns/runtime-node.mjs "$WG_BIN" "$T/g.json" "$T/x.json" "$RUNNER_KEY" 9443 > "$T/runtime.json" 2>"$T/runtime.err" & pids+=($!)
for i in $(seq 100); do [ -s "$T/runtime.json" ] && break; sleep 0.2; done
if [ -s "$T/runtime.json" ]; then
  pass "WgCircuitRuntime: circuit up (grants, outer, exit through guard, worker, broker)"
  RE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).egress)' "$T/runtime.json")
  r=$(nsx "$H" curl -s -m 10 --socks5-hostname "$RE" http://web.test/)
  [ "$r" = "remote=47.0.0.2" ] && pass "runtime egress entry (admission-gated) reaches the internet" || fail runtime-egress "got '$r'"
  sleep 1  # the newest exit peer holds the names now: visitors reach the runtime's circuit
  out=$(nsx "$W" node test/netns/visitor-node.mjs 47.0.0.2 www.example.org)
  case "$out" in *"$FP"*"enclave says: hello"*) pass "runtime ingress: SNI gate + broker splice to the enclave";; *) fail runtime-ingress "$out";; esac
  CE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).control)' "$T/runtime.json")
  r=$(nsx "$H" curl -s -m 10 --socks5-hostname "$CE" http://web.test/)
  [ "$r" = "remote=46.0.0.2" ] && pass "host control circuit (no app, registry-checked) leaves from its exit" || fail control-circuit "got '$r'"
  sleep 6
  nsx "$H" curl -s -m 10 --socks5-hostname "$RE" http://web.test/ >/dev/null && pass "grants renewed; circuit still serving" || fail runtime-renew "$(tail -3 "$T/runtime.err")"
else fail runtime "$(cat "$T/runtime.err")"; fi

# the qualification checker against both providers, through the real data path
node -e '
const fs=require("fs"),[g,x,ck]=process.argv.slice(1).map(f=>fs.readFileSync(f,"utf8"));
const rec=(j,a)=>{j=JSON.parse(j);return {providerId:"aa".repeat(16),operator:j.operator,address:a,wgExitKey:j.keys["wg-exit"],wgGuardKey:j.keys["wg-guard"],ports:{exit:51820,guard:51821,control:51822},roles:["guard","ingress","egress"],region:"test"};};
console.log(JSON.stringify([rec(g,"46.0.0.2"),rec(x,"47.0.0.2")]));' "$T/g.json" "$T/x.json" > "$T/records.json"
echo "$CHECKER_KEY" > "$T/checker.key"
nsx "$C" env SSL_CERT_FILE="$T/ca.pem" node scripts/network/wg-qualify.mjs --key-file "$T/checker.key" --wg "$WG_BIN" --records "$T/records.json" --out "$T/qual.json" --dns 44.0.0.1 --outbound https://web.test/ --payload 4194304 --smtp 44.0.0.1:25 > "$T/checker.log" 2>&1
for a in 46.0.0.2 47.0.0.2; do
  v=$(node -e 'const q=JSON.parse(require("fs").readFileSync(process.argv[1])).find(x=>x.qualification.address===process.argv[2]);console.log(q&&Object.values(q.qualification.checks).every(Boolean)?"ok":JSON.stringify(q?{c:q.qualification.checks,d:q.details}:"missing"))' "$T/qual.json" "$a" 2>&1)
  [ "$v" = ok ] && pass "checker: $a passes all nine checks through WireGuard" || fail "checker-$a" "$v $(tail -3 "$T/checker.log")"
done

# bring your own WireGuard: V is the owner's VPN (a plain kernel WireGuard server with NAT; not a provider)
VK=$(wg genkey); HK=$(wg genkey); echo "$VK" > "$T/v.key"
VP=$(echo "$VK" | wg pubkey); HP=$(echo "$HK" | wg pubkey)
nsx "$V" ip link add wgv type wireguard
nsx "$V" wg set wgv listen-port 51900 private-key "$T/v.key" peer "$HP" allowed-ips 10.66.0.2/32
nsx "$V" ip addr add 10.66.0.1/24 dev wgv; nsx "$V" ip link set wgv up
nsx "$V" sysctl -q -w net.ipv4.ip_forward=1
printf 'table ip nat {\n chain p {\n  type nat hook postrouting priority srcnat;\n  oifname "eth0" masquerade\n }\n}\n' > "$T/v.nft"; nsx "$V" nft -f "$T/v.nft" || fail byo-fixture "the VPN's NAT did not load"
cat > "$T/byo.conf" <<CONF
# the owner's VPN, as their vendor gave it
[Interface]
PrivateKey = $HK
Address = 10.66.0.2/32
DNS = 44.0.0.1

[Peer]
PublicKey = $VP
Endpoint = 49.0.0.2:51900
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 5
CONF
nsx "$H" node test/netns/byo-node.mjs "$WG_BIN" "$T/byo.conf" > "$T/byo.json" 2>"$T/byo.err" & BYOPID=$!; pids+=($BYOPID)
for i in $(seq 60); do [ -s "$T/byo.json" ] && break; sleep 0.2; done
if [ -s "$T/byo.json" ]; then
  BE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).egress)' "$T/byo.json")
  r=$(nsx "$H" curl -s -m 10 --socks5-hostname "$BE" http://web.test/)
  [ "$r" = "remote=49.0.0.2" ] && pass "BYO WireGuard: egress leaves from the owner's VPN, names through its tunnel" || fail byo-egress "got '$r' | $(tail -3 "$T/byo.err" | tr '\\n' ' ')"
  nsx "$H" curl -s -m 5 --socks5 "$BE" "http://[2606:4700::1111]/" >/dev/null 2>&1 && fail byo-ipv6 "IPv6 left the host" || pass "BYO without an IPv6 tunnel address: IPv6 refused, never leaked"
  nsx "$V" ip link del wgv
  s=$(date +%s); nsx "$H" curl -s -m 8 --socks5-hostname "$BE" http://web.test/ >/dev/null && fail byo-killswitch "traffic went somewhere with the VPN gone" || pass "BYO VPN gone: nothing leaves (no fallback to the host's network)"
else fail byo "$(cat "$T/byo.err")"; fi

# direct hosting: the host's own public address (45.0.0.2), qualified by the checker, through the real host code
nsx "$H" node test/netns/direct-node.mjs "$WG_BIN" "$RUNNER_KEY" "$CHECKER_KEY" 45.0.0.2 9443 > "$T/direct.json" 2>"$T/direct.err" & pids+=($!)
for i in $(seq 60); do [ -s "$T/direct.json" ] && break; sleep 0.2; done
if [ -s "$T/direct.json" ]; then
  rt=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(j.routes.map(r=>r.transport+"@"+r.address).join(",")||("none: "+j.error))' "$T/direct.json")
  [ "$rt" = "direct@45.0.0.2" ] && pass "direct: the manager publishes one direct route on the host's own address" || fail direct-route "$rt"
  out=$(nsx "$W" node test/netns/visitor-node.mjs 45.0.0.2 abababab.app.enclave.host)
  case "$out" in *"$FP"*"enclave says: hello"*) pass "direct: visitors reach the enclave on the host's IP; TLS ends in the enclave";; *) fail direct-ingress "$out";; esac
  DE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).egress)' "$T/direct.json")
  r=$(nsx "$H" curl -s -m 10 --socks5 "$DE" http://44.0.0.1/)
  [ "$r" = "remote=45.0.0.2" ] && pass "direct: egress leaves from the host's own address" || fail direct-egress "got '$r'"
  nsx "$H" curl -s -m 5 --socks5 "$DE" http://10.9.9.9/ >/dev/null 2>&1 && fail direct-private "a private destination was reached" || pass "direct: private destinations refused"
else fail direct "$(cat "$T/direct.err")"; fi

exit $FAILED
