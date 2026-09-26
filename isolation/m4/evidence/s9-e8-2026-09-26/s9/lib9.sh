# Shared constants and checks for S9 (sourced AFTER ../pool-rollout-20260925/lib.sh, and LAST): release aee2059f, 53's cut
# from isolation/seccomp-evidence 4cd26e58 (47b7b520, bf GO, + b4's f7888d86 removal; d1 GO inside N2): the runtime's
# seccomp filter STATED at attest (seccomp=<hash>), per-release seccomp tables in judge.mjs. A guestd UPGRADE too:
# 0c087de8 -> 4cd26e58 (main.go: releaseNamingRefusal, `none`), and the tree's judge changes with it (the only boot-path
# file that differs from iso-0c087de8, checked in s9t-apply.sh). It follows iso-0c087de8 (5db18199, live since S8).
REL=aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532; IMG=4cd26e58bf44958fdf37b063408640f35596dc02
SRC=/home/steven/enclave-bench/pub-0181bce3/cut-4cd26e58/release-4cd26e58
T=$PROD/iso-4cd26e58; R=$PROD/release-4cd26e58; LEG=$PROD/iso-03be27d6/isolation; LEGC=0181bce3aac5fa03dfaf2928d834ecd04d2a4a73
FLOOR=16384   # Codex: the host floor for THIS 64 GiB pool at its next coordinated guestd rollout, which 4d is
# the reviewed host-memory floor (enclave-63): a 4d guestd must be built from a commit carrying both
FLOORC="d67b0020c8fd58166392e85bf315e4bb15404183 1b5375c9f9718d346d4c5511d7a9bc3096d5551f d36e8da70b13e2fbb602a2ca9be9c85099efd631 ee8dbbcd494229f843cf92b99ac542cdfd77d755"
MAIN=/home/steven/Projects/enclave; S4=$HOME/enclave-bench/s9-20260926; LOG4=$S4/install.log
OT=$PROD/iso-0c087de8; OREL=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77; OIMG=0c087de8213ddd6ac7b8ed7e472b02ad23672bd5
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
# the installed tree is 4cd26e58 with no tracked change and no untracked file (ignored build products such as m4/.bundle
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

# ---- S9 is a guestd UPGRADE as well as a tree switch (enclave-87; b4's v44 manifest items 3-6): the new binary, built from
# the release's own commit; the live one (S8's) is the rollback binary
NBINC=4cd26e58bf44958fdf37b063408640f35596dc02; NBIN=$PROD/bin/guestd.4cd26e58
OBINC=0c087de8213ddd6ac7b8ed7e472b02ad23672bd5; OBIN=$PROD/bin/guestd.0c087de8; OBSHA=fda353c918a7bada77d65efedc8c7855417f1e1a217fd9dcdc2d65ce56f10767
# the per-release naming (b4 item 5: KEPT, DERIVED @ form): this tree's release, and the legacy tree's two
ISOREL_ARG=@$PROD/release-4cd26e58/release.json
LEGREL_ARG=@$PROD/release-0181bce3/release.json,@$PROD/release-6757d139/release.json
# the LIVE (S8) line's values, asserted before the edit and restored by the rollback
OISOREL_ARG=@$PROD/release-0c087de8/release.json
OUNREC=f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca,5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2,6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb
# b4 item 6: -unrecorded-releases is DROPPED ENTIRELY: every guestd record names its release (all 3 canaries record
# [5db18199] since e7); records_named() proves it at the switch (the pairing, item 4: none names f7888d86 either)
records_named() {
  local d n=0
  for d in $PROD/guestd-root/gd*/; do
    [ -f "$d/instance.json" ] || continue
    python3 -c "import json,sys; r=json.load(open(sys.argv[1])); rel=r.get('Releases'); sys.exit(0 if isinstance(rel,list) and rel and 'f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca' not in rel else 1)" "$d/instance.json" \
      || { say4 "records: ${d%/} has no Releases, or names f7888d86"; return 1; }
    n=$((n+1))
  done
  [ $n = 3 ] || { say4 "records: $n guestd records, not the 3 canaries'"; return 1; }
}
# the release files are what the flags derive: this tree's = REL, the legacy tree's two = 5c3561f9, 6f14ce75
rel_ok() {
  [ "$(sha256sum < $PROD/release-4cd26e58/release.json | cut -c1-64)" = "$REL" ] \
    && [ "$(for f in ${LEGREL_ARG//,/ }; do sha256sum < "${f#@}" | cut -c1-64; done | paste -sd' ')" = "5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2 6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb" ]
}
# the node since N2-b: N2 (fab9c6c7, overlay 6845565a) on the unchanged launcher (4c-c-b's worktree and blob); S9's
# pre- and post-checks require it (node_on_4cc names the pre-N2 image and would refuse)
NODEM=fab9c6c76aca8d7650c05d5efdddc27b4b5aa76e7d81cd5c97365458513aedcf70ffe7d2817ac3836575b34917954bb0; NODEC=6845565a9dc0df5d8b469b8f2e74699c1aaa3444
node_on_n2() { [ "$(node_attested)" = "$NODEM $NODEC" ] && node_runs_from /home/steven/enclave-prod/metal-578be084 4620da5da0b4bf3e7e6c7a531d5957d96511b480b715ed6a1b260dc53a947196; }
# the canaries' CURRENT keys (enclave-bf's rule, as in n2b-rollback.sh): n2acc relaunched hookbin and recorded its new key
# in ITS state (a copy of e7's); once that differs from e7's it is current. Sourced after lib-e7.sh, so it overrides
# lib-e7's KEYS4/TSV4 for check_guestd4 (TSV4) and public_ok4 (KEYS4). Before e8 only; after an e8 relaunch: OVERRIDE.
NAK=~/enclave-bench/n2acc-20260926/state
if [ -f "$NAK/canary-keys.txt" ] && [ -f "$NAK/canaries.tsv" ] && ! { cmp -s "$NAK/canary-keys.txt" "$KEYS4" && cmp -s "$NAK/canaries.tsv" "$TSV4"; }; then
  KEYS4=$NAK/canary-keys.txt; TSV4=$NAK/canaries.tsv
fi
