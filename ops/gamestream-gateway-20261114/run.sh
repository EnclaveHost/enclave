#!/bin/bash
# Activation of the standalone GameStream gateway on Enclave's four edges (plan.json; README.md says why this form).
# It adds one service and its firewall rules per edge (Sunshine's six ports for everyone, the sibling port for the
# plan's other edges alone) and changes nothing else there: the provider's release, configuration, keys and service
# are not read or touched (network/wg-provider/gamestream-gateway-install.sh).
#
#   bash run.sh preflight [edge...]   read-only: this checkout builds the planned bundle; each edge is ready for it
#   bash run.sh activate  [edge...]   one edge at a time: preflight, install (a gateway already there is replaced),
#                                     verify on the edge and from here; an edge already verified with the planned
#                                     bundle and siblings is skipped; the first failure stops the run. Run over the
#                                     whole plan it ends with `links` and `check`
#   bash run.sh check     [edge...]   read-only, no ssh: the gateway as the internet sees it from this machine; with
#                                     more than one edge, also a client that names the app at one and not at the other
#   bash run.sh links     [edge...]   read-only: each edge asks each of its siblings one question on the sibling port
#   bash run.sh status    [edge...]   read-only: service, bundle, configuration, listeners and rules on each edge
#   bash run.sh revert    [edge...]   removes the service, its files and its rules from each edge
#
# Evidence goes to activation/<edge>.{preflight.txt,result.txt,verified.json,reverted.txt} and activation/final.txt.
# No file here holds a secret.
# GSGW_PLAN and GSGW_EVIDENCE name another plan and evidence directory (rehearse.sh uses them; an activation does not).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
PLAN=${GSGW_PLAN:-$HERE/plan.json} ACT=${GSGW_EVIDENCE:-$HERE/activation} INSTALLER=$ROOT/network/wg-provider/gamestream-gateway-install.sh
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=12) SCP=(scp -q -o BatchMode=yes -o ConnectTimeout=12)
UNIT=enclave-gamestream-gateway
say() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
die() { say "STOP: $*" >&2; exit 1; }
field() { node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(process.argv[2].split(".").reduce((o,k)=>o[k],p)))' "$PLAN" "$1"; }
address_of() { node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const e=p.edges.find(e=>e.alias===process.argv[2]);if(!e)process.exit(1);process.stdout.write(e.address)' "$PLAN" "$1"; }
# the addresses of an edge's siblings: the plan's other edges
others_of() { node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(p.edges.filter(e=>e.alias!==process.argv[2]).map(e=>e.address).join(" "))' "$PLAN" "$1"; }
SHA=$(field bundle.sha256) APP=$(field probeApp)
[[ $SHA =~ ^[0-9a-f]{64}$ && $APP =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || die "plan.json is not readable"
SIBPORT=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!p.edges.every(e=>/^[a-z0-9-]+$/.test(e.alias)&&/^\d{1,3}(\.\d{1,3}){3}$/.test(e.address)))process.exit(1);process.stdout.write(String(p.config.siblingPort??47997))' "$PLAN") && [[ $SIBPORT =~ ^[0-9]{4,5}$ ]] || die "plan.json: edges or sibling port are not readable"
CMD=${1:-}; shift || true
case "$CMD" in preflight|activate|check|links|status|revert) ;; *) sed -n '2,20p' "$0" >&2; exit 2 ;; esac
if [ $# -gt 0 ]; then EDGES=("$@"); else mapfile -t EDGES < <(node -e 'for(const e of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).edges)console.log(e.alias)' "$PLAN"); fi
for e in "${EDGES[@]}"; do [[ $e =~ ^[a-z0-9-]+$ ]] && address_of "$e" >/dev/null || die "$e is not an edge of plan.json"; done
mkdir -p "$ACT"

BUILD=""
build() {
  BUILD=$(mktemp -d "${TMPDIR:-/tmp}/enclave-gsgw-build.XXXXXX"); trap 'rm -rf "${BUILD:?}"' EXIT
  (cd "$ROOT" && node scripts/network/build-gamestream-gateway.mjs "$BUILD" >/dev/null) || die "the bundle does not build in this checkout"
  local got; got=$(sha256sum "$BUILD/gamestream-gateway.mjs" | cut -d' ' -f1)
  [ "$got" = "$SHA" ] || die "this checkout builds $got, the plan is $SHA: check out the planned source, or review and update plan.json"
  say "bundle $SHA built from this checkout"
}

# read-only facts of one edge -> stdout (no configuration or key file is read)
facts() {
  timeout 60 "${SSH[@]}" "$1" "bash -s $SIBPORT" <<'REMOTE'
echo "host: $(hostname)"
echo "node: $(command -v node || echo none) $(node --version 2>/dev/null || true)"
echo "addresses: $(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')"
echo "provider: $(systemctl is-active enclave-network-provider || true) $(systemctl show enclave-network-provider -p MainPID -p ActiveEnterTimestamp | tr '\n' ' ')"
echo "memavailable_mb: $(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"
echo "ufw: $(ufw status 2>/dev/null | sed -n 1p)"
echo "gateway: $(systemctl is-active enclave-gamestream-gateway 2>/dev/null || true)"
echo "listeners: $( { for p in 47984 47989 48010; do ss -H -ltn "sport = :$p"; done; for p in 47998 47999 48000; do ss -H -lun "sport = :$p"; done; } | awk '{print $1 "/" $4}' | tr '\n' ' ')"
echo "siblingport: $(ss -H -ltn "sport = :$1" | awk '{print $1 "/" $4}' | tr '\n' ' ')"
echo "siblings: $(cat "${ENCLAVE_NETWORK_ROOT:-}/etc/enclave-gamestream-gateway/siblings" 2>/dev/null | wc -l)"
REMOTE
}
fact() { sed -n "s/^$2: //p" <<<"$1"; }
preflight() {
  local edge=$1 addr=$2 f
  f=$(facts "$edge") || die "$edge: cannot read the edge over ssh"
  printf '%s\n' "$f" > "$ACT/$edge.preflight.txt"
  grep -qw -- "$addr" <<<"$(fact "$f" addresses)" || die "$edge: $addr is not an address of this box ($(fact "$f" addresses))"
  [[ $(fact "$f" node) =~ \ v(2[0-9]|[3-9][0-9])\. ]] || die "$edge: node 20+ not found ($(fact "$f" node))"
  [[ $(fact "$f" provider) == active\ * ]] || die "$edge: the provider is not active; not adding anything beside it now"
  [ "$(fact "$f" memavailable_mb)" -ge 150 ] || die "$edge: only $(fact "$f" memavailable_mb) MB of memory available (150 wanted)"
  [[ $(fact "$f" ufw) == "Status: active" ]] || die "$edge: ufw is not active ($(fact "$f" ufw)); the plan assumes it"
  if [ "$(fact "$f" gateway)" != active ] && [ -n "$(fact "$f" listeners | tr -d ' ')" ]; then die "$edge: Sunshine's ports are already in use: $(fact "$f" listeners)"; fi
  # the sibling port is free, or held by a gateway that was installed with siblings
  if [ -n "$(fact "$f" siblingport | tr -d ' ')" ] && { [ "$(fact "$f" gateway)" != active ] || [ "$(fact "$f" siblings)" = 0 ]; }; then die "$edge: the sibling port $SIBPORT is already in use: $(fact "$f" siblingport)"; fi
  say "$edge: ready ($(fact "$f" host), node$(fact "$f" node | sed 's/.* / /'), $(fact "$f" memavailable_mb) MB available, gateway $(fact "$f" gateway))"
  PROVIDER=$(fact "$f" provider)
}

# the gateway as this machine sees it; prints what it found, fails on what a client could not use
external() {
  local edge=$1 addr=$2 code rc routed tmp heard
  # no name, no binding: the connection is accepted and closed with nothing sent (curl 52). 200 means this machine's
  # address is still bound from a probe in the last ten minutes, here or at a sibling. An edge that took the name from
  # a sibling but does not route the app closes too, only after its router gave up on the name (ten seconds on the
  # 2026-11-14 edges), so this waits longer than that.
  set +e; code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "http://$addr:47989/serverinfo"); rc=$?; set -e
  case "$rc/$code" in
    52/*) say "$edge: 47989 without a name: closed, nothing sent (as designed)" ;;
    0/200) say "$edge: 47989 without a name: answered (this machine is bound from an earlier probe)" ;;
    7/*) say "$edge: 47989 refused: nothing listens on $addr, or a firewall rejects it"; return 1 ;;
    28/*) say "$edge: 47989 timed out: dropped on the way. Before an install that is ufw; after one, a firewall in front of the box (a cloud firewall is not ufw)"; return 1 ;;
    *) say "$edge: 47989 without a name: unexpected (curl $rc, HTTP $code)"; return 1 ;;
  esac
  for port in 47984 48010; do
    timeout 8 bash -c "exec 3<>/dev/tcp/$addr/$port" 2>/dev/null || { say "$edge: TCP $port does not connect from here"; return 1; }
  done
  say "$edge: TCP 47984 and 48010 connect"
  # the sibling port is for siblings: this machine gets no answer there, from the box's firewall or from the gateway
  heard=$(timeout 4 bash -c "exec 3<>/dev/tcp/$addr/$SIBPORT && printf 'enclave-gs-binding/1 192.0.2.1\n' >&3 && head -c 80 <&3" 2>/dev/null || true)
  [ -z "$heard" ] || { say "$edge: the sibling port $SIBPORT answered this machine, which is no sibling"; return 1; }
  say "$edge: the sibling port $SIBPORT gives this machine nothing"
  # the named path, where this edge holds the probe app's route (its 443 answers under that name)
  routed=$(curl -s -o /dev/null -m 12 -w '%{http_code}' --resolve "$APP:443:$addr" "https://$APP/" || true)
  if [ "$routed" = 000 ]; then say "$edge: $APP is not routed through this edge: the named path is not exercised here"; NAMED="not routed here"; return 0; fi
  tmp=$(mktemp "${TMPDIR:-/tmp}/enclave-gsgw-probe.XXXXXX"); code=$(curl -s -o "$tmp" -m 20 -w '%{http_code}' --connect-to "$APP:47989:$addr:47989" "http://$APP:47989/serverinfo" || true)
  if [ "$code" = 200 ] && grep -q '<state>SUNSHINE_SERVER_' "$tmp"; then
    NAMED="200 $(grep -o '<state>[A-Z_]*</state>' "$tmp" | sed 's/<[^>]*>//g')"; rm -f "${tmp:?}"
    say "$edge: $APP:47989/serverinfo through this edge: $NAMED"; return 0
  fi
  rm -f "${tmp:?}"; say "$edge: $APP is routed here (443 answers $routed) but serverinfo on 47989 gave HTTP $code. Is the desktop started on the app's page?"; return 1
}

# A client whose lookups of the app's name land on two edges: it names the app at one (A) and comes without a name to
# the other (B). This machine first names another app at B, one that does not exist, so that an answer without a name
# there afterwards can only be what B learned from A.
split() {
  local be=$1 b=$2 ae=$3 a=$4 other="gsgw-split-check.${APP#*.}" code tmp
  curl -s -o /dev/null -m 8 --connect-to "$other:47989:$b:47989" "http://$other:47989/serverinfo" || true
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://$b:47989/serverinfo" || true)
  [ "$code" != 200 ] || { say "named at $ae, no name at $be: $be answered while this machine was bound there to a name without an app; not a usable test"; return 1; }
  sleep 6   # a box asks its siblings again once the name it was given itself is five seconds old
  curl -s -o /dev/null -m 8 --connect-to "$APP:47989:$a:47989" "http://$APP:47989/serverinfo" || true
  tmp=$(mktemp "${TMPDIR:-/tmp}/enclave-gsgw-probe.XXXXXX"); code=$(curl -s -o "$tmp" -m 15 -w '%{http_code}' "http://$b:47989/serverinfo" || true)
  if [ "$code" = 200 ] && grep -q '<state>SUNSHINE_SERVER_' "$tmp"; then rm -f "${tmp:?}"; say "named at $ae, no name at $be: carried (200)"; return 0; fi
  rm -f "${tmp:?}"; say "named at $ae, no name at $be: NOT carried (HTTP $code): $be did not take the name from $ae"; return 1
}
# every edge from here, then every pair (A, B) whose B routes the probe app
declare -A ROUTED=()
check_all() {
  local bad=0 n=0 e a b
  for e in "${EDGES[@]}"; do NAMED=""; if external "$e" "$(address_of "$e")"; then ROUTED[$e]=$NAMED; else bad=1; fi; done
  [ $bad = 0 ] || return 1
  [ ${#EDGES[@]} -gt 1 ] || return 0
  for b in "${EDGES[@]}"; do
    [[ ${ROUTED[$b]} == 200* ]] || continue
    for a in "${EDGES[@]}"; do [ "$a" = "$b" ] || { n=$((n+1)); split "$b" "$(address_of "$b")" "$a" "$(address_of "$a")" || bad=1; }; done
  done
  [ $n -gt 0 ] || say "no edge here routes $APP: a client split over two edges is not exercised"
  [ $bad = 0 ]
}
# one edge asks each of its siblings, from its own address, about a client nobody has seen: "-" is the answer
links() {
  local edge=$1 addr=$2 others; others=$(others_of "$edge")
  [ -n "$others" ] || { say "$edge: the plan gives it no sibling"; return 0; }
  timeout 40 "${SSH[@]}" "$edge" "node - $addr $SIBPORT $others" <<'JS'
const net=require('net'),[host,port,...sibs]=process.argv.slice(2);let bad=0,left=sibs.length;
for(const s of sibs){
 let got='';const c=net.connect({host:s,port:+port,localAddress:host});c.setTimeout(4000,()=>c.destroy());
 c.on('connect',()=>c.write('enclave-gs-binding/1 192.0.2.1\n'));c.on('data',d=>{got+=d;});c.on('error',()=>{});
 c.on('close',()=>{const ok=/^(-|\S+ \d+)\n$/.test(got);if(!ok)bad=1;console.log(`    ${host} asks ${s}: ${ok?'answered':'NO ANSWER'}`);if(!--left)process.exit(bad);});
}
JS
}
links_all() { local bad=0 e; for e in "${EDGES[@]}"; do links "$e" "$(address_of "$e")" || bad=1; done; [ $bad = 0 ]; }

activate() {
  local edge=$1 addr=$2 stage cfg after rc others n
  others=$(others_of "$edge"); n=$(wc -w <<<"$others")
  if [ -f "$ACT/$edge.verified.json" ]; then
    if [ "$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(v.bundleSha256+" "+(v.siblings||[]).join(" "))' "$ACT/$edge.verified.json")" = "$SHA $others" ]; then say "$edge: already verified, skipped"; return 0; fi
    say "$edge: verified with another bundle or other siblings: replacing that install"
  fi
  preflight "$edge" "$addr"; local before=$PROVIDER
  cfg=$BUILD/$edge.config.json
  node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")),host=process.argv[2];const {zones,router,...caps}=p.config;process.stdout.write(JSON.stringify({zones,router,host,...caps,siblings:p.edges.map(e=>e.address).filter(a=>a!==host)})+"\n")' "$PLAN" "$addr" > "$cfg"
  node "$BUILD/gamestream-gateway.mjs" --check-config "$cfg" >/dev/null || die "$edge: the planned configuration is rejected by the bundle"
  stage=$(timeout 30 "${SSH[@]}" "$edge" 'mktemp -d /root/enclave-gsgw-stage.XXXXXX') && [[ $stage =~ ^/root/enclave-gsgw-stage\.[A-Za-z0-9]{6}$ ]] || die "$edge: no staging directory"
  timeout 60 "${SCP[@]}" "$BUILD/gamestream-gateway.mjs" "$INSTALLER" "$edge:$stage/" && timeout 60 "${SCP[@]}" "$cfg" "$edge:$stage/config.json" || die "$edge: copying to $stage failed (nothing installed; the directory can be removed)"
  say "$edge: installing"
  # the staging directory's name was checked above: /root/enclave-gsgw-stage.XXXXXX and nothing else
  set +e
  timeout 120 "${SSH[@]}" "$edge" "bash $stage/gamestream-gateway-install.sh install $stage/gamestream-gateway.mjs $SHA $stage/config.json; rc=\$?; rm -rf -- $stage; exit \$rc" > "$ACT/$edge.result.txt" 2>&1; rc=$?
  set -e
  sed 's/^/    /' "$ACT/$edge.result.txt"
  [ $rc = 0 ] || die "$edge: the install failed (exit $rc); the installer removes what it added. See activation/$edge.result.txt"
  after=$(timeout 30 "${SSH[@]}" "$edge" "systemctl is-active enclave-network-provider; systemctl show enclave-network-provider -p MainPID -p ActiveEnterTimestamp; journalctl -u $UNIT -n 20 --no-pager -o cat | grep -F 'gamestream gateway: $addr TCP 47984, 47989, 48010 and UDP 47998, 47999, 48000' | tail -1; journalctl -u $UNIT -n 20 --no-pager -o cat | grep -F 'gamestream gateway: asks ' | tail -1; systemctl show $UNIT -p MemoryCurrent" | tr '\n' ' ') || die "$edge: cannot read the edge after the install"
  [[ $after == "$before"* ]] || die "$edge: the provider restarted during the install (before: $before / after: $after). The installer does not touch it; look before going on"
  [[ $after == *"gamestream gateway: $addr TCP"* ]] || die "$edge: the gateway's start line is not in its journal"
  [ "$n" = 0 ] || [[ $after == *"gamestream gateway: asks $n sibling(s) on TCP $SIBPORT"* ]] || die "$edge: the gateway does not say that it asks its $n sibling(s) on TCP $SIBPORT"
  say "$edge: provider unchanged ($before); gateway up, asking $n sibling(s), $(sed -n 's/.*MemoryCurrent=\([0-9]*\).*/\1/p' <<<"$after" | awk '{printf "%d MB", $1/1048576}')"
  NAMED=""; external "$edge" "$addr" || die "$edge: installed and listening on the edge, but not usable from here (above). 'revert $edge' removes it"
  node -e 'const [edge,address,sha256,provider,named,port,others]=process.argv.slice(1);process.stdout.write(JSON.stringify({edge,address,bundleSha256:sha256,siblings:others.split(" ").filter(Boolean),siblingPort:+port,verifiedAt:new Date().toISOString(),providerUnchanged:provider.trim(),namedProbe:named},null,1)+"\n")' "$edge" "$addr" "$SHA" "$before" "$APP: $NAMED" "$SIBPORT" "$others" > "$ACT/$edge.verified.json"
  rm -f "${ACT:?}/${edge:?}.reverted.txt"
  say "$edge: VERIFIED"
}

case "$CMD" in
  preflight) build; for e in "${EDGES[@]}"; do preflight "$e" "$(address_of "$e")"; done; say "preflight passed for: ${EDGES[*]}" ;;
  activate)
    build
    for e in "${EDGES[@]}"; do activate "$e" "$(address_of "$e")"; done
    if [ ${#EDGES[@]} -gt 1 ] && [ ${#EDGES[@]} = "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).edges.length)' "$PLAN")" ]; then
      # together: every edge reaches its siblings, and a client split over two edges is carried
      say "all of them together"
      { links_all && check_all; } 2>&1 | tee "$ACT/final.txt" || die "each edge was installed and verified, but together they do not carry a client (above, and activation/final.txt). Nothing was removed"
    else say "not the whole plan: run 'links' and 'check' once every edge is done"; fi
    say "ALL DONE: gateway verified on ${EDGES[*]}" ;;
  check) check_all || die "not every edge is usable from here"; say "check passed for: ${EDGES[*]}" ;;
  links) links_all || die "not every edge reaches its siblings"; say "links answered for: ${EDGES[*]}" ;;
  status)
    for e in "${EDGES[@]}"; do echo "== $e"; timeout 60 "${SSH[@]}" "$e" 'bash -s status' < "$INSTALLER" || die "$e: cannot read the edge"; done ;;
  revert)
    for e in "${EDGES[@]}"; do
      say "$e: removing"
      timeout 120 "${SSH[@]}" "$e" 'bash -s remove' < "$INSTALLER" > "$ACT/$e.reverted.txt" 2>&1 || { sed 's/^/    /' "$ACT/$e.reverted.txt"; die "$e: the removal failed"; }
      sed 's/^/    /' "$ACT/$e.reverted.txt"; rm -f "${ACT:?}/${e:?}.verified.json"
    done
    say "reverted: ${EDGES[*]}" ;;
esac
