#!/bin/bash
# Native G2 test, stage 2: runs as PID 1 of PRIVATE pid + net + mount namespaces (run.sh starts it under systemd-run; the
# local scaffold check starts it under `unshare -r`). Everything it creates - namespaces, veths, WireGuard interfaces and
# keys, nft tables, conntrack entries, files - lives only inside those namespaces and a private tmpfs, and is gone when
# this process exits. It changes nothing on the host: no host interface, firewall, sysctl, route or file.
#   stage2.sh <harness dir> full|scaffold|flush     (flush: ONLY the failover + conntrack-delete sequence, once
#                                                  conntrack-tools is installed - closes the full run's one SKIP)
# Topology (all inside): client C 48.0.0.2 -- [outer router] -- provider P 47.0.0.2 (eth0; wg-exit 10.77.0.1/16, the frozen
# kernel.mjs ruleset) -- WireGuard -- hosts H1 10.77.0.5 / H2 10.77.0.6, each a Python DNS answerer (H1 -> 192.0.2.1,
# H2 -> 192.0.2.2) on its tunnel address. P's map points 53 at one host at a time, exactly as provider.mjs sync does.
set -uo pipefail
D=$1; MODE=${2:-full}; FZ="$D/frozen"; PY="python3 $D/dnsfix.py"; umask 077
mount -t tmpfs -o size=16m,mode=0700 tmpfs /tmp || { echo "FAIL setup: private tmpfs"; exit 1; }
W=/tmp; FAILED=0; pids=()
pass(){ echo "PASS $1"; }; fail(){ echo "FAIL $1: $2"; FAILED=1; }; skip(){ echo "SKIP $1: $2"; }
cleanup(){ for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT
mk(){ unshare -n sleep 90 </dev/null >/dev/null 2>&1 & pids+=($!); printf -v "$1" %s $!; }
nsx(){ local p=$1; shift; nsenter -t "$p" -n -- "$@"; }
link(){ ip link add "$1" type veth peer name eth0 netns "$2" && ip addr add "$3/24" dev "$1" && ip link set "$1" up &&
  nsx "$2" ip addr add "$4/24" dev eth0 && nsx "$2" ip link set eth0 up && nsx "$2" ip link set lo up && nsx "$2" ip route add default via "$3"; }
ip link set lo up; sysctl -q -w net.ipv4.ip_forward=1     # this (outer, private) namespace only
mk C; mk P; mk H1; mk H2; sleep 0.2
link vC "$C" 48.0.0.1 48.0.0.2 && link vP "$P" 47.0.0.1 47.0.0.2 && link vH1 "$H1" 45.0.0.1 45.0.0.2 && link vH2 "$H2" 46.0.0.1 46.0.0.2 \
  || { echo "FAIL setup: veths"; exit 1; }
# the provider's kernel state as kernel.mjs ensure() makes it: wg-exit 10.77.0.1/16, mtu 1340, forwarding on
key(){ wg genkey > "$W/$1.key"; chmod 600 "$W/$1.key"; wg pubkey < "$W/$1.key"; }
PK=$(key p); nsx "$P" ip link add wg-exit type wireguard || { echo "FAIL setup: no kernel WireGuard"; exit 1; }
nsx "$P" wg set wg-exit listen-port 51820 private-key "$W/p.key"; nsx "$P" ip addr add 10.77.0.1/16 dev wg-exit; nsx "$P" ip link set wg-exit mtu 1340 up
nsx "$P" sysctl -q -w net.ipv4.ip_forward=1
host(){ local ns=$1 addr=$2 ans=$3 name=$4 hk
  hk=$(key "$name"); nsx "$ns" ip link add wg0 type wireguard; nsx "$ns" wg set wg0 private-key "$W/$name.key"
  nsx "$ns" ip addr add "$addr/16" dev wg0; nsx "$ns" ip link set wg0 mtu 1340 up
  # the peer (with keepalive) only once the link is up, so the HOST starts the handshake: P learns its endpoint from it
  nsx "$ns" wg set wg0 peer "$PK" endpoint 47.0.0.2:51820 allowed-ips 10.77.0.1/32 persistent-keepalive 1
  nsx "$P" wg set wg-exit peer "$hk" allowed-ips "$addr/32"                 # = kernel.mjs setPeer
  nsx "$ns" $PY serve "$addr" "$ans" "$W/$name.log" 5353 > "$W/$name.ready" 2>"$W/$name.err" & pids+=($!)
  printf -v "${name^^}KEY" %s "$hk"; }
host "$H1" 10.77.0.5 192.0.2.1 h1; host "$H2" 10.77.0.6 192.0.2.2 h2
for i in $(seq 50); do [ -s "$W/h1.ready" ] && [ -s "$W/h2.ready" ] && break; sleep 0.1; done
# both hosts' handshakes with the provider (as on a real provider: a peer has no endpoint until its host connects)
for i in $(seq 60); do [ "$(nsx "$P" wg show wg-exit latest-handshakes | awk '$2>0' | wc -l)" = 2 ] && break; sleep 0.1; done
[ "$(nsx "$P" wg show wg-exit latest-handshakes | awk '$2>0' | wc -l)" = 2 ] && pass "both hosts completed a WireGuard handshake with the provider" || fail handshake "$(nsx "$P" wg show wg-exit latest-handshakes)"
[ -s "$W/h1.ready" ] && [ -s "$W/h2.ready" ] || { echo "FAIL setup: DNS fixtures $(cat "$W"/h*.err)"; exit 1; }
# scaffold: the tunnels carry DNS (the provider's own probe path, dns-probe.mjs): P -> 10.77.0.x:53 over WireGuard
r1=$(nsx "$P" $PY query udp 10.77.0.5 53 probe.app.example --timeout 3); r2=$(nsx "$P" $PY query udp 10.77.0.6 53 probe.app.example --timeout 3)
[ "$r1" = 192.0.2.1 ] && [ "$r2" = 192.0.2.2 ] && pass "kernel WireGuard peers up; each host's DNS answers through its tunnel (the probe path)" || fail tunnels "$r1 $r2"
if [ "$MODE" = scaffold ]; then
  nsx "$P" nft -c -f "$FZ/ruleset-dns.nft" 2>"$W/nft.err" && echo "NOTE this kernel ACCEPTS the DNS ruleset" || echo "NOTE this kernel refuses the DNS ruleset: $(grep -m1 -o 'Error: [^^]*' "$W/nft.err")"
  echo "SCAFFOLD-RC=$FAILED"; exit $FAILED
fi
q(){ nsx "$C" $PY query "$@"; }
if [ "$MODE" = flush ]; then
  # final review N2/P1/P2. One fixed-port UDP flow F (a steady resolver) followed through H1 -> H2 -> nobody, a provider
  # restart and a rollback. For EACH effect step, before the delete: F's conntrack entry to the OLD host EXISTS
  # (conntrack -L), and F gets NO answer while the old host sees nothing (the DNS gate drops it: fail closed). Then the
  # delete removes >= 1 entry, and F reaches the new target. A NEGATIVE CONTROL with the rev3 ruleset (no gate, the one
  # root ran at 16:33Z) shows the old host still answering - what the gate prevents.
  nsx "$P" sh -c 'command -v conntrack' >/dev/null || { echo "FAIL flush: conntrack-tools absent"; exit 1; }
  CMD=$(cat "$FZ/conntrack-flush.txt"); [ "$CMD" = "conntrack -D -p udp --orig-dst 47.0.0.2 --orig-port-dst 53" ] && pass "the delete is exactly kernel.mjs's command: $CMD" || fail flush-cmd "$CMD"
  decided(){ python3 -c "import json,sys;print('yes' if json.load(open('$FZ/flush-decisions.json'))[sys.argv[1]] else 'no')" "$1"; }
  F(){ q udp 47.0.0.2 53 f.app.example --sport 40053 --timeout "${1:-1.5}"; }
  entry(){ nsx "$P" conntrack -L -p udp --orig-port-src 40053 2>/dev/null | grep -c " src=$1 " || true; }   # F's entries replied by host $1
  logn(){ wc -l < "$W/$1.log"; }
  # strict precondition + effect, for one step: $1 kernel.mjs step, $2 old host addr, $3 old log, $4 expected after ("NONE" or an answer)
  step(){ local n; n=$(entry "$2")
    [ "$n" -ge 1 ] && pass "[$1] before the delete F's conntrack entry to $2 EXISTS ($n)" || { fail "[$1] precondition" "no entry to $2 - the delete would prove nothing"; return; }
    local before; before=$(logn "$3"); local r; r=$(F 1)
    [ "$r" = NONE ] && [ "$(logn "$3")" = "$before" ] && pass "[$1] the stale flow is DROPPED by the gate ($2 sees nothing)" || fail "[$1] gate" "stale flow got '$r'"
    [ "$(decided "$1")" = yes ] || { fail "[$1] decision" "kernel.mjs would not delete here"; return; }
    nsx "$P" $CMD >"$W/ct.out" 2>&1; local d; d=$(grep -o '[0-9]* flow entries have been deleted' "$W/ct.out" | grep -o '^[0-9]*')
    [ "${d:-0}" -ge 1 ] && pass "[$1] kernel.mjs's delete removed $d entr(ies)" || fail "[$1] delete" "$(tail -1 "$W/ct.out")"
    [ "$(entry "$2")" = 0 ] && pass "[$1] no entry to $2 remains" || fail "[$1] remaining" "entry to $2 still present"
    r=$(F); [ "$r" = "$4" ] && pass "[$1] after the delete F gets: $4" || fail "[$1] after" "F got '$r', expected $4"; }
  tables(){ nsx "$P" nft delete table inet enclave_net 2>/dev/null; nsx "$P" nft -f "$1"; }   # = kernel.mjs applyTable at a start
  # run 1: first assignment H1 (nothing to prove before it: no prior flow)
  tables "$FZ/ruleset-dns.nft" && nsx "$P" nft -f "$FZ/sync-h1.nft" && pass "run 1: the frozen ruleset loads; 53 -> H1" || { fail ruleset "load"; exit 1; }
  [ "$(decided 'h1 (first assignment)')" = yes ] && nsx "$P" $CMD >/dev/null 2>&1
  [ "$(F)" = 192.0.2.1 ] && pass "F reaches H1" || fail F-h1 "not on H1"
  # NEGATIVE CONTROL: the rev3 table (no gate) after a switch to H2 keeps answering F from H1 - the leak the gate closes
  tables "$D/control/rev3-ruleset-dns.nft" && nsx "$P" nft -f "$D/control/rev3-sync-h2.nft"
  [ "$(F)" = 192.0.2.1 ] && pass "negative control (rev3, no gate): after the switch the OLD host H1 still answers F" || echo "NOTE negative control: rev3 did not leak (F got '$(F 1)')"
  tables "$FZ/ruleset-dns.nft" && nsx "$P" nft -f "$FZ/sync-h2.nft"   # the real table (conntrack survives re-creation)
  rm -f "$W/go"; nsx "$C" $PY tcpkeep 47.0.0.2 53 "$W/go" 25 > "$W/keep.out" & keep=$!; sleep 0.5   # an open TCP 53 connection, now on H2
  step 'h1 -> h2' 10.77.0.5 h1 192.0.2.2
  [ "$(q udp 47.0.0.2 53 n.app.example)" = 192.0.2.2 ] && pass "H1 -> H2: a new flow reaches H2" || fail h1-h2-new "not on H2"
  nsx "$P" nft -f "$FZ/sync-none.nft"; step 'h2 -> none' 10.77.0.6 h2 NONE
  touch "$W/go"; wait $keep; k=$(cat "$W/keep.out")
  [ "$k" = "192.0.2.2 192.0.2.2" ] && pass "an open TCP 53 connection finished on its host across the revoke (TCP is not gated)" || fail tcp-kept "$k"
  # provider RESTART: run 1 leaves F on H1; run 2 re-creates the table, first assignment H2
  nsx "$P" nft -f "$FZ/sync-h1.nft"; nsx "$P" $CMD >/dev/null 2>&1   # none -> H1 is a change: kernel.mjs deletes
  [ "$(F)" = 192.0.2.1 ] || fail restart-setup "F not on H1"
  tables "$FZ/ruleset-dns.nft" && nsx "$P" nft -f "$FZ/sync-h2.nft"; step 'restart, first assignment h2' 10.77.0.5 h1 192.0.2.2
  # ROLLBACK: dns removed (the plain table, with its static gate): F (on H2) is dropped with no delete at all; the
  # rollback delete then frees the entry
  tables "$FZ/ruleset-plain.nft"; n=$(entry 10.77.0.6); b=$(logn h2); r=$(F 1)
  [ "$n" -ge 1 ] && [ "$r" = NONE ] && [ "$(logn h2)" = "$b" ] && pass "rollback: the plain table's gate drops F (entry to H2 present: $n) with no delete" || fail rollback-gate "entry=$n F='$r'"
  nsx "$P" $CMD >"$W/ct.out" 2>&1; echo "NOTE [rollback delete] $(tail -1 "$W/ct.out")"
  [ "$(entry 10.77.0.6)" = 0 ] && pass "rollback: the delete removed F's entry" || fail rollback-delete "entry still present"
  echo "G2-FLUSH-RC=$FAILED"; exit $FAILED
fi
# T0 the frozen kernel.mjs ruleset loads; the map is empty: nothing is forwarded
nsx "$P" nft -f "$FZ/ruleset-dns.nft" 2>"$W/nft.err" && pass "the frozen kernel.mjs DNS ruleset loads" || { fail ruleset "$(head -c 300 "$W/nft.err")"; exit 1; }
[ "$(q udp 47.0.0.2 53 a.app.example --timeout 1)" = NONE ] && pass "empty map: UDP 53 is forwarded to nobody" || fail empty-map "answered"
# T1 one target: UDP and TCP 53 reach H1, masqueraded to the provider's tunnel address
nsx "$P" nft -f "$FZ/sync-h1.nft" || fail sync-h1 "nft"
[ "$(q udp 47.0.0.2 53 a.app.example)" = 192.0.2.1 ] && pass "UDP 53 DNATed to the assigned host (H1)" || fail udp "not answered by H1"
[ "$(q tcp 47.0.0.2 53 a.app.example)" = 192.0.2.1 ] && pass "TCP 53 DNATed to the assigned host (H1)" || fail tcp "not answered by H1"
grep -q '^udp 10.77.0.1 ' "$W/h1.log" && ! grep -qv ' 10.77.0.1 ' "$W/h1.log" && pass "the host sees only the provider's tunnel address (masquerade)" || fail masquerade "$(head -3 "$W/h1.log")"
[ -z "$(grep -h ' 5353$' "$W"/h1.log "$W"/h2.log 2>/dev/null)" ] || fail precheck "5353 traffic before the test"
# T2 nothing but 53: another UDP port and TCP 80 are not forwarded (the host's 5353 listener stays silent)
[ "$(q udp 47.0.0.2 5353 a.app.example --timeout 1)" = NONE ] && [ -z "$(grep -h ' 5353$' "$W"/h1.log "$W"/h2.log)" ] && pass "UDP 5353 is not forwarded" || fail other-udp "forwarded"
[ "$(nsx "$C" $PY tcphold 47.0.0.2 80 1 1)" = 0 ] && pass "TCP 80 to the provider is not forwarded (no listener here)" || fail other-tcp "connected"
# T3 bounds: one source's burst is cut by the per-source rate; one source holds at most tcpPerSource TCP connections
sleep 2.5
n=$(nsx "$C" $PY burst 47.0.0.2 53 200 2); lim=$(python3 -c "import json;d=json.load(open('$FZ/limits.json'));print(d['perSourceBurst'],d['perSourcePps'],d['tcpPerSource'])")
read -r BURST PPS TCPS <<<"$lim"
[ "$n" -lt 200 ] && [ "$n" -le $((BURST + 3 * PPS)) ] && [ "$n" -ge $((BURST / 2)) ] && pass "a 200-query burst from one source is rate-limited ($n answered; burst $BURST, $PPS/s)" || fail rate "$n answered"
sleep 2.5
t=$(nsx "$C" $PY tcphold 47.0.0.2 53 $((TCPS + 4)) 1)
[ "$t" -le "$TCPS" ] && [ "$t" -ge 1 ] && pass "at most $TCPS concurrent TCP 53 connections per source ($t of $((TCPS + 4)) connected)" || fail tcp-limit "$t connected"
sleep 2.5
# T4 a target switch (failover): new flows go to H2; an EXISTING UDP flow (its conntrack entry still DNATed to H1) is
# DROPPED by the DNS gate - never answered by the old host - until kernel.mjs's conntrack delete moves it to H2
[ "$(q udp 47.0.0.2 53 s.app.example --sport 40053)" = 192.0.2.1 ] || fail pre-switch "fixed-port flow not on H1"
nsx "$P" nft -f "$FZ/sync-h2.nft" || fail sync-h2 "nft"
[ "$(q udp 47.0.0.2 53 s.app.example)" = 192.0.2.2 ] && pass "after the switch, a new UDP flow reaches H2" || fail switch "new flow not on H2"
[ "$(q tcp 47.0.0.2 53 s.app.example)" = 192.0.2.2 ] && pass "after the switch, TCP reaches H2" || fail switch-tcp "not on H2"
h1n=$(wc -l < "$W/h1.log"); st=$(q udp 47.0.0.2 53 s.app.example --sport 40053 --timeout 1)
[ "$st" = NONE ] && [ "$(wc -l < "$W/h1.log")" = "$h1n" ] && pass "the existing UDP flow is DROPPED by the gate (H1 never sees it) - fail closed before any delete" || fail gate "stale flow answered: $st"
if nsx "$P" sh -c 'command -v conntrack' >/dev/null; then
  nsx "$P" $(cat "$FZ/conntrack-flush.txt") >/dev/null 2>&1
  [ "$(q udp 47.0.0.2 53 s.app.example --sport 40053)" = 192.0.2.2 ] && pass "after kernel.mjs's conntrack delete the same flow reaches H2" || fail flush "still not on H2"
else skip conntrack-flush "conntrack-tools absent: the stale flow stays DROPPED (gate) until its conntrack entry idles out; a steady resolver keeps it, so no timeout bounds it"; fi
# T5 revoke: an empty map forwards nothing; a target whose WireGuard peer was removed receives nothing either
nsx "$P" nft -f "$FZ/sync-none.nft" || fail sync-none "nft"
[ "$(q udp 47.0.0.2 53 r.app.example --timeout 1)" = NONE ] && pass "revoked (empty map): nothing answers" || fail revoke "answered"
nsx "$P" nft -f "$FZ/sync-h2.nft"; nsx "$P" wg set wg-exit peer "$H2KEY" remove
[ "$(q udp 47.0.0.2 53 r2.app.example --timeout 1)" = NONE ] && pass "a host whose peer was removed (kernel.mjs removePeer) receives nothing" || fail removed-peer "answered"
echo "G2-RC=$FAILED"; exit $FAILED
