#!/bin/bash
# One hop on the edges: the provider and the public directory of each edge, replaced by this release's builds.
# The operator runs activate and revert; status, preflight and check only read.
#
#   one-hop-edges.sh status    [edge...]   what each edge runs (read only)
#   one-hop-edges.sh preflight [edge...]   the payload here and every guard on each edge (read only)
#   one-hop-edges.sh activate  [edge...]   one edge at a time: directory, then provider, each taken back by the
#                                          installer when it does not come up; the first failure stops the run
#   one-hop-edges.sh check     [edge...]   both services on this release's builds, and the apps' names (read only)
#   one-hop-edges.sh revert    [edge...]   the previous builds again (refused while a host is a peer with no guard,
#                                          unless FORCE=1)
#
# Edges, in the order used when none is named: eu-central ca-east us-west ap-southeast (fewest exit peers first; the
# edge with the other provider build second). An edge's address is read from the ssh configuration and is neither
# printed nor written. Evidence: activation/<edge>.{preflight.txt,result.txt,verified.json,reverted.txt}.
# WORK is the folder with payload/<first 8 of the SHA-256>/<file>; WATCH the seconds a new provider is watched (300).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=${WORK:-/home/steven/Documents/Codex/2026-10-23/it/work/one-hop-20261115}
INSTALLER=$HERE/one-hop-edge-install.sh
ACT=$HERE/activation
WATCH=${WATCH:-300}
ALL=(eu-central ca-east us-west ap-southeast)
# public names of apps on the two fleet hosts: each answers only through the edges that are its exits
PROBES=${PROBES:-38f368d6 59f1273d 7ae476a3 9a28642b a69dcbba a77d0c57 c13d4b6a d9798e4c ef514ed3 5ff56a4d}
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=12 -o ServerAliveInterval=15)
SCP=(scp -q -o BatchMode=yes -o ConnectTimeout=12)
say() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
die() { say "STOP: $*" >&2; exit 1; }
mask() { sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/(addr)/g'; }

CMD=${1:-}; shift || true
case "$CMD" in status|preflight|activate|check|revert) ;; *) sed -n '2,17p' "$0"; exit 2 ;; esac
EDGES=("$@"); [ ${#EDGES[@]} -gt 0 ] || EDGES=("${ALL[@]}")
for e in "${EDGES[@]}"; do [[ " ${ALL[*]} " == *" $e "* ]] || die "$e is not one of: ${ALL[*]}"; done
mkdir -p "$ACT"

address_of() { local a; a=$(ssh -G "$1" 2>/dev/null | awk '$1=="hostname"{print $2}'); [[ $a =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$1: the ssh configuration gives no address"; echo "$a"; }
read_edge() { timeout 90 "${SSH[@]}" "$1" 'bash -s -- status' < "$INSTALLER" 2>&1 | mask; }
# the release's files, as the installer names them: "<installed SHA-256>:<this release's SHA-256>:<file>"
pairs() { grep -o '[0-9a-f]\{64\}:[0-9a-f]\{64\}:[a-z.-]*' "$INSTALLER"; }
payload() {
  local p new name f n=0
  for p in $(pairs); do
    new=$(cut -d: -f2 <<<"$p"); name=$(cut -d: -f3 <<<"$p"); f=$WORK/payload/${new:0:8}/$name
    [ -f "$f" ] || die "$f is not there"
    [ "$(sha256sum "$f" | cut -d' ' -f1)" = "$new" ] || die "$f is not this release's file"
    node --check "$f" || die "$f does not parse"
    FILES+=("$f"); n=$((n + 1))
  done
  [ $n = 3 ] || die "the installer names $n files, not 3"
}
# names that answer through this edge now, as "name=code ..."; 000 is no answer
probe() {
  local addr=$1 n code out=""
  for n in $PROBES; do
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' --resolve "$n.app.enclave.host:443:$addr" "https://$n.app.enclave.host/" || true)
    [ "$code" = 000 ] || out+="$n=$code "
  done
  echo "${out% }"
}
# every name of $1 answers through the edge again, or at least by its public name; waits up to three minutes
names_back() {
  local edge=$1 addr=$2 before=$3 now n i missing=""
  for i in $(seq 18); do
    now=" $(probe "$addr") "; missing=""
    for n in $before; do [[ $now == *" ${n%%=*}="* ]] || missing+="${n%%=*} "; done
    [ -n "$missing" ] || { AFTER=${now# }; AFTER=${AFTER% }; return 0; }
    sleep 10
  done
  AFTER=${now# }; AFTER=${AFTER% }
  for n in $missing; do
    [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$n.app.enclave.host/" || true)" != 000 ] \
      || die "$edge: $n.app.enclave.host answered through this edge before and answers nowhere now. The new builds stay; 'revert $edge' puts the previous ones back"
    say "$edge: $n.app.enclave.host no longer answers through this edge but answers by its name (its host moved that circuit)"
  done
}
preflight() {
  local edge=$1 out; out=$(read_edge "$edge") || die "$edge: cannot read the edge"
  printf '%s\n' "$out" > "$ACT/$edge.preflight.txt"
  local s; for s in directory provider; do
    grep -Eq "^$s: unit active" <<<"$out" || die "$edge: the $s unit is not active"
    grep -Eq "^$s: bundle (old|new) " <<<"$out" || die "$edge: the $s runs a build this release was not made from ($(grep "^$s: bundle" <<<"$out"))"
    grep -q "^$s: process runs the unit's command: yes" <<<"$out" || die "$edge: the $s process is not the one its unit names"
    grep -q "^$s: answers: yes" <<<"$out" || die "$edge: the $s does not answer"
  done
  [[ $(sed -n 's/^box: node v\([0-9]*\)\..*/\1/p' <<<"$out") -ge 20 ]] || die "$edge: node is older than 20"
  [[ $(sed -n 's/^box: .*free under \/opt: \([0-9]*\) MB.*/\1/p' <<<"$out") -ge 50 ]] || die "$edge: less than 50 MB free under /opt"
  egress_of "$edge" "$out"
  STATE="directory $(sed -n 's/^directory: bundle \([a-z]*\) .*/\1/p' <<<"$out"), provider $(sed -n 's/^provider: bundle \([a-z]*\) .*/\1/p' <<<"$out")"
  say "$edge: preflight passed ($STATE; $(sed -n 's/^provider: answers: yes (\(.*\))$/\1/p' <<<"$out"))"
}
# A guard forwards a host's request to the exit from its uplink address. The exit takes that request for a guard's
# only when the address is a listed provider's: so every edge must leave from the address it is listed under.
egress_of() {
  local edge=$1 out=$2 m
  grep -q '^box: listed in its own directory under the address the provider reports: yes' <<<"$out" || die "$edge: not listed in its own directory under the address its provider reports"
  m=$(sed -n 's/^box: source address toward the other listed providers is that address: \([0-9]* of [0-9]*\)$/\1/p' <<<"$out")
  [ -n "$m" ] && [ "${m%% *}" = "${m##* }" ] && [ "${m%% *}" -gt 0 ] || die "$edge: its requests to the other providers do not leave from its listed address (${m:-not read}). As a guard it would look like a host to an exit on this release: do not install anywhere"
}
is_new() { grep -q '^directory: bundle new ' <<<"$1" && grep -q '^provider: bundle new ' <<<"$1" && grep -q '^provider: answers: yes (accepting, .*direct peers [0-9]' <<<"$1"; }
stage_to() {
  local edge=$1; shift
  STAGE=$(timeout 30 "${SSH[@]}" "$edge" 'mktemp -d /root/enclave-one-hop-stage.XXXXXX') && [[ $STAGE =~ ^/root/enclave-one-hop-stage\.[A-Za-z0-9]{6}$ ]] || die "$edge: no staging directory"
  timeout 120 "${SCP[@]}" "$@" "$edge:$STAGE/" || die "$edge: copying to $STAGE failed (nothing installed; the directory stays there, empty or partly filled)"
}
activate() {
  local edge=$1 addr before out rc
  addr=$(address_of "$edge")
  out=$(read_edge "$edge") || die "$edge: cannot read the edge"
  if [ -f "$ACT/$edge.verified.json" ] && is_new "$out"; then say "$edge: already verified on this release, left alone"; return 0; fi
  preflight "$edge"
  before=$(probe "$addr"); say "$edge: answering through this edge now: ${before:-none of the probed names}"
  stage_to "$edge" "${FILES[@]}" "$INSTALLER"
  say "$edge: installing (directory about 40 s; provider about $((WATCH + 60)) s, of which $WATCH s watching for requests refused as a host's own)"
  # the staging directory's name was checked above: /root/enclave-one-hop-stage.XXXXXX and nothing else
  set +e
  timeout $((WATCH + 400)) "${SSH[@]}" "$edge" "WATCH=$WATCH bash $STAGE/one-hop-edge-install.sh install $STAGE directory provider; rc=\$?; rm -rf -- ${STAGE:?}; exit \$rc" 2>&1 | mask | tee "$ACT/$edge.result.txt" | sed 's/^/    /'; rc=${PIPESTATUS[0]}
  set -e
  [ "$rc" = 0 ] || die "$edge: the install did not finish (exit $rc). A line starting REVERTED or STOP above says where it stands; with neither, the installer went on alone on the edge (it ignores a lost session): read /var/log/enclave-one-hop.log there, then 'status $edge'"
  out=$(read_edge "$edge") || die "$edge: installed, but the edge cannot be read now"
  is_new "$out" || die "$edge: the installer finished, but status does not show both services on this release's builds ('status $edge')"
  AFTER=""; names_back "$edge" "$addr" "$before"
  node -e 'const [edge,at,before,after,dir,prov,peers]=process.argv.slice(1);const names=s=>s.split(" ").filter(Boolean);process.stdout.write(JSON.stringify({edge,verifiedAt:at,directoryBundle:dir,providerBundle:prov,provider:peers,answeredThroughThisEdgeBefore:names(before),answeredThroughThisEdgeAfter:names(after)},null,2)+"\n")' \
    "$edge" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$before" "$AFTER" "$(sed -n 's/^directory: bundle new \([0-9a-f]*\) .*/\1/p' <<<"$out")" "$(sed -n 's/^provider: bundle new \([0-9a-f]*\) .*/\1/p' <<<"$out")" "$(sed -n 's/^provider: answers: yes (\(.*\))$/\1/p' <<<"$out")" > "$ACT/$edge.verified.json"
  rm -f "${ACT:?}/${edge:?}.reverted.txt"
  say "$edge: VERIFIED (answering through this edge: ${AFTER:-none of the probed names})"
}
check() {
  local edge=$1 out; out=$(read_edge "$edge") || die "$edge: cannot read the edge"
  is_new "$out" || { grep '^[a-z]*: \(bundle\|answers\)' <<<"$out" | sed 's/^/    /'; return 1; }
  say "$edge: both on this release ($(sed -n 's/^provider: answers: yes (\(.*\))$/\1/p' <<<"$out"); refused as a host's own: $(sed -n "s/^provider: refused as a host's own since this process started: //p" <<<"$out")); answering through it: $(probe "$(address_of "$edge")")"
}
revert() {
  local edge=$1 rc
  stage_to "$edge" "$INSTALLER"
  say "$edge: putting the previous builds back (provider, then directory)"
  set +e
  timeout 300 "${SSH[@]}" "$edge" "FORCE=${FORCE:-0} bash $STAGE/one-hop-edge-install.sh remove provider directory; rc=\$?; rm -rf -- ${STAGE:?}; exit \$rc" 2>&1 | mask | tee "$ACT/$edge.reverted.txt" | sed 's/^/    /'; rc=${PIPESTATUS[0]}
  set -e
  [ "$rc" = 0 ] || die "$edge: the removal did not finish (exit $rc; above, and /var/log/enclave-one-hop.log on the edge)"
  rm -f "${ACT:?}/${edge:?}.verified.json"
}

case "$CMD" in
  status) for e in "${EDGES[@]}"; do echo "== $e"; read_edge "$e" || die "$e: cannot read the edge"; done ;;
  preflight) FILES=(); payload; say "payload: 3 files, as the installer names them"
    for e in "${EDGES[@]}"; do preflight "$e"; done; say "preflight passed for: ${EDGES[*]}" ;;
  activate) FILES=(); payload
    # every edge, also the ones not named: each is a guard in front of the exits installed here
    for e in "${ALL[@]}"; do out=$(read_edge "$e") || die "$e: cannot read the edge"; egress_of "$e" "$out"; done
    say "all four edges leave from the address they are listed under"
    for e in "${EDGES[@]}"; do activate "$e"; done
    say "ALL DONE: one-hop builds verified on ${EDGES[*]}" ;;
  check) bad=0; for e in "${EDGES[@]}"; do check "$e" || { say "$e: NOT on this release"; bad=1; }; done
    [ $bad = 0 ] || die "not every edge is on this release"; say "check passed for: ${EDGES[*]}" ;;
  revert) for e in "${EDGES[@]}"; do revert "$e"; done; say "reverted: ${EDGES[*]}" ;;
esac
