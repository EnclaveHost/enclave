#!/bin/bash
# The remembered signer recovery on an Enclave edge's provider (README.md): the provider is restarted on a copy of the
# bundle it runs now (the one-hop release's) with that one change carried onto it (signers-bundles.py). Run as root on
# the edge by signers-edges.sh. Made from ops/one-hop-20261115/one-hop-edge-install.sh: the same guards and steps, for
# the provider only. Nothing in this file is specific to an edge, and it reads no configuration or key file.
#
#   signers-edge-install.sh status
#   signers-edge-install.sh install <stage dir> provider
#   signers-edge-install.sh remove provider
#
# install: the unit's ExecStart must be `node <bundle> <config>`, the running process that command, the service
# answering and the bundle the one-hop release's by SHA-256, or STOP with nothing changed. The staged bundle goes into
# a new directory beside the old one; one drop-in, sorted after the unit's others, names it with the same
# configuration file. Restart; a new process within 60 s that answers within 60 s more and is the same 20 s later,
# then watched for WATCH seconds (default 60). A step that does not hold is taken back (drop-in removed, restart) and
# the run ends with a line starting REVERTED. remove is the same way back, asked for.
# Every run ends with a line starting DONE, REVERTED or STOP; a service already as asked reports SAME.
set -euo pipefail
trap '' HUP PIPE   # a dropped ssh session must not stop this between a restart and its check
NODE=/usr/local/bin/node
LOG=/var/log/enclave-provider-signers.log
WATCH=${WATCH:-60} CONTROL=${CONTROL:-51822} DIRPORT=${DIRPORT:-8188}
REFUSAL='requires a guard'
MODE=${1:-}; shift || true
say() { local l; l="[$(date -u +%H:%M:%SZ)] $*"; [ "$MODE" = status ] || printf '%s\n' "$l" >>"$LOG" 2>/dev/null || true; printf '%s\n' "$l" 2>/dev/null || true; }
stop() { say "STOP: $*"; exit 1; }

# installed SHA-256 : this release's SHA-256 : file name
service() {
  SVC=$1
  case "$SVC" in
    provider) UNIT=enclave-network-provider ROOT=/opt/enclave-network DROPIN=zzzzzzz-signers.conf
      PAIRS="03cb11f68021767485952e3f0f6acfbc16a18c51b2aada602c6c429695640d26:2f18d8003767caae50140487cc5cfd5d82c53a08221b7445d8535c6324e30cd6:provider.mjs
             0c201bd79619cde4fae6307a283cddd9e576a4056d2c45617616c6a77ee130e8:4a0d8d757d4673b2ebe0b7f600378d3bb1eb40f8f703d5429a5db0b7802cf42e:wg-provider.mjs" ;;
    *) stop "no such service: $SVC (provider)" ;;
  esac
  DROP=/etc/systemd/system/$UNIT.service.d/$DROPIN
}
sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
configured() { systemctl show -p ExecStart --value "$UNIT" | sed -n 's/^{ path=[^ ]* ; argv\[\]=\(.*\) ; ignore_errors=.*$/\1/p'; }
pid_of() { systemctl show -p MainPID --value "$UNIT"; }
active() { [ "$(systemctl is-active "$UNIT" 2>/dev/null || true)" = active ]; }
running() { local p; p=$(pid_of); [ "$p" != 0 ] && [ -r "/proc/$p/cmdline" ] && tr '\0' ' ' <"/proc/$p/cmdline" | sed 's/ $//'; }
http() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || true; }
# the provider's own account of itself: "accepting <guard peers> <exit peers> <direct peers or ->", or "none - - -"
info() {
  { curl -s -m 5 "http://127.0.0.1:$CONTROL/v1/info" 2>/dev/null || true; } | "$NODE" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s),p=j.status.peers;
      console.log([j.status.accepting===true?"accepting":"closed",Number(p.guard),Number(p.exit),typeof p.direct==="number"?p.direct:"-"].join(" "))}
      catch{console.log("none - - -")}})' 2>/dev/null || echo "none - - -"
}
describe() {
  case "$SVC" in
    provider) local a g e d; read -r a g e d <<<"$(info)"; echo "$a, guard peers $g, exit peers $e, direct peers $d" ;;
    directory) echo "routes $(http "http://127.0.0.1:$DIRPORT/v1/network/routes"), health $(http "http://127.0.0.1:$DIRPORT/health")" ;;
  esac
}
# answers at all (either build)
healthy() {
  case "$SVC" in
    provider) [[ $(info) =~ ^accepting\ [0-9]+\ [0-9]+\  ]] ;;
    directory) [ "$(http "http://127.0.0.1:$DIRPORT/v1/network/routes")" = 200 ] ;;
  esac
}
# answers as this release's build does
healthy_new() {
  case "$SVC" in
    provider) [[ $(info) =~ ^accepting\ [0-9]+\ [0-9]+\ [0-9]+$ ]] ;;
    directory) healthy ;;
  esac
}
# what the unit is set to run: C_BUNDLE C_CONFIG C_SHA, and KIND = old (a bundle this release was made from),
# new (this release's, in its own directory) or other; for old and new also NEW_SHA NAME NEW_PATH
read_unit() {
  local line node extra p old new name
  line=$(configured); node="" C_BUNDLE="" C_CONFIG="" extra=""
  read -r node C_BUNDLE C_CONFIG extra <<<"$line" || true
  [ "$node" = "$NODE" ] && [[ $C_BUNDLE == /* && $C_CONFIG == /* ]] && [ -z "$extra" ] ||
    stop "$SVC: the unit's ExecStart is not \`$NODE <bundle> <config>\` ($(wc -w <<<"$line") words). This script does not know such a unit. Nothing changed."
  C_SHA=$(sha "$C_BUNDLE" || true); KIND=other NEW_SHA="" NAME="" NEW_PATH=""
  for p in $PAIRS; do
    IFS=: read -r old new name <<<"$p"
    if [ "$C_SHA" = "$old" ] && [ "$(basename "$C_BUNDLE")" = "$name" ]; then KIND=old
    elif [ "$C_SHA" = "$new" ] && [ "$C_BUNDLE" = "$ROOT/signers-${new:0:8}/$name" ]; then KIND=new
    else continue; fi
    NEW_SHA=$new NAME=$name NEW_PATH=$ROOT/signers-${new:0:8}/$name; break
  done
}
# a main process other than $1 that runs "$2", within $3 seconds -> NEWPID
wait_up() {
  local old=$1 want=$2 t=$3 p i
  for ((i = 0; i < t; i += 2)); do
    p=$(pid_of)
    if active && [ "$p" != 0 ] && [ "$p" != "$old" ] && [ "$(running || true)" = "$want" ]; then NEWPID=$p; return 0; fi
    sleep 2
  done
  return 1
}
wait_answer() { local i; for ((i = 0; i < $2; i += 3)); do "$1" && return 0; sleep 3; done; return 1; }
# the previous command back: PREV_BUNDLE and PREV_CONFIG, read before anything was changed
take_back() {
  local why=$1 was want
  say "$SVC: $why. Taking the step back."
  was=$(pid_of); want="$NODE $PREV_BUNDLE $PREV_CONFIG"
  rm -f "${DROP:?}"; systemctl daemon-reload
  if [ "$(configured)" != "$want" ]; then
    say "STOP: $SVC: with the drop-in removed the unit does not name the previous bundle. Nothing was restarted after that; read \`systemctl cat $UNIT\`."; exit 1
  fi
  systemctl restart "$UNIT" || true
  if wait_up "$was" "$want" 60 && wait_answer healthy 60; then
    say "REVERTED $SVC: $why. The previous bundle runs again (process $NEWPID; $(describe))."
  else
    say "REVERTED $SVC: $why. The unit names the previous bundle again but the service DOES NOT ANSWER: \`systemctl status $UNIT\`, \`journalctl -u $UNIT -n 50\`."
  fi
  exit 1
}

install_one() {
  service "$1"; read_unit
  local staged want before_pid before_n before n end tick
  case "$KIND" in
    new) if active && [ "$(running || true)" = "$NODE $C_BUNDLE $C_CONFIG" ] && healthy_new; then say "SAME $SVC: already on this release's bundle (${C_SHA:0:12}; $(describe))"; return 0; fi
         stop "$SVC: the unit names this release's bundle but the service does not run it or does not answer. Nothing changed; \`remove $SVC\` puts the previous one back." ;;
    other) stop "$SVC: the unit runs $C_BUNDLE (${C_SHA:0:12}), which this release was not made from. Nothing changed." ;;
  esac
  [ ! -e "$DROP" ] || stop "$SVC: $DROP is there but the unit does not run this release's bundle. Nothing changed."
  [ "$(running || true)" = "$NODE $C_BUNDLE $C_CONFIG" ] || stop "$SVC: the running process is not the unit's ExecStart (some change is waiting for a restart). Nothing changed."
  healthy || stop "$SVC: does not answer now ($(describe)). Nothing changed."
  staged=$STAGE/$NAME
  [ "$(sha "$staged" || true)" = "$NEW_SHA" ] || stop "$SVC: $staged is not this release's file. Nothing changed."
  "$NODE" --check "$staged" 2>/dev/null || stop "$SVC: $NODE cannot parse $staged. Nothing changed."
  [ "$(df --output=avail -k "$ROOT" | tail -1)" -ge 20000 ] || stop "$SVC: less than 20 MB free under $ROOT. Nothing changed."
  [ -d "/etc/systemd/system/$UNIT.service.d" ] || stop "$SVC: the unit has no drop-in directory. This script does not know such a unit. Nothing changed."
  PREV_BUNDLE=$C_BUNDLE PREV_CONFIG=$C_CONFIG
  install -d -o root -g root -m 0755 "$(dirname "$NEW_PATH")"
  [ "$(sha "$NEW_PATH" || true)" = "$NEW_SHA" ] || install -o root -g root -m 0644 "$staged" "$NEW_PATH"
  [ "$(sha "$NEW_PATH" || true)" = "$NEW_SHA" ] || stop "$SVC: $NEW_PATH did not come out as this release's file. No unit was changed."
  before_pid=$(pid_of) before_n=$(systemctl show -p NRestarts --value "$UNIT") before=$(describe)
  want="$NODE $NEW_PATH $C_CONFIG"
  printf '%s\n' "# ops/provider-signers-20261116: the same service and configuration on the bundle that remembers recovered" \
    "# signers and yields between recoveries. Removing this file, then daemon-reload and a restart, is the way back." \
    "[Service]" "ExecStart=" "ExecStart=$want" >"$DROP.new"
  chmod 0644 "$DROP.new"; mv "$DROP.new" "$DROP"
  systemctl daemon-reload
  if [ "$(configured)" != "$want" ]; then
    rm -f "${DROP:?}"; systemctl daemon-reload
    stop "$SVC: with the drop-in the unit still does not name the new bundle (another drop-in sorts later). Drop-in removed, nothing restarted."
  fi
  say "$SVC: restarting process $before_pid ($before) on ${NEW_SHA:0:12}"
  systemctl restart "$UNIT" || take_back "the restart command failed"
  wait_up "$before_pid" "$want" 60 || take_back "no new process within 60 s"
  wait_answer healthy_new 60 || take_back "the new process does not answer as this release's build within 60 s ($(describe))"
  sleep 20
  [ "$(pid_of)" = "$NEWPID" ] && active && [ "$(systemctl show -p NRestarts --value "$UNIT")" = "$before_n" ] && healthy_new || take_back "the new process did not stay up for 20 s"
  if [ "$SVC" = provider ]; then
    say "$SVC: process $NEWPID is up ($(describe)); watching $WATCH s for refused requests"
    end=$((SECONDS + WATCH)) tick=0
    while [ "$SECONDS" -lt "$end" ]; do
      sleep 15; tick=$((tick + 1))
      [ "$(pid_of)" = "$NEWPID" ] && active || take_back "the process changed during the watch"
      n=$(journalctl -u "$UNIT" _PID="$NEWPID" --no-pager -o cat 2>/dev/null | grep -ac "$REFUSAL" || true)
      [ "${n:-0}" = 0 ] || take_back "$n request(s) refused as a host's own with no guard in front, while no owner has signed guard:false"
      [ $((tick % 4)) != 0 ] || say "$SVC: $(describe); $((end - SECONDS)) s of the watch left"
    done
    healthy_new || take_back "it stopped answering during the watch"
    n=$(journalctl -u "$UNIT" _PID="$NEWPID" --no-pager -o cat 2>/dev/null | grep -ac ' refused: ' || true)
    [ "${n:-0}" = 0 ] || say "NOTE $SVC: $n request(s) refused for other reasons since the restart (\`journalctl -u $UNIT _PID=$NEWPID | grep refused\`)"
  fi
  say "DONE $SVC: process $NEWPID runs $NEW_PATH (${NEW_SHA:0:12}); before: $before; now: $(describe)"
}

remove_one() {
  service "$1"
  [ -e "$DROP" ] || { say "SAME $SVC: no drop-in of this release here"; return 0; }
  local was want
  was=$(pid_of)
  rm -f "${DROP:?}"; systemctl daemon-reload
  read_unit
  [ "$KIND" = old ] || stop "$SVC: with the drop-in removed the unit names $C_BUNDLE (${C_SHA:0:12}), not a bundle this release was made from. Nothing was restarted; read \`systemctl cat $UNIT\`."
  want="$NODE $C_BUNDLE $C_CONFIG"
  say "$SVC: restarting process $was on the previous bundle ${C_SHA:0:12}"
  systemctl restart "$UNIT" || true
  wait_up "$was" "$want" 60 && wait_answer healthy 60 || stop "$SVC: the unit names the previous bundle again but the service does not answer: \`systemctl status $UNIT\`, \`journalctl -u $UNIT -n 50\`."
  say "DONE $SVC: process $NEWPID runs the previous bundle $C_BUNDLE (${C_SHA:0:12}); now: $(describe)"
}

status_one() {
  service "$1"
  local line node extra
  line=$(configured); node="" C_BUNDLE="" C_CONFIG="" extra=""; read -r node C_BUNDLE C_CONFIG extra <<<"$line" || true
  if [ "$node" = "$NODE" ] && [[ $C_BUNDLE == /* && $C_CONFIG == /* ]] && [ -z "$extra" ]; then read_unit; else KIND=unknown C_SHA=""; fi
  echo "$SVC: unit $(systemctl is-active "$UNIT" 2>/dev/null || true), process $(pid_of), since $(systemctl show -p ActiveEnterTimestamp --value "$UNIT"), automatic restarts $(systemctl show -p NRestarts --value "$UNIT")"
  echo "$SVC: bundle $KIND ${C_SHA:0:12} $C_BUNDLE"
  echo "$SVC: process runs the unit's command: $([ "$(running || true)" = "$line" ] && echo yes || echo NO)"
  echo "$SVC: this release's drop-in: $([ -e "$DROP" ] && echo present || echo absent); drop-ins: $(ls "/etc/systemd/system/$UNIT.service.d" 2>/dev/null | tr '\n' ' ')"
  echo "$SVC: answers: $(healthy && echo yes || echo NO) ($(describe))"
  echo "$SVC: refused as a host's own since this process started: $(journalctl -u "$UNIT" _PID="$(pid_of)" --no-pager -o cat 2>/dev/null | grep -ac "$REFUSAL" || true)"
}
# A guard hands a host's request to the exit from its own address (masquerade on the uplink), and the exit tells a
# guard from a host by that address being a listed provider's. So this box's source address toward every other
# listed provider must be the address it is listed under. Counts only; no address is printed.
egress() {
  local me; me=$(curl -s -m 5 "http://127.0.0.1:$CONTROL/v1/info" 2>/dev/null || true)
  { curl -s -m 8 "http://127.0.0.1:$DIRPORT/v1/network/providers" 2>/dev/null || true; } | ME=$me "$NODE" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
      const me=JSON.parse(process.env.ME),all=JSON.parse(s).providers.map(p=>p.record?.record||p.record||p),listed=all.find(p=>p.providerId===me.providerId);
      console.log([me.address,listed?listed.address:"-",...all.filter(p=>p.providerId!==me.providerId).map(p=>p.address)].join(" "))}catch{console.log("")}})' 2>/dev/null || true
}
status_box() {
  local own listed others o ok=0 n=0
  read -r own listed others <<<"$(egress)" || true
  for o in ${others:-}; do n=$((n + 1)); [ "$(ip -4 route get "$o" 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')" = "$own" ] && ok=$((ok + 1)) || true; done
  echo "box: node $("$NODE" --version 2>/dev/null || echo none); free under /opt: $(df --output=avail -m /opt | tail -1 | tr -d ' ') MB"
  echo "box: listed in its own directory under the address the provider reports: $([ -n "${own:-}" ] && [ "${own:-}" = "${listed:-}" ] && echo yes || echo NO)"
  echo "box: source address toward the other listed providers is that address: $ok of $n"
}

case "$MODE" in
  status) [ "$(id -u)" = 0 ] || stop "run as root"; status_one provider ;;
  install) [ "$(id -u)" = 0 ] || stop "run as root"; STAGE=${1:-}; shift || true
    [ -d "$STAGE" ] && [ $# -gt 0 ] || stop "usage: install <stage dir> provider"
    for s in "$@"; do install_one "$s"; done ;;
  remove) [ "$(id -u)" = 0 ] || stop "run as root"; [ $# -gt 0 ] || stop "usage: remove provider"
    for s in "$@"; do remove_one "$s"; done ;;
  *) sed -n '2,17p' "$0" >&2; exit 2 ;;
esac
