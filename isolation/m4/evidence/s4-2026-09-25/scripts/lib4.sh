# Shared constants and checks for S4 (sourced AFTER ../lib.sh). The release 31d117a9 is built by 5d from image commit
# d1a38994 (evidence isolation/m4/evidence/production-release-d1a38994/, INSTALL.md at 44f91687, then 023b06be).
REL=31d117a95b941b78bb7d7955805431f17a4fcc9eb6723ea513cf9e95cc195815; IMG=d1a38994a06b5d87e1fb29ca6ff17832ce10974e
SRC=/home/steven/enclave-bench/prod-release-d1a38994/release-d1a38994
T=$PROD/iso-d1a38994; R=$PROD/release-d1a38994; LEG=$PROD/iso-03be27d6/isolation; LEGC=0181bce3aac5fa03dfaf2928d834ecd04d2a4a73
FLOOR=16384   # Codex: the host floor for THIS 64 GiB pool at its next coordinated guestd rollout, which 4d is
# the reviewed host-memory floor (enclave-63): a 4d guestd must be built from a commit carrying both
FLOORC="d67b0020c8fd58166392e85bf315e4bb15404183 1b5375c9f9718d346d4c5511d7a9bc3096d5551f"
MAIN=/home/steven/Projects/enclave; S4=$EV/s4; LOG4=$S4/install.log
say4() { echo "$(date -u +%H:%M:%SZ) $*" | tee -a $LOG4; }
# The production guest units: name, state and each unit's MainPID (a restart under the same name moves the PID). The
# FATAL diff. FAILS CLOSED (enclave-e3): errexit does not reach into $(...), and a systemctl that cannot reach the user
# bus prints nothing, so an unreadable state must never compare equal to itself. Exactly the 3 canary units, each
# active/running with a non-zero MainPID.
units() {
  local l u n=0 out="" pid
  l=$(systemctl --user list-units --plain --no-legend --all 'm2-gd*') || return 1
  while read -r u _ a s _; do
    [ -n "$u" ] || continue
    pid=$(systemctl --user show "$u" -p MainPID --value) || return 1
    [ "$a $s" = "active running" ] && [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
    out+="$u $a $s $pid"$'\n'; n=$((n+1))
  done <<<"$l"
  [ $n = 3 ] || return 1
  printf '%s' "$out" | sort
}
# guestd's MainPID (non-zero) and ExecStart (non-empty), then the units; any unreadable part fails the snapshot
snap() {
  local pid ex us
  pid=$(systemctl --user show enclave-guestd.service -p MainPID --value) || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  ex=$(systemctl --user show enclave-guestd.service -p ExecStart --value) || return 1
  [ -n "$ex" ] || return 1
  us=$(units) || return 1
  echo "$pid $ex|${us//$'\n'/;}"
}
# the installed tree is d1a38994 with no tracked change and no untracked file (ignored build products such as m4/.bundle
# are what guestd's own builds leave, as in the live tree) and no lab pins
tree_ok() {
  [ "$(git -C "$T" rev-parse HEAD 2>/dev/null)" = "$IMG" ] || { say4 "tree: HEAD is not $IMG"; return 1; }
  [ -z "$(git -C "$T" status --porcelain)" ] || { say4 "tree: tracked changes or untracked files"; return 1; }
  [ ! -e "$T/isolation/m2/release/labpins" ] || { say4 "tree: lab pins present"; return 1; }
}
# 1d: guestd's own template build from the INSTALLED tree, with the unit's environment, reproduces the release
reproduces() {
  local d out; d=$(mktemp -d)
  out=$(cd "$T" && env -u GOFLAGS -u ISOLATION_LAB_FRONT sh isolation/m4/domain-release.sh "$d/r" 2>&1 | tail -5); rm -rf "$d"
  echo "$out" >> $LOG4; echo "$out" | grep -q "release $REL" || { say4 "1d: the installed tree does NOT reproduce $REL on this host"; return 1; }
}
# no lab on this host: no m2-lb* unit, no process running from the lab dirs, and no guestd but the unit's own
lab_quiet() {
  [ -z "$(systemctl --user list-units --plain --no-legend --all 'm2-lb*')" ] || { say4 "a lab (m2-lb*) is running"; return 1; }
  local main d e; main=$(systemctl --user show enclave-guestd.service -p MainPID --value)
  for d in /proc/[0-9]*; do
    e=$(readlink "$d/exe" 2>/dev/null) || continue
    case "$e" in "$HOME"/enclave-bench/lab-release/*) say4 "a lab process runs: ${d#/proc/} $e"; return 1;; esac
    case "${e##*/}" in guestd*) [ "${d#/proc/}" = "$main" ] || { say4 "a second guestd runs: ${d#/proc/} $e"; return 1; };; esac
  done
}
