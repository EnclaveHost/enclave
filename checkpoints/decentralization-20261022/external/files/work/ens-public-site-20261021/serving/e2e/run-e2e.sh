#!/usr/bin/env bash
# End-to-end proof, run INSIDE a loopback-only network namespace (serving-job.sh: unshare -rn): a real Kubo (0.42, its boxo
# HTTP-retrieval client, the same code public gateways run) fetches a real published site, found only through a delegated
# router that lists the front as the site root's sole HTTP provider (as cid.contact does today), from a real Caddy
# (v2.11.7, TLS + HTTP/2) carrying production's ipfs.enclave.host route shape.
#   AFTER  = production shape + ipfs-trustless-routes.caddy (blocks extracted by extract-site-blocks.mjs): must fetch every
#            block; the fetched block set must equal the CAR's and the files must equal the package's site/.
#   BEFORE = production shape only (today): must FAIL to fetch (probe 400, child blocks 404), as the public gateways do.
# Usage: run-e2e.sh <package dir: .../sites/<root> with site.car, site-root.block, site-root.txt, site/>
set -uo pipefail
E="$(cd "$(dirname "$0")" && pwd)"; S="$(dirname "$E")"
PKG="$(cd "$1" && pwd)"; ROOT="$(basename "$PKG")"
RUN="$S/run"; rm -rf "$RUN"; mkdir -p "$RUN"
CADDY=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-caddy/caddy
IP=10.77.0.1; CPORT=8443; APORT=8601; RPORT=8602
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }
trap cleanup EXIT
fail() { echo "E2E FAIL: $*"; exit 1; }

ip addr add "$IP/32" dev lo || fail "no private test address"   # a private (non-loopback-range) address, so the provider is not a 127/8 one
if curl -s -m 3 -o /dev/null https://delegated-ipfs.dev/ 2>/dev/null; then fail "the namespace reaches the internet"; fi
echo "namespace: offline; front at $IP:$CPORT"

echo "== blocks"
node "$S/extract-site-blocks.mjs" --sites "$(dirname "$PKG")" --out "$RUN/blocks" --cid "$ROOT" > "$RUN/extract.json" || fail "extract"
cat "$RUN/extract.json"
ls "$RUN/blocks/ipfs" | grep -v "^$ROOT$" | sort > "$RUN/car-children.txt"
echo "child blocks in the CAR: $(wc -l < "$RUN/car-children.txt")"

node "$E/adapter-stub.mjs" "$IP" "$APORT" "$RUN/adapter-cid.txt" & pids+=($!)
node "$E/router-stub.mjs" "$IP" "$RPORT" "$ROOT" "/ip4/$IP/tcp/$CPORT/https" "$RUN/router.log" & pids+=($!)

caddyfile() {   # $1 = after|before
  local snippet=""
  [ "$1" = after ] && snippet="$(sed "s#/opt/enclave-site-blocks#$RUN/blocks#g" "$S/ipfs-trustless-routes.caddy")"
  cat > "$RUN/Caddyfile.$1" <<EOF
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
	header {
		Access-Control-Allow-Origin *
		X-Content-Type-Options nosniff
		Content-Security-Policy "default-src 'none'; sandbox"
	}
	@pin0car {
		path /ipfs/$ROOT
		query format=car
	}
	handle @pin0car {
		root * $PKG
		rewrite * /site.car
		header Content-Type application/vnd.ipld.car
		file_server
	}
	@pin0raw {
		path /ipfs/$ROOT
		query format=raw
	}
	handle @pin0raw {
		root * $PKG
		rewrite * /site-root.block
		header Content-Type application/vnd.ipld.raw
		file_server
	}
	handle /site-root {
		root * $PKG
		rewrite * /site-root.txt
		header Content-Type "text/plain; charset=utf-8"
		file_server
	}
$snippet
	handle /ipfs/* {
		reverse_proxy $IP:$APORT
	}
	handle {
		respond 404
	}
}
EOF
}
start_caddy() {
  caddyfile "$1"
  "$CADDY" validate --config "$RUN/Caddyfile.$1" --adapter caddyfile > "$RUN/caddy-validate.$1.log" 2>&1 || { cat "$RUN/caddy-validate.$1.log"; fail "caddy validate ($1)"; }
  XDG_DATA_HOME="$RUN/xdg" XDG_CONFIG_HOME="$RUN/xdg" "$CADDY" run --config "$RUN/Caddyfile.$1" --adapter caddyfile > "$RUN/caddy.$1.log" 2>&1 & CADDY_PID=$!; pids+=($CADDY_PID)
  for i in $(seq 1 50); do curl -sk -m 1 -o /dev/null "https://$IP:$CPORT/site-root" && return 0; sleep 0.2; done
  cat "$RUN/caddy.$1.log"; fail "caddy did not start ($1)"
}
code() { curl -sk --http2 -m 10 -o "${3:-/dev/null}" -w '%{http_code} HTTP/%{http_version}' ${2:+-X "$2"} -H 'Accept: application/vnd.ipld.raw' "https://$IP:$CPORT$1"; }
headcode() { curl -sk --http2 -m 10 -I -o /dev/null -w '%{http_code}' -H 'Accept: application/vnd.ipld.raw' "https://$IP:$CPORT$1"; }
start_kubo() {   # $1 = repo name
  export IPFS_PATH="$RUN/kubo-$1"
  ipfs init --profile=test -e > /dev/null 2>&1 || fail "ipfs init"
  ipfs config --json AutoConf.Enabled false
  ipfs config Routing.Type delegated
  ipfs config --json Routing.DelegatedRouters "[\"http://$IP:$RPORT\"]"
  ipfs config --json Ipns.DelegatedPublishers '[]'
  ipfs config --json HTTPRetrieval.Enabled true
  ipfs config --json HTTPRetrieval.TLSInsecureSkipVerify true
  ipfs config --json Bootstrap '[]'
  ipfs config --json Provide.Enabled false     # Routing.Type=delegated cannot provide (kubo refuses to start otherwise)
  ipfs daemon > "$RUN/kubo-$1.log" 2>&1 & KUBO_PID=$!; pids+=($KUBO_PID)
  for i in $(seq 1 100); do kill -0 "$KUBO_PID" 2>/dev/null || break; grep -q "Daemon is ready" "$RUN/kubo-$1.log" && return 0; sleep 0.3; done
  tail -20 "$RUN/kubo-$1.log"; fail "kubo did not start ($1)"
}
sha() { sha256sum "$1" | cut -c1-64; }

echo "== AFTER: production route shape + ipfs-trustless-routes.caddy"
start_caddy after
CHILD="$(head -1 "$RUN/car-children.txt")"; ACID="$(cat "$RUN/adapter-cid.txt")"
r=$(code "/ipfs/bafkqaaa?format=raw" GET "$RUN/probe.bin"); echo "probe GET bafkqaaa: $r, $(stat -c%s "$RUN/probe.bin") bytes"; [ "${r%% *}" = 200 ] && [ "${r##*/}" = 2 ] && [ ! -s "$RUN/probe.bin" ] || fail "probe GET"
r=$(headcode "/ipfs/bafkqaaa?format=raw"); echo "probe HEAD bafkqaaa: $r"; [ "$r" = 200 ] || fail "probe HEAD"
r=$(code "/ipfs/$CHILD?format=raw" GET "$RUN/child.bin"); echo "child block GET $CHILD: $r"; [ "${r%% *}" = 200 ] && cmp -s "$RUN/child.bin" "$RUN/blocks/ipfs/$CHILD" || fail "child GET"
r=$(headcode "/ipfs/$CHILD?format=raw"); echo "child block HEAD: $r"; [ "$r" = 200 ] || fail "child HEAD"
r=$(code "/ipfs/$CHILD" GET "$RUN/child2.bin"); echo "child block by Accept only: $r"; [ "${r%% *}" = 200 ] && cmp -s "$RUN/child2.bin" "$RUN/blocks/ipfs/$CHILD" || fail "child Accept"
r=$(code "/ipfs/$ROOT?format=raw" GET "$RUN/root.bin"); echo "root block: $r"; cmp -s "$RUN/root.bin" "$PKG/site-root.block" || fail "root block"
r=$(curl -sk --http2 -m 30 -o "$RUN/root.car" -w '%{http_code}' "https://$IP:$CPORT/ipfs/$ROOT?format=car"); echo "root CAR (existing route): $r"; [ "$(sha "$RUN/root.car")" = "$(sha "$PKG/site.car")" ] || fail "root CAR"
r=$(code "/ipfs/$ACID?format=raw" GET "$RUN/adapter.bin"); echo "adapter-held CID still falls through to the adapter: $r"; [ "${r%% *}" = 200 ] || fail "adapter fall-through"
r=$(code "/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy?format=raw"); echo "unknown CID: $r (the adapter's 404)"; [ "${r%% *}" = 404 ] || fail "unknown CID"
start_kubo after
t0=$(date +%s)
timeout 300 ipfs get -o "$RUN/got" "/ipfs/$ROOT" > "$RUN/get-after.log" 2>&1; rc=$?
echo "kubo get /ipfs/$ROOT: rc=$rc in $(( $(date +%s) - t0 ))s"; [ $rc = 0 ] || { tail -5 "$RUN/get-after.log"; tail -20 "$RUN/kubo-after.log"; fail "kubo could not fetch the site"; }
ipfs refs -r -u "/ipfs/$ROOT" | sort > "$RUN/kubo-children.txt"
diff -q "$RUN/car-children.txt" "$RUN/kubo-children.txt" > /dev/null || fail "kubo's block set differs from the CAR's"
echo "kubo fetched every block: $(wc -l < "$RUN/kubo-children.txt") children + root, set equal to the CAR's"
diff -r "$RUN/got" "$PKG/site" > "$RUN/files.diff" && echo "files equal the package's site/ ($(find "$RUN/got" -type f | wc -l) files)" || { head "$RUN/files.diff"; fail "files differ"; }
echo "router was asked for: $(sort -u "$RUN/router.log" | wc -l) distinct paths; providers listed for the root only"
kill "$KUBO_PID" "$CADDY_PID" 2>/dev/null; wait "$KUBO_PID" "$CADDY_PID" 2>/dev/null

echo "== BEFORE: production route shape only (today)"
start_caddy before
r=$(code "/ipfs/bafkqaaa?format=raw"); echo "probe GET bafkqaaa: $r"
r=$(code "/ipfs/$CHILD?format=raw"); echo "child block GET: $r"
start_kubo before
t0=$(date +%s)
timeout 90 ipfs cat "/ipfs/$ROOT/index.html" > "$RUN/cat-before.out" 2> "$RUN/cat-before.err"; rc=$?
echo "kubo cat /ipfs/$ROOT/index.html: rc=$rc in $(( $(date +%s) - t0 ))s"
[ $rc != 0 ] || fail "the BEFORE configuration served the site (the test does not discriminate)"
echo "BEFORE fails as the public gateways do"
echo "SERVING-E2E-OK $ROOT"
