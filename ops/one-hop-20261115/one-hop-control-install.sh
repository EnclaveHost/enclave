#!/bin/bash
# One hop on the control VM (README.md). Three programs there check an owner's network policy with the rule that
# knows only guard:true. Each is put on a copy of the file it runs now with the one-hop change carried onto it
# (one-hop-bundles.py). Run as root on the control VM by one-hop-control.sh; status needs no root. Nothing in this
# file reads a key or prints a configuration value: of the bridge's configuration only the name of the relay's state
# file is used, and of that file only two counts.
#
#   one-hop-control-install.sh status
#   one-hop-control-install.sh install <stage dir> <bridge|route-pull|relay>...
#   one-hop-control-install.sh remove <relay|route-pull|bridge>...
#
#   bridge      enclave-policy-migration-bridge copies the owner policies the relay holds to the public directories,
#               every 5 s. On the installed file one stored guard:false policy stops the whole round, for every owner.
#   route-pull  enclave-provider-migration-mirror hands the directories' public route publications to the relay, every
#               10 s. On the installed file the publication of an app whose policy has guard:false is dropped.
#   relay       enclave-api-relay takes an owner's signed policy. On the installed bundle guard:false is refused, so
#               the relay is the gate: it goes last, and after it an owner can sign one hop.
#
# install, bridge and route-pull (the way of the edges): the unit's ExecStart must be `node <file> <config>`, the
# running process must be that command and doing its rounds, and the file must be the one this release was made from,
# by SHA-256. The staged file goes into a new directory, one drop-in sorted after the unit's others names it with the
# same configuration, daemon-reload, restart. The new process must do what the old one did: the bridge must copy
# every stored policy to the directories within 60 s, the route pull must hand on a round about as large as the old
# process's last. Each must be the same process 20 s later with no error line. Otherwise the drop-in is removed and
# the previous file runs again.
# install, relay: api-relay.js imports ./network-runtime.bundle.mjs by that name, so the file is replaced where it is.
# A copy is kept beside it (.before-one-hop-20261115), the new file is put in place by rename, restart. The new
# process must answer /v1/network/status within 60 s and be the same process, still answering, 20 s later. Otherwise
# the copy goes back and the relay is restarted on it.
# remove is the same way back, asked for. It is refused while a stored policy has guard:false (FORCE=1 overrides): the
# previous files refuse such a policy whole.
# Every run ends with a line starting DONE, REVERTED or STOP; a service already as asked reports SAME.
set -euo pipefail
trap '' HUP PIPE   # a dropped session must not stop this between a restart and its check
NODE=/usr/bin/node
LOG=/var/log/enclave-one-hop.log
PORT=${PORT:-8100}
WAITS=${WAITS:-60} SETTLE=${SETTLE:-20}   # seconds a new process has to take up the work, and to stay at it after
BRIDGE_CONFIG=/opt/enclave-directory-bridge/config.json
ALLOW=/etc/enclave-control/ALLOW_CONTROL_START   # all three units start only while this file exists
NOBODY=0x0000000000000000000000000000000000000000000000000000000000000000
MODE=${1:-}; shift || true
say() { local l; l="[$(date -u +%H:%M:%SZ)] $*"; [ "$MODE" = status ] || printf '%s\n' "$l" >>"$LOG" 2>/dev/null || true; printf '%s\n' "$l" 2>/dev/null || true; }
stop() { say "STOP: $*"; exit 1; }

# installed SHA-256 : this release's SHA-256 : file name
service() {
  SVC=$1
  case "$SVC" in
    bridge) UNIT=enclave-policy-migration-bridge HOW=dropin ROOT=/opt/enclave-directory-bridge
      PAIR="a219f4920444fbfef13420274fce9c4114a53342bdab7c565e90f1b2f232576a:3c778817cb309d82620764d4da937e316ae31db290bb5f56a720d0ab61b58f51:mirror.mjs" ;;
    route-pull) UNIT=enclave-provider-migration-mirror HOW=dropin ROOT=/opt/enclave-directory-bridge
      PAIR="934b511e173a8afa5777ab5dd41223097a2235c06763c234f2e4e5bf04fd7609:69b16600340a7d07b7f12fdcaf147ba2b84c52c02dac86aaa0c5885411e1a7bd:mirror-public-providers.mjs" ;;
    relay) UNIT=enclave-api-relay HOW=inplace ROOT=/opt/nan-relay
      PAIR="55544ec1c9fd2576cad885f8356967e25420a013828383d3bbc7276b3132215b:3bbc6bf0d5a8d4939d819fe2da313be31daf6b28e19570c07d910e0304a5e749:network-runtime.bundle.mjs" ;;
    *) stop "no such service: $SVC (bridge, route-pull or relay)" ;;
  esac
  IFS=: read -r OLD_SHA NEW_SHA NAME <<<"$PAIR"
  DROP=/etc/systemd/system/$UNIT.service.d/zzz-one-hop.conf    # bridge, route-pull
  NEW_PATH=$ROOT/one-hop-${NEW_SHA:0:8}/$NAME                   # bridge, route-pull
  FILE=$ROOT/$NAME BACKUP=$ROOT/$NAME.before-one-hop-20261115   # relay
}
sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
startable() { [ -e "$ALLOW" ] || stop "$SVC: $ALLOW is not there, so the unit would not start again after a restart. Nothing changed."; }
configured() { systemctl show -p ExecStart --value "$UNIT" | sed -n 's/^{ path=[^ ]* ; argv\[\]=\(.*\) ; ignore_errors=.*$/\1/p'; }
pid_of() { systemctl show -p MainPID --value "$UNIT"; }
restarts() { systemctl show -p NRestarts --value "$UNIT"; }
active() { [ "$(systemctl is-active "$UNIT" 2>/dev/null || true)" = active ]; }
running() { local p; p=$(pid_of); [ "$p" != 0 ] && [ -r "/proc/$p/cmdline" ] && tr '\0' ' ' <"/proc/$p/cmdline" | sed 's/ $//'; }
http() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || true; }
jlog() { journalctl -u "$UNIT" _PID="$1" --no-pager -o cat 2>/dev/null || true; }
count() { grep -ac "$1" || true; }
# the owner policies the relay holds, as the bridge reads them: "<policies> <of them with guard:false>", "- -" when
# the state file cannot be read (it is the relay's; root reads it)
stored() {
  "$NODE" -e '
    const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),s=JSON.parse(fs.readFileSync(c.file,"utf8")),p=Object.values(s.policies||{});
      console.log(p.length+" "+p.filter(e=>e&&e.policy&&e.policy.enclaveNetwork&&e.policy.enclaveNetwork.guard===false).length)}catch{console.log("- -")}' "$BRIDGE_CONFIG" 2>/dev/null || echo "- -"
}
# bridge: stored policies process $1 has copied to the directories since it started, and its error lines
copied() { jlog "$1" | { grep -ao 'public policy replicated 0x[0-9a-fA-F]*' || true; } | sort -u | wc -l; }
copy_errors() { jlog "$1" | tail -n "${2:-1000000}" | count 'policy replication'; }
# route pull: the last round process $1 logged, as "<publications handed on> <dropped>", "- -" when it logged none
round() {
  jlog "$1" | { grep -a '^{"routes":' || true; } | tail -n 1 | "$NODE" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).routes;if(!Number.isInteger(r.accepted+r.unchanged+r.rejected))throw 0;
      console.log((r.accepted+r.unchanged)+" "+r.rejected)}catch{console.log("- -")}})' 2>/dev/null || echo "- -"
}
pull_errors() { jlog "$1" | tail -n "${2:-1000000}" | count 'public provider mirror:'; }
relay_answers() { [ "$(http "http://127.0.0.1:$PORT/v1/network/status/$NOBODY")" = 200 ]; }
# the relay process started after the bundle beside it was last written, so that file is the one it loaded (ps gives
# the age in whole seconds: two of slack)
relay_loaded() {
  local p e; p=$(pid_of); [ "$p" != 0 ] || return 1
  e=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' '); [[ $e =~ ^[0-9]+$ ]] && [ $(($(date +%s) - e + 2)) -ge "$(stat -c %Y "$FILE")" ]
}
describe() {
  local p h d n g; p=$(pid_of)
  case "$SVC" in
    bridge) read -r n g <<<"$(stored)"; echo "copied $(copied "$p") of ${n/-/?} stored policies since it started, $(copy_errors "$p") error lines" ;;
    route-pull) read -r h d <<<"$(round "$p")"; echo "last round handed on $h, dropped $d; $(pull_errors "$p") error lines" ;;
    relay) echo "/v1/network/status answers $(http "http://127.0.0.1:$PORT/v1/network/status/$NOBODY")" ;;
  esac
}
# does its work now (either file). The route pull logs a round only when something was handed on or dropped, so its
# last logged round is what is read, not how long ago it was.
healthy() {
  local p h d; p=$(pid_of); active || return 1
  case "$SVC" in
    bridge) [ "$(copy_errors "$p" 20)" = 0 ] ;;
    route-pull) read -r h d <<<"$(round "$p")"; [[ $h =~ ^[0-9]+$ ]] && [ "$h" -gt 0 ] && [ "$(pull_errors "$p" 6)" = 0 ] ;;
    relay) relay_answers ;;
  esac
}
# process NEWPID does what the process before it did (WANT_N stored policies, BEFORE_H publications a round), in time
came_up() {
  local i h d
  for ((i = 0; i < WAITS; i += 3)); do
    case "$SVC" in
      bridge) [ "$(copied "$NEWPID")" -lt "$WANT_N" ] || return 0 ;;
      route-pull) read -r h d <<<"$(round "$NEWPID")"; if [[ $h =~ ^[0-9]+$ ]] && [ "$h" -gt 0 ] && [ $((h * 10)) -ge $((BEFORE_H * 7)) ]; then return 0; fi ;;
      relay) ! relay_answers || return 0 ;;
    esac
    sleep 3
  done
  return 1
}
# SETTLE seconds later: the same process, not restarted by systemd, no error line, still at work
stayed_up() {
  local n=$1 h d; sleep "$SETTLE"
  [ "$(pid_of)" = "$NEWPID" ] && active && [ "$(restarts)" = "$n" ] || return 1
  case "$SVC" in
    bridge) [ "$(copy_errors "$NEWPID")" = 0 ] && [ "$(copied "$NEWPID")" -ge "$WANT_N" ] ;;
    route-pull) read -r h d <<<"$(round "$NEWPID")"; [ "$(pull_errors "$NEWPID")" = 0 ] && [[ $h =~ ^[0-9]+$ ]] && [ "$h" -gt 0 ] ;;
    relay) relay_answers ;;
  esac
}
# a main process other than $1, within $2 seconds, that runs "$3" when given -> NEWPID
wait_up() {
  local old=$1 t=$2 want=${3:-} p i
  for ((i = 0; i < t; i += 2)); do
    p=$(pid_of)
    if active && [ "$p" != 0 ] && [ "$p" != "$old" ] && { [ -z "$want" ] || [ "$(running || true)" = "$want" ]; }; then NEWPID=$p; return 0; fi
    sleep 2
  done
  return 1
}
# what a drop-in unit is set to run: C_BUNDLE C_CONFIG C_SHA, and KIND = old (the file this release was made from),
# new (this release's, in its own directory) or other
read_unit() {
  local line node extra
  line=$(configured); node="" C_BUNDLE="" C_CONFIG="" extra=""
  read -r node C_BUNDLE C_CONFIG extra <<<"$line" || true
  [ "$node" = "$NODE" ] && [[ $C_BUNDLE == /* && $C_CONFIG == /* ]] && [ -z "$extra" ] ||
    stop "$SVC: the unit's ExecStart is not \`$NODE <file> <config>\` ($(wc -w <<<"$line") words). This script does not know such a unit. Nothing changed."
  C_SHA=$(sha "$C_BUNDLE" || true); KIND=other
  if [ "$C_SHA" = "$OLD_SHA" ] && [ "$(basename "$C_BUNDLE")" = "$NAME" ]; then KIND=old
  elif [ "$C_SHA" = "$NEW_SHA" ] && [ "$C_BUNDLE" = "$NEW_PATH" ]; then KIND=new; fi
}
# what the previous file is asked to do after a step is taken back: with a guard:false policy stored it cannot
want_now() {
  local n g; read -r n g <<<"$(stored)"
  [[ $n =~ ^[0-9]+$ ]] || stop "$SVC: the relay's stored policies cannot be read (run as root). Nothing changed."
  WANT_N=$n STORED_G=$g
}

# ---- bridge and route-pull: a drop-in names the new file
take_back() {
  local why=$1 was want
  say "$SVC: $why. Taking the step back."
  was=$(pid_of); want="$NODE $PREV_BUNDLE $PREV_CONFIG"
  rm -f "${DROP:?}"; systemctl daemon-reload
  if [ "$(configured)" != "$want" ]; then
    say "STOP: $SVC: with the drop-in removed the unit does not name the previous file. Nothing was restarted after that; read \`systemctl cat $UNIT\`."; exit 1
  fi
  systemctl restart "$UNIT" || true
  if wait_up "$was" "$WAITS" "$want" && came_up; then
    say "REVERTED $SVC: $why. The previous file runs again (process $NEWPID; $(describe))."
  else
    say "REVERTED $SVC: $why. The unit names the previous file again but the service DOES NOT DO ITS WORK: \`systemctl status $UNIT\`, \`journalctl -u $UNIT -n 50\`."
  fi
  exit 1
}
install_dropin() {
  read_unit
  local staged=$STAGE/$NAME want before_pid before_n before h d
  case "$KIND" in
    new) if [ "$(running || true)" = "$NODE $C_BUNDLE $C_CONFIG" ] && healthy; then say "SAME $SVC: already on this release's file (${C_SHA:0:12}; $(describe))"; return 0; fi
         stop "$SVC: the unit names this release's file but the service does not run it or does not do its work. Nothing changed; \`remove $SVC\` puts the previous one back." ;;
    other) stop "$SVC: the unit runs $C_BUNDLE (${C_SHA:0:12}), which this release was not made from. Nothing changed." ;;
  esac
  [ ! -e "$DROP" ] || stop "$SVC: $DROP is there but the unit does not run this release's file. Nothing changed."
  startable
  [ "$(running || true)" = "$NODE $C_BUNDLE $C_CONFIG" ] || stop "$SVC: the running process is not the unit's ExecStart (some change is waiting for a restart). Nothing changed."
  want_now
  if [ "$SVC" = bridge ] && [ "$STORED_G" != 0 ]; then
    say "$SVC: $STORED_G stored policy(ies) have guard:false, which the installed file cannot copy; going on to the file that can"
  else
    healthy || stop "$SVC: does not do its work now ($(describe)). Nothing changed."
  fi
  [ "$(sha "$staged" || true)" = "$NEW_SHA" ] || stop "$SVC: $staged is not this release's file. Nothing changed."
  "$NODE" --check "$staged" 2>/dev/null || stop "$SVC: $NODE cannot parse $staged. Nothing changed."
  [ "$(df --output=avail -k "$ROOT" | tail -1)" -ge 20000 ] || stop "$SVC: less than 20 MB free under $ROOT. Nothing changed."
  [ -d "/etc/systemd/system/$UNIT.service.d" ] || stop "$SVC: the unit has no drop-in directory. This script does not know such a unit. Nothing changed."
  PREV_BUNDLE=$C_BUNDLE PREV_CONFIG=$C_CONFIG BEFORE_H=0
  if [ "$SVC" = route-pull ]; then read -r h d <<<"$(round "$(pid_of)")"; [[ $h =~ ^[0-9]+$ ]] || stop "$SVC: the running process has logged no round. Nothing changed."; BEFORE_H=$h; fi
  # the route pull runs as a user of its own (DynamicUser): directory and file must be readable by anyone
  install -d -o root -g root -m 0755 "$(dirname "$NEW_PATH")"
  [ "$(sha "$NEW_PATH" || true)" = "$NEW_SHA" ] || install -o root -g root -m 0644 "$staged" "$NEW_PATH"
  [ "$(sha "$NEW_PATH" || true)" = "$NEW_SHA" ] || stop "$SVC: $NEW_PATH did not come out as this release's file. No unit was changed."
  before_pid=$(pid_of) before_n=$(restarts) before=$(describe)
  want="$NODE $NEW_PATH $C_CONFIG"
  printf '%s\n' "# One hop (ops/one-hop-20261115): the same service and configuration on the file that knows" \
    "# enclaveNetwork.guard:false. Removing this file, then daemon-reload and a restart, is the way back." \
    "[Service]" "ExecStart=" "ExecStart=$want" >"$DROP.new"
  chmod 0644 "$DROP.new"; mv "$DROP.new" "$DROP"
  systemctl daemon-reload
  if [ "$(configured)" != "$want" ]; then
    rm -f "${DROP:?}"; systemctl daemon-reload
    stop "$SVC: with the drop-in the unit still does not name the new file (another drop-in sorts later). Drop-in removed, nothing restarted."
  fi
  say "$SVC: restarting process $before_pid ($before) on ${NEW_SHA:0:12}"
  systemctl restart "$UNIT" || take_back "the restart command failed"
  wait_up "$before_pid" "$WAITS" "$want" || take_back "no new process within $WAITS s"
  came_up || take_back "the new process did not take up the work within $WAITS s ($(describe))"
  stayed_up "$before_n" || take_back "the new process did not stay at work for $SETTLE s ($(describe))"
  say "DONE $SVC: process $NEWPID runs $NEW_PATH (${NEW_SHA:0:12}); before: $before; now: $(describe)"
}
remove_dropin() {
  [ -e "$DROP" ] || { say "SAME $SVC: no one-hop drop-in here"; return 0; }
  local was want h d
  startable
  want_now; BEFORE_H=0
  if [ "$SVC" = route-pull ]; then read -r h d <<<"$(round "$(pid_of)")"; [[ $h =~ ^[0-9]+$ ]] && BEFORE_H=$h || true; fi
  was=$(pid_of)
  rm -f "${DROP:?}"; systemctl daemon-reload
  read_unit
  [ "$KIND" = old ] || stop "$SVC: with the drop-in removed the unit names $C_BUNDLE (${C_SHA:0:12}), not the file this release was made from. Nothing was restarted; read \`systemctl cat $UNIT\`."
  want="$NODE $C_BUNDLE $C_CONFIG"
  say "$SVC: restarting process $was on the previous file ${C_SHA:0:12}"
  systemctl restart "$UNIT" || true
  wait_up "$was" "$WAITS" "$want" && came_up || stop "$SVC: the unit names the previous file again but the service does not do its work: \`systemctl status $UNIT\`, \`journalctl -u $UNIT -n 50\`."
  say "DONE $SVC: process $NEWPID runs the previous file $C_BUNDLE (${C_SHA:0:12}); now: $(describe)"
}

# ---- relay: the bundle is replaced where it is
put() {   # put <source> <SHA-256 it must have>: beside the bundle first, then one rename
  install -o root -g root -m 0644 "$1" "$FILE.one-hop-tmp"
  [ "$(sha "$FILE.one-hop-tmp" || true)" = "$2" ] || { rm -f "${FILE:?}.one-hop-tmp"; return 1; }
  mv -f "$FILE.one-hop-tmp" "$FILE"
}
relay_back() {
  local why=$1 was
  say "$SVC: $why. Putting the previous bundle back."
  was=$(pid_of)
  put "$BACKUP" "$OLD_SHA" || { say "STOP: $SVC: $BACKUP is not the previous bundle any more. The relay's bundle is this release's and was not changed back: read \`systemctl status $UNIT\`."; exit 1; }
  systemctl restart "$UNIT" || true
  if wait_up "$was" "$WAITS" && came_up; then
    say "REVERTED $SVC: $why. The previous bundle runs again (process $NEWPID; $(describe))."
  else
    say "REVERTED $SVC: $why. The previous bundle is back in place but the relay DOES NOT ANSWER: \`systemctl status $UNIT\`, \`journalctl -u $UNIT -n 50\`."
  fi
  exit 1
}
install_relay() {
  local staged=$STAGE/$NAME cur before_pid before_n
  cur=$(sha "$FILE" || true)
  [ ! -e "$FILE.one-hop-tmp" ] || stop "$SVC: $FILE.one-hop-tmp is there, left by a run that did not finish. Nothing changed."
  case "$cur" in
    "$NEW_SHA") if active && relay_loaded && relay_answers; then say "SAME $SVC: already on this release's bundle (${cur:0:12}; $(describe))"; return 0; fi
      stop "$SVC: the bundle in place is this release's but the relay does not answer, or started before the file was put there. Nothing changed; \`remove relay\` puts the previous one back." ;;
    "$OLD_SHA") ;;
    *) stop "$SVC: $FILE (${cur:0:12}) is not the bundle this release was made from. Nothing changed." ;;
  esac
  startable
  active && relay_answers || stop "$SVC: does not answer now ($(describe)). Nothing changed."
  relay_loaded || stop "$SVC: the running relay started before its bundle was last written (some change is waiting for a restart). Nothing changed."
  [ "$(sha "$staged" || true)" = "$NEW_SHA" ] || stop "$SVC: $staged is not this release's file. Nothing changed."
  "$NODE" --check "$staged" 2>/dev/null || stop "$SVC: $NODE cannot parse $staged. Nothing changed."
  [ "$(df --output=avail -k "$ROOT" | tail -1)" -ge 20000 ] || stop "$SVC: less than 20 MB free under $ROOT. Nothing changed."
  if [ -e "$BACKUP" ]; then [ "$(sha "$BACKUP" || true)" = "$OLD_SHA" ] || stop "$SVC: $BACKUP is there and is not the installed bundle. Nothing changed."
  else cp -p "$FILE" "$BACKUP"; [ "$(sha "$BACKUP" || true)" = "$OLD_SHA" ] || stop "$SVC: the copy $BACKUP did not come out as the installed bundle. Nothing else changed."; fi
  before_pid=$(pid_of) before_n=$(restarts)
  put "$staged" "$NEW_SHA" || stop "$SVC: the new bundle did not come out as this release's file beside the old one. The bundle in place was not changed."
  say "$SVC: restarting process $before_pid on ${NEW_SHA:0:12}; the API is away for the seconds the restart takes"
  systemctl restart "$UNIT" || relay_back "the restart command failed"
  wait_up "$before_pid" "$WAITS" || relay_back "no new process within $WAITS s"
  came_up || relay_back "the new process does not answer /v1/network/status within $WAITS s"
  stayed_up "$before_n" || relay_back "the new process did not stay up and answering for $SETTLE s"
  say "DONE $SVC: process $NEWPID runs $FILE (${NEW_SHA:0:12}); the previous bundle is kept as $BACKUP; $(describe)"
}
remove_relay() {
  local cur was; cur=$(sha "$FILE" || true)
  [ "$cur" != "$OLD_SHA" ] || { say "SAME $SVC: the bundle in place is the previous one"; return 0; }
  [ "$cur" = "$NEW_SHA" ] || stop "$SVC: $FILE (${cur:0:12}) is neither this release's bundle nor the one before it. Nothing changed."
  [ "$(sha "$BACKUP" || true)" = "$OLD_SHA" ] || stop "$SVC: $BACKUP is not the previous bundle. Nothing changed."
  startable
  was=$(pid_of)
  put "$BACKUP" "$OLD_SHA" || stop "$SVC: the previous bundle did not come out right beside the new one. The bundle in place was not changed."
  say "$SVC: restarting process $was on the previous bundle ${OLD_SHA:0:12}"
  systemctl restart "$UNIT" || true
  wait_up "$was" "$WAITS" && came_up || stop "$SVC: the previous bundle is back in place but the relay does not answer: \`systemctl status $UNIT\`, \`journalctl -u $UNIT -n 50\`."
  say "DONE $SVC: process $NEWPID runs the previous bundle (${OLD_SHA:0:12}); $(describe)"
}
# the previous files refuse a guard:false policy whole: the bridge would stop copying every owner's policy, the relay
# would stop serving that app's, the route pull would drop its publication
no_one_hop_policy() {
  [ "${FORCE:-}" != 1 ] || return 0
  local n g; read -r n g <<<"$(stored)"
  [[ $g =~ ^[0-9]+$ ]] || stop "the relay's stored policies cannot be read, so it cannot be told whether an owner has signed guard:false. Nothing changed (FORCE=1 overrides)."
  [ "$g" = 0 ] || stop "$g stored policy(ies) have guard:false and the previous files refuse such a policy whole. The owner signs guard:true again first (FORCE=1 overrides). Nothing changed."
}

status_one() {
  service "$1"
  local kind cur line p; p=$(pid_of)
  echo "$SVC: unit $(systemctl is-active "$UNIT" 2>/dev/null || true), process $p, since $(systemctl show -p ActiveEnterTimestamp --value "$UNIT"), automatic restarts $(restarts)"
  if [ "$HOW" = dropin ]; then
    line=$(configured); kind=$( (read_unit >/dev/null 2>&1; echo "$KIND ${C_SHA:0:12} $C_BUNDLE") 2>/dev/null || echo "unknown")
    echo "$SVC: file $kind"
    echo "$SVC: process runs the unit's command: $([ "$(running || true)" = "$line" ] && echo yes || echo NO)"
    echo "$SVC: one-hop drop-in: $([ -e "$DROP" ] && echo present || echo absent); drop-ins: $(ls "/etc/systemd/system/$UNIT.service.d" 2>/dev/null | tr '\n' ' ')"
  else
    cur=$(sha "$FILE" || true); kind=other; [ "$cur" != "$OLD_SHA" ] || kind=old; [ "$cur" != "$NEW_SHA" ] || kind=new
    echo "$SVC: file $kind ${cur:0:12} $FILE"
    echo "$SVC: process started after that file was last written: $(relay_loaded && echo yes || echo NO)"
    echo "$SVC: previous bundle kept beside it: $([ -e "$BACKUP" ] && { [ "$(sha "$BACKUP" || true)" = "$OLD_SHA" ] && echo yes || echo "a file of that name that is NOT the previous bundle"; } || echo no)"
  fi
  echo "$SVC: at work: $(healthy && echo yes || echo NO) ($(describe))"
}
status_box() {
  local n g; read -r n g <<<"$(stored)"
  echo "box: node $("$NODE" --version 2>/dev/null || echo none); free under /opt: $(df --output=avail -m /opt | tail -1 | tr -d ' ') MB"
  echo "box: the three units' start condition is there: $([ -e "$ALLOW" ] && echo yes || { [ "$(id -u)" = 0 ] && echo NO || echo "not visible without root"; })"
  echo "box: owner policies the relay holds: $([[ $n =~ ^[0-9]+$ ]] && echo "$n, of them with guard:false: $g" || echo "not readable without root")"
}

case "$MODE" in
  status) for s in bridge route-pull relay; do status_one "$s"; done; status_box ;;
  install) [ "$(id -u)" = 0 ] || stop "run as root"; STAGE=${1:-}; shift || true
    [ -d "$STAGE" ] && [ $# -gt 0 ] || stop "usage: install <stage dir> <bridge|route-pull|relay>..."
    for s in "$@"; do service "$s"; if [ "$HOW" = dropin ]; then install_dropin; else install_relay; fi; done ;;
  remove) [ "$(id -u)" = 0 ] || stop "run as root"; [ $# -gt 0 ] || stop "usage: remove <relay|route-pull|bridge>..."
    no_one_hop_policy
    for s in "$@"; do service "$s"; if [ "$HOW" = dropin ]; then remove_dropin; else remove_relay; fi; done ;;
  *) sed -n '2,32p' "$0" >&2; exit 2 ;;
esac
