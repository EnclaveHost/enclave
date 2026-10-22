#!/usr/bin/env bash
# Offline (run inside `unshare -rn`). Does a real Kubo 0.42 GATEWAY (boxo, HTTP retrieval) serve a site sub-resource
# (css/site.css, js/boot.js) when it already holds the root but starts a NEW retrieval session (a new request after a
# daemon restart, as a gateway fleet / cache layer does), and the only provider record is for the ROOT CID?
# Provider: real Caddy 2.11.7 (TLS, h2) with worker 6b's snippet byte-identical, blocks = 9d's verified export.
set -uo pipefail
H="$(cd "$(dirname "$0")" && pwd)"; W="$(dirname "$H")"
RUN="$H/run"; rm -rf "$RUN"; mkdir -p "$RUN"
CADDY=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-caddy/caddy
R=bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou
IP=10.77.0.1; CPORT=8443; RPORT=8602; GPORT=8080
pids=(); cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }; trap cleanup EXIT
fail() { echo "GW FAIL: $*"; exit 1; }
ip addr add "$IP/32" dev lo || fail "no test address"
curl -s -m 3 -o /dev/null https://delegated-ipfs.dev/ 2>/dev/null && fail "namespace reaches the internet"
ls "$W/content/export/ipfs" > "$RUN/cids.txt"; echo "blocks: $(wc -l < "$RUN/cids.txt") (9d export)"
sed "s#/opt/enclave-site-blocks#$W/content/export#g" "$W/serving/ipfs-trustless-routes.caddy" > "$RUN/snippet"
cat > "$RUN/Caddyfile" <<C
{
	admin off
	auto_https disable_redirects
	skip_install_trust
	storage file_system $RUN/caddy-data
	log {
		level ERROR
	}
}
https://$IP:$CPORT {
	bind $IP
	tls internal
$(cat "$RUN/snippet")
	handle /ipfs/* {
		respond 404
	}
}
C
XDG_DATA_HOME="$RUN/xdg" XDG_CONFIG_HOME="$RUN/xdg" "$CADDY" run --config "$RUN/Caddyfile" --adapter caddyfile > "$RUN/caddy.log" 2>&1 & pids+=($!)
for i in $(seq 1 50); do curl -sk -m 1 -o /dev/null "https://$IP:$CPORT/ipfs/bafkqaaa?format=raw" && break; sleep 0.2; done
echo "provider css block: $(curl -sk --http2 -m 5 -o /dev/null -w '%{http_code} h%{http_version} %{size_download}B' "https://$IP:$CPORT/ipfs/bafkreiahsauynipsbgmrp7l5s2t32vmsiaggnj7ffbqnvcwlmmz5pcuila?format=raw")"
ROUTER=
router() { [ -n "$ROUTER" ] && kill "$ROUTER" 2>/dev/null; wait "$ROUTER" 2>/dev/null
  node "$H/router-stub.mjs" "$IP" "$RPORT" "$1" "$R" "$RUN/cids.txt" "/ip4/$IP/tcp/$CPORT/https" "$RUN/router-$1.log" & ROUTER=$!; pids+=($ROUTER); sleep 0.5; }
KUBO=; N=0
kubo_init() { export IPFS_PATH="$RUN/kubo-$1"
  ipfs init --profile=test -e > /dev/null 2>&1 || fail "ipfs init"
  ipfs config --json AutoConf.Enabled false; ipfs config Routing.Type delegated
  ipfs config --json Routing.DelegatedRouters "[\"http://$IP:$RPORT\"]"; ipfs config --json Ipns.DelegatedPublishers '[]'
  ipfs config --json HTTPRetrieval.Enabled true; ipfs config --json HTTPRetrieval.TLSInsecureSkipVerify true
  ipfs config --json Bootstrap '[]'; ipfs config --json Provide.Enabled false
  ipfs config Addresses.Gateway "/ip4/$IP/tcp/$GPORT"; ipfs config --json Addresses.API "\"/ip4/127.0.0.1/tcp/5001\""; }
kubo_start() { [ -n "$KUBO" ] && { kill "$KUBO"; wait "$KUBO" 2>/dev/null; }
  N=$((N+1)); ipfs daemon > "$RUN/kubo-$1.$N.log" 2>&1 & KUBO=$!; pids+=($KUBO)
  for i in $(seq 1 100); do grep -q "Daemon is ready" "$RUN/kubo-$1.$N.log" && return 0; sleep 0.3; done; fail "kubo start"; }
get() {  # $1 label, $2 path -> status, bytes, sha match vs export
  local t0=$(date +%s) out; rm -f "$RUN/body"
  out=$(curl -s -m 75 -o "$RUN/body" -w '%{http_code} %{size_download}B %{content_type}' "http://$IP:$GPORT/ipfs/$R/$2")
  echo "  $1 GET /ipfs/<root>/$2 -> $out in $(( $(date +%s) - t0 ))s sha=$( [ -f "$RUN/body" ] && sha256sum "$RUN/body" | cut -c1-16)"; }
local_has() { ipfs block stat --offline "$1" > /dev/null 2>&1 && echo yes || echo no; }

for MODE in root all; do
  echo "== provider records: $MODE"
  router "$MODE"; kubo_init "$MODE"; kubo_start "$MODE"
  get "fresh daemon:" ""
  get "same daemon, next request:" "assets/hex-grid.svg"
  echo "  restart the daemon (blockstore kept: root cached=$(local_has $R), css dir cached=$(local_has bafybeic4uud6xvpuzjrrsrhocxykkleg2vjas6mgw476dbdbz3kkzibbce))"
  kubo_start "$MODE"
  get "restarted, root cached:" "css/site.css"
  get "restarted, root cached:" "js/boot.js"
  echo "  router queries: $(grep -c . "$RUN/router-$MODE.log") ($(grep -c '^HIT' "$RUN/router-$MODE.log") answered)"; sed 's/^/    /' "$RUN/router-$MODE.log" | sort | uniq -c | sort -rn | head -8
done
echo GW-RUN-DONE
