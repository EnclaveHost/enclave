#!/bin/bash
# The remembered signer recovery on the edges' providers (README.md).
#
#   signers-edges.sh status   [edge...]   what each edge's provider runs (read only)
#   signers-edges.sh activate [edge...]   one edge at a time: the provider on this release's bundle; taken back by the
#                                         installer when it does not come up; the first failure stops the run
#   signers-edges.sh revert   [edge...]   the one-hop release's bundle again
#
# An edge's address is read from the ssh configuration and is neither printed nor written. Evidence:
# activation/<edge>.{result.txt,reverted.txt}. WORK is the folder with payload/<first 8 of the SHA-256>/<file>.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=${WORK:-/home/steven/Documents/Codex/2026-10-23/it/work/provider-signers-20261116}
INSTALLER=$HERE/signers-edge-install.sh
ACT=$HERE/activation
WATCH=${WATCH:-60}
ALL=(eu-central ca-east us-west ap-southeast)
PROBES=${PROBES:-38f368d6 59f1273d 7ae476a3 9a28642b a69dcbba a77d0c57 c13d4b6a d9798e4c ef514ed3 5ff56a4d}
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=12 -o ServerAliveInterval=15)
SCP=(scp -q -o BatchMode=yes -o ConnectTimeout=12)
say() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
die() { say "STOP: $*" >&2; exit 1; }
mask() { sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/(addr)/g'; }
CMD=${1:-}; shift || true
case "$CMD" in status|activate|revert) ;; *) sed -n '2,10p' "$0"; exit 2 ;; esac
EDGES=("$@"); [ ${#EDGES[@]} -gt 0 ] || EDGES=("${ALL[@]}")
for e in "${EDGES[@]}"; do [[ " ${ALL[*]} " == *" $e "* ]] || die "$e is not one of: ${ALL[*]}"; done
mkdir -p "$ACT"
address_of() { local a; a=$(ssh -G "$1" 2>/dev/null | awk '$1=="hostname"{print $2}'); [[ $a =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$1: the ssh configuration gives no address"; echo "$a"; }
read_edge() { timeout 90 "${SSH[@]}" "$1" 'bash -s -- status' < "$INSTALLER" 2>&1 | mask; }
payload() {
  local p new name f
  for p in $(grep -o '[0-9a-f]\{64\}:[0-9a-f]\{64\}:[a-z.-]*' "$INSTALLER"); do
    new=$(cut -d: -f2 <<<"$p"); name=$(cut -d: -f3 <<<"$p"); f=$WORK/payload/${new:0:8}/$name
    [ "$(sha256sum "$f" 2>/dev/null | cut -d' ' -f1)" = "$new" ] || die "$f is not this release's file"
    node --check "$f" || die "$f does not parse"; FILES+=("$f")
  done
  [ ${#FILES[@]} = 2 ] || die "the installer names ${#FILES[@]} files, not 2"
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
stage_to() {
  local edge=$1; shift
  STAGE=$(timeout 30 "${SSH[@]}" "$edge" 'mktemp -d /root/enclave-signers-stage.XXXXXX') && [[ $STAGE =~ ^/root/enclave-signers-stage\.[A-Za-z0-9]{6}$ ]] || die "$edge: no staging directory"
  timeout 120 "${SCP[@]}" "$@" "$edge:$STAGE/" || die "$edge: copying to $STAGE failed (nothing installed)"
}
activate() {
  local edge=$1 addr before out rc now n i missing
  addr=$(address_of "$edge"); out=$(read_edge "$edge") || die "$edge: cannot read the edge"
  if grep -q '^provider: bundle new ' <<<"$out" && grep -q '^provider: answers: yes' <<<"$out"; then say "$edge: already on this release, left alone"; return 0; fi
  grep -q '^provider: bundle old ' <<<"$out" || die "$edge: the provider runs a build this release was not made from"
  before=$(probe "$addr"); say "$edge: answering through this edge now: ${before:-none of the probed names}"
  stage_to "$edge" "${FILES[@]}" "$INSTALLER"
  say "$edge: installing (about $((WATCH + 60)) s)"
  set +e
  timeout $((WATCH + 400)) "${SSH[@]}" "$edge" "WATCH=$WATCH bash $STAGE/signers-edge-install.sh install $STAGE provider; rc=\$?; rm -rf -- ${STAGE:?}; exit \$rc" 2>&1 | mask | tee "$ACT/$edge.result.txt" | sed 's/^/    /'; rc=${PIPESTATUS[0]}
  set -e
  [ "$rc" = 0 ] || die "$edge: the install did not finish (exit $rc). A line starting REVERTED or STOP above says where it stands; /var/log/enclave-provider-signers.log on the edge"
  for i in $(seq 18); do
    now=" $(probe "$addr") "; missing=""
    for n in $before; do [[ $now == *" ${n%%=*}="* ]] || missing+="${n%%=*} "; done
    [ -n "$missing" ] || break; sleep 10
  done
  for n in $missing; do
    [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$n.app.enclave.host/" || true)" != 000 ] \
      || die "$edge: $n.app.enclave.host answered through this edge before and answers nowhere now. The new build stays; 'revert $edge' puts the previous one back"
    say "$edge: $n.app.enclave.host no longer answers through this edge but answers by its name (its host moved that circuit)"
  done
  rm -f "${ACT:?}/${edge:?}.reverted.txt"
  say "$edge: VERIFIED (answering through this edge: $(echo $now))"
}
revert() {
  local edge=$1 rc
  stage_to "$edge" "$INSTALLER"
  set +e
  timeout 300 "${SSH[@]}" "$edge" "bash $STAGE/signers-edge-install.sh remove provider; rc=\$?; rm -rf -- ${STAGE:?}; exit \$rc" 2>&1 | mask | tee "$ACT/$edge.reverted.txt" | sed 's/^/    /'; rc=${PIPESTATUS[0]}
  set -e
  [ "$rc" = 0 ] || die "$edge: the removal did not finish (exit $rc)"
}
case "$CMD" in
  status) for e in "${EDGES[@]}"; do echo "== $e"; read_edge "$e" || die "$e: cannot read the edge"; done ;;
  activate) FILES=(); payload; for e in "${EDGES[@]}"; do activate "$e"; done; say "ALL DONE: ${EDGES[*]}" ;;
  revert) for e in "${EDGES[@]}"; do revert "$e"; done; say "reverted: ${EDGES[*]}" ;;
esac
