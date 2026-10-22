#!/usr/bin/env bash
# SUPERSEDED by inbound_probe.py (root review: unsafe/ambiguous cleanup). Kept for history only; it refuses to run.
echo "s4-probe.sh is superseded by inbound_probe.py; not run" >&2; exit 2
# S4 DECIDING OBSERVATION (root runs it; NOT run by Claude). Does unsolicited inbound to the site's public IPv4 reach the
# TP-Link, and does the site hairpin to its own public address? Nonsecret, one TCP port, <= 10 minutes.
# Design from work/claude-host-relay-s4-result.txt section 2 (B), plus a hairpin check.
#   VANTAGE=<ssh alias of an authorized machine OUTSIDE this site> bash s4-probe.sh
# The ONLY state change is ONE temporary TP-Link mapping that ROOT/THE USER adds and removes (step 3/7): this script never
# touches the router itself. It does not touch the GL.iNet, keys, production services or any firewall.
# Result -> s4-probe-<UTC>.json (inbound: reached | not-reached | not-run; hairpin: reached | not-reached).
set -uo pipefail
: "${VANTAGE:?set VANTAGE to an ssh alias of an authorized machine outside this site (e.g. an existing DO host: a plain outbound connect)}"
ADB=${ADB:-/home/steven/Android/Sdk/platform-tools/adb}; PIXEL=${PIXEL:-YV4FGO7B9WS7F4}; PIXEL_IP=${PIXEL_IP:-192.168.88.5}; PUB=${PUB:-4.15.13.178}; P=${P:-47123}
N=$(openssl rand -hex 8); OUT=s4-probe-$(date -u +%Y%m%dT%H%M%SZ).json
say() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
listen() { "$ADB" -s "$PIXEL" shell "echo enclave-s4-probe-$N | timeout $1 nc -l -p $P" >/dev/null 2>&1 & echo $!; }
grab() { python3 -c "import socket,sys;s=socket.create_connection((sys.argv[1],int(sys.argv[2])),timeout=6);s.settimeout(6);print(s.recv(64).decode().strip())" "$1" "$2" 2>/dev/null; }
check() { [ "$(cat)" = "enclave-s4-probe-$N" ] && echo reached || echo not-reached; }

say "1. control: listener on the Pixel ($PIXEL_IP:$P), reached from this machine over the LAN (no router change)"
L=$(listen 60); sleep 2; CONTROL=$(grab "$PIXEL_IP" "$P" | check); wait "$L" 2>/dev/null
say "   control: $CONTROL"; [ "$CONTROL" = reached ] || { echo "control failed: fix the listener path first; nothing else was done"; exit 1; }

say "2. listener for the real test (600 s)"; L=$(listen 600); sleep 2
cat <<EOM
3. MANUAL (root/user): add ONE temporary TP-Link (192.168.88.1) mapping, TCP $P -> $PIXEL_IP:$P, lease <= 600 s:
     upnpc -u http://192.168.88.1:1900/nxaada/gatedesc.xml -e enclave-s4-probe -a $PIXEL_IP $P $P TCP 600
   (or the same forward in the TP-Link UI). Confirm read-only: GetSpecificPortMappingEntry(TCP,$P) -> $PIXEL_IP.
   Press Enter when the mapping is in place (or type skip to clean up without testing).
EOM
read -r ans
INBOUND=not-run; HAIRPIN_LOCAL=not-run
if [ "$ans" != skip ]; then
  say "4. inbound from OUTSIDE ($VANTAGE -> $PUB:$P)"
  INBOUND=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$VANTAGE" "python3 -c 'import socket;s=socket.create_connection((\"$PUB\",$P),timeout=8);s.settimeout(8);print(s.recv(64).decode().strip())'" 2>/dev/null | check)
  say "   inbound: $INBOUND"
  if [ "$INBOUND" = reached ]; then L=$(listen 120); sleep 2; fi        # the first connection consumed the listener
  say "5. hairpin from INSIDE (this machine -> $PUB:$P)"
  HAIRPIN_LOCAL=$(grab "$PUB" "$P" | check)
  say "   hairpin: $HAIRPIN_LOCAL"
fi
say "6. listener stops"; kill "$L" 2>/dev/null; "$ADB" -s "$PIXEL" shell "pkill -f 'nc -l -p $P'" >/dev/null 2>&1 || true
cat <<EOM
7. MANUAL CLEANUP (always): remove the mapping
     upnpc -u http://192.168.88.1:1900/nxaada/gatedesc.xml -d $P TCP
   and confirm GetSpecificPortMappingEntry(TCP,$P) -> NoSuchEntry (714).
EOM
printf '{"at":"%s","public":"%s","port":%s,"control":"%s","inbound":"%s","hairpinFromSite":"%s","vantage":"%s",\n "meaning":{"inbound reached":"unsolicited inbound to %s reaches the TP-Link: forwarding to a site host is feasible (address stability still to watch)","inbound not-reached":"the device at/after 10.1.68.1 does not pass it: needs that device owner (site or ISP); this alone does not prove shared CGNAT","hairpin reached":"an on-site checker/client can reach the site public address","hairpin not-reached":"qualification of a site-hosted public address needs an OFF-SITE checker vantage"}}\n' \
  "$(date -u +%FT%TZ)" "$PUB" "$P" "$CONTROL" "$INBOUND" "$HAIRPIN_LOCAL" "$VANTAGE" "$PUB" > "$OUT"
say "result: $OUT"; cat "$OUT"
