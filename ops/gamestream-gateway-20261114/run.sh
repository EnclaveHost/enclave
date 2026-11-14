#!/bin/bash
# Activation of the standalone GameStream gateway on Enclave's four edges (plan.json; README.md says why this form).
# It adds one service and six firewall rules per edge and changes nothing else there: the provider's release,
# configuration, keys and service are not read or touched (network/wg-provider/gamestream-gateway-install.sh).
#
#   bash run.sh preflight [edge...]   read-only: this checkout builds the planned bundle; each edge is ready for it
#   bash run.sh activate  [edge...]   one edge at a time: preflight, install, verify on the edge and from here;
#                                     an edge already verified is skipped; the first failure stops the run
#   bash run.sh check     [edge...]   read-only, no ssh: the gateway as the internet sees it from this machine
#   bash run.sh status    [edge...]   read-only: service, bundle, configuration, listeners and rules on each edge
#   bash run.sh revert    [edge...]   removes the service, its files and its six rules from each edge
#
# Evidence goes to activation/<edge>.{preflight.txt,result.txt,verified.json,reverted.txt}. No file here holds a secret.
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
SHA=$(field bundle.sha256) APP=$(field probeApp)
[[ $SHA =~ ^[0-9a-f]{64}$ && $APP =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || die "plan.json is not readable"
CMD=${1:-}; shift || true
case "$CMD" in preflight|activate|check|status|revert) ;; *) sed -n '2,14p' "$0" >&2; exit 2 ;; esac
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
  timeout 60 "${SSH[@]}" "$1" 'bash -s' <<'REMOTE'
echo "host: $(hostname)"
echo "node: $(command -v node || echo none) $(node --version 2>/dev/null || true)"
echo "addresses: $(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')"
echo "provider: $(systemctl is-active enclave-network-provider || true) $(systemctl show enclave-network-provider -p MainPID -p ActiveEnterTimestamp | tr '\n' ' ')"
echo "memavailable_mb: $(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"
echo "ufw: $(ufw status 2>/dev/null | sed -n 1p)"
echo "gateway: $(systemctl is-active enclave-gamestream-gateway 2>/dev/null || true)"
echo "listeners: $( { for p in 47984 47989 48010; do ss -H -ltn "sport = :$p"; done; for p in 47998 47999 48000; do ss -H -lun "sport = :$p"; done; } | awk '{print $1 "/" $4}' | tr '\n' ' ')"
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
  say "$edge: ready ($(fact "$f" host), node$(fact "$f" node | sed 's/.* / /'), $(fact "$f" memavailable_mb) MB available, gateway $(fact "$f" gateway))"
  PROVIDER=$(fact "$f" provider)
}

# the gateway as this machine sees it; prints what it found, fails on what a client could not use
external() {
  local edge=$1 addr=$2 code rc routed tmp
  # no name, no binding: the connection is accepted and closed with nothing sent (curl 52). 200 means this machine's
  # address is still bound from a probe in the last ten minutes.
  set +e; code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://$addr:47989/serverinfo"); rc=$?; set -e
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

activate() {
  local edge=$1 addr=$2 stage cfg after rc
  if [ -f "$ACT/$edge.verified.json" ]; then say "$edge: already verified, skipped"; return 0; fi
  preflight "$edge" "$addr"; local before=$PROVIDER
  cfg=$BUILD/$edge.config.json
  node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const {zones,router,...caps}=p.config;process.stdout.write(JSON.stringify({zones,router,host:process.argv[2],...caps})+"\n")' "$PLAN" "$addr" > "$cfg"
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
  after=$(timeout 30 "${SSH[@]}" "$edge" "systemctl is-active enclave-network-provider; systemctl show enclave-network-provider -p MainPID -p ActiveEnterTimestamp; journalctl -u $UNIT -n 20 --no-pager -o cat | grep -F 'gamestream gateway: $addr TCP 47984, 47989, 48010 and UDP 47998, 47999, 48000' | tail -1; systemctl show $UNIT -p MemoryCurrent" | tr '\n' ' ') || die "$edge: cannot read the edge after the install"
  [[ $after == "$before"* ]] || die "$edge: the provider restarted during the install (before: $before / after: $after). The installer does not touch it; look before going on"
  [[ $after == *"gamestream gateway: $addr TCP"* ]] || die "$edge: the gateway's start line is not in its journal"
  say "$edge: provider unchanged ($before); gateway up, $(sed -n 's/.*MemoryCurrent=\([0-9]*\).*/\1/p' <<<"$after" | awk '{printf "%d MB", $1/1048576}')"
  NAMED=""; external "$edge" "$addr" || die "$edge: installed and listening on the edge, but not usable from here (above). 'revert $edge' removes it"
  node -e 'const [edge,address,sha256,provider,named]=process.argv.slice(1);process.stdout.write(JSON.stringify({edge,address,bundleSha256:sha256,verifiedAt:new Date().toISOString(),providerUnchanged:provider.trim(),namedProbe:named},null,1)+"\n")' "$edge" "$addr" "$SHA" "$before" "$APP: $NAMED" > "$ACT/$edge.verified.json"
  rm -f "${ACT:?}/${edge:?}.reverted.txt"
  say "$edge: VERIFIED"
}

case "$CMD" in
  preflight) build; for e in "${EDGES[@]}"; do preflight "$e" "$(address_of "$e")"; done; say "preflight passed for: ${EDGES[*]}" ;;
  activate)
    build
    for e in "${EDGES[@]}"; do activate "$e" "$(address_of "$e")"; done
    say "ALL DONE: gateway verified on ${EDGES[*]}" ;;
  check)
    bad=0; for e in "${EDGES[@]}"; do NAMED=""; external "$e" "$(address_of "$e")" || bad=1; done
    [ $bad = 0 ] || die "not every edge is usable from here"; say "check passed for: ${EDGES[*]}" ;;
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
