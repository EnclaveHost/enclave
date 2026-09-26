# Shared constants and checks for S8 (sourced AFTER ../pool-rollout-20260925/lib.sh, and LAST): release 5db18199, built by
# enclave-53 from image commit 0c087de8 (per-release W^X: the runtime states its W^X self-test AT ATTEST, dominit's app
# seccomp; bf reviewed). Unlike S5/S7 this is a guestd UPGRADE too: 4e78ba80 -> 0c087de8 (the per-release naming flags,
# main.go:310-312), and the tree's judge/client change with it (the only boot-path files that differ from iso-b63c2def,
# checked in s8t-apply.sh). It follows iso-b63c2def (f7888d86, live since S7).
REL=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77; IMG=0c087de8213ddd6ac7b8ed7e472b02ad23672bd5
SRC=/home/steven/enclave-bench/pub-0181bce3/cut-0c087de8/release-0c087de8
T=$PROD/iso-0c087de8; R=$PROD/release-0c087de8; LEG=$PROD/iso-03be27d6/isolation; LEGC=0181bce3aac5fa03dfaf2928d834ecd04d2a4a73
FLOOR=16384   # Codex: the host floor for THIS 64 GiB pool at its next coordinated guestd rollout, which 4d is
# the reviewed host-memory floor (enclave-63): a 4d guestd must be built from a commit carrying both
FLOORC="d67b0020c8fd58166392e85bf315e4bb15404183 1b5375c9f9718d346d4c5511d7a9bc3096d5551f d36e8da70b13e2fbb602a2ca9be9c85099efd631 ee8dbbcd494229f843cf92b99ac542cdfd77d755"
MAIN=/home/steven/Projects/enclave; S4=$HOME/enclave-bench/s8-20260926; LOG4=$S4/install.log
OT=$PROD/iso-b63c2def; OREL=f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca; OIMG=b63c2def6e9b12088c30594b8cb58c7273903a60
# Logging NEVER fails (enclave-e3 A3): under set -e a failed log write (disk full, quota) would otherwise exit before a
# rollback runs. The line always reaches the terminal; the file is best effort. S4 replaces lib.sh's say the same way.
say4() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG4"; } 2>/dev/null || true; }
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$EV/rollout.log"; } 2>/dev/null || true; }
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
# the installed tree is 0c087de8 with no tracked change and no untracked file (ignored build products such as m4/.bundle
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

# ---- S8 is a guestd UPGRADE as well as a tree switch (enclave-87): the new binary, built from the release's own commit
NBINC=0c087de8213ddd6ac7b8ed7e472b02ad23672bd5; NBIN=$PROD/bin/guestd.0c087de8
OBINC=4e78ba80db7ac14a2d27fd65d495b8feb036ca23; OBIN=$PROD/bin/guestd.4e78ba80; OBSHA=0ee7ed91e5066a0cbe7a4b528250342c354722a84202d043d03c5ee6dbec3086
# its per-release naming flags (b4; isolation/m4/guestd/main.go:310-312 at 0c087de8), in the DERIVED form for the trees
# (enclave-bf: the id is sha256 of the release.json actually installed; a pre-chain tree is refused unless named so):
ISOREL_ARG=@$PROD/release-0c087de8/release.json
LEGREL_ARG=@$PROD/release-0181bce3/release.json,@$PROD/release-6757d139/release.json
# the one TYPED list: the releases an earlier guestd's records (the running canaries') are named by on adoption
UNREC=f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca,5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2,6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb
# the typed list equals the derived set: release-b63c2def (f7888d86), release-0181bce3 (5c3561f9), release-6757d139 (6f14ce75)
unrec_ok() {
  local want got
  want=$(tr , '\n' <<<"$UNREC" | sort | paste -sd,)
  got=$(for d in release-b63c2def release-0181bce3 release-6757d139; do sha256sum < $PROD/$d/release.json | cut -c1-64; done | sort | paste -sd,)
  [ "$want" = "$got" ] && [ "$(sha256sum < $PROD/release-0c087de8/release.json | cut -c1-64)" = "$REL" ]
}
