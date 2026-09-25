# 4c-c (sourced AFTER ../pool-rollout-20260925/lib.sh): the RELEASE-CAPABLE node image f6cbd75a (its 8 supervisor files = b18f8989's;
# gsup passes ISOLATION_RELEASE=1 when the host config's isolation.release is true), replacing 4c's b3109929 (the floor merge's
# supervisor half, d1's row-6 cert check 059fdec5, the launch-spec guard). Its gate needs the relay's /v1/expected-guest
# (LIVE since 21:02Z, the relay slice). S2's pattern: 4c-a adds the measurement to the relay allowlist beside the S2
# and pre-pool entries (both kept for their soak); 4c-b points dist at the image and restarts the node CVM.
S4C=~/enclave-bench/s4c-20260925; LOGC=$S4C/rollout-cc.log
S2M=10622d989bf4f5f3dc560dd237a845684dbda66269e43f2b2b22b82e6956eca3e4289d8d62e99dc118d51f2a49633782    # kept (S2, c42612c0)
PREM=04e953a4f856c817bd061e3fa91004c78be75f6a9951be44a02805fdd788f19c56c84b046d0fca6aa2085a6f7b99fc7b   # kept (pre-pool)
OLDM=8ab7a1590fad444c53e8bec7a08ea44452e78ed68a30de2283d599879b69feb84cb7fd0bc1cc3aa903514ab7443c30bf   # live (4c, b3109929)
OLDD=/home/steven/Projects/enclave/metal/dist-iso-b3109929; OLDC=b31099294b4916a32f9f43989044c525ca121d7a
NEWD=/home/steven/Projects/enclave/metal/dist-iso-f6cbd75a; NEWC=f6cbd75ae0c2a44163db95b657b351da7504c2d1   # 87e881a2 (gsup release opt-in) + b3109929
NEWM=$(cat $S4C/build-cc/prediction.txt)
ALLOW_NOW="$PREM,$S2M,$OLDM"; ALLOW_NEW="$PREM,$S2M,$OLDM,$NEWM"
CB4=$EV/secret/config.iso.json.bak-pre-4cc
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOGC"; } 2>/dev/null || true; }
# the prediction is the image's own (two identical builds, the hand computation, the overlay = b18f8989, clean)
check_prediction4c() {
  [[ "$NEWM" =~ ^[0-9a-f]{96}$ ]] && [ "$NEWM" != "$OLDM" ] && [ "$NEWM" != "$PREM" ] && [ "$NEWM" != "$S2M" ] || { say "BAD prediction.txt"; return 1; }
  python3 -c "import json,sys; m=json.load(open('$NEWD/manifest.json')); o=m['supervisorOverlay']; sys.exit(0 if m['expectedMeasurement']['byVcpus']['4']=='$NEWM' and m['expectedMeasurement']['ovmfSha256'].startswith('142589cc') and o['commit']=='$NEWC' and o['dirty'] is False and m['reproducible'] is True else 1)" \
    || { say "the image's manifest does not predict prediction.txt with overlay $NEWC"; return 1; }
}
allowlist() { $NAN "grep '^METAL_ALLOWED_MEASUREMENTS=' /etc/nan-relay/api-relay.env"; }
# the published availability after 4c: the pool as before, and NOW the floor's verdict (the 4c supervisor mirrors it)
avail4c() { curl -sS --max-time 20 https://api.enclave.host/t/metal-iso0/availability | python3 -c "import json,sys; a=json.load(sys.stdin); g=a.get('guestPool') or {}; sys.exit(0 if g.get('heard') and a.get('nodeRamGb')==64 and a.get('nodeVcpus')==16 and g.get('budget')=={'memMiB':65536,'cpuPct':1600} and g.get('free')=={'memMiB':60160,'cpuPct':1300} and abs(a.get('cpuShareFree',0)-0.7)<1e-9 and g.get('host')=={'floorMiB':16384,'admitsSmallestGuest':True} else 1)"; }
avail_before() { avail4c; }   # since 4c the published availability already carries the floor verdict
# ---- cc-v2 (after the 22:45Z rollback). The HOST launcher never forwarded isolation.release into the guest's fw_cfg
# (metal/enclave-metal.mjs:157 built {managerUrl, dataAddr, pairingKey} only), so the new gsup logged "attested release
# off". 4c-c-b now ALSO moves the node's WorkingDirectory to a detached worktree at 5d's reviewed launcher fix: a user
# drop-in carrying WorkingDirectory only, ExecStart unchanged (enclave-d1's plan). The launcher imports node builtins only
# and takes its config (--config) and image (cfg.dist) by absolute path, so the swap is like-for-like. iso-03be27d6 stays
# as it is: guestd's -legacy-isolation reads its isolation/. The launcher is host code and unmeasured: 02f6e313 stands.
OLDW=/home/steven/enclave-prod/iso-03be27d6; OLDWC=0181bce3aac5fa03dfaf2928d834ecd04d2a4a73
OLDLS=e1bac93c81be3bcc7ef056b74b6e63c22009a2978ed6161e3eba1ae882f9d93a
LAUNCH_C=$(cat $S4C/launcher-commit.txt 2>/dev/null || true); LAUNCH_SHA=$(cat $S4C/launcher-sha256.txt 2>/dev/null || true)
LW=/home/steven/enclave-prod/metal-${LAUNCH_C:0:8}
DI=/home/steven/.config/systemd/user/enclave-metal-iso.service.d; DROP=$DI/10-launcher.conf
DROP_BODY=$'[Service]\nWorkingDirectory='"$LW"
NODE_CMD='/usr/bin/node|metal/enclave-metal.mjs|--config|/home/steven/Projects/enclave/metal/config.iso.json|'
# the reviewed fix: a 40-hex commit on top of 0181bce3, its worktree clean at it, its launcher = the reviewed blob
check_launcher() {
  local h st s
  [[ "$LAUNCH_C" =~ ^[0-9a-f]{40}$ ]] && [[ "$LAUNCH_SHA" =~ ^[0-9a-f]{64}$ ]] && [ "$LAUNCH_SHA" != "$OLDLS" ] \
    || { say "no reviewed launcher fix (launcher-commit.txt / launcher-sha256.txt)"; return 1; }
  git -C "$LW" merge-base --is-ancestor "$OLDWC" "$LAUNCH_C" || { say "the launcher fix is not on top of 0181bce3"; return 1; }
  h=$(git -C "$LW" rev-parse HEAD) && [ "$h" = "$LAUNCH_C" ] || { say "$LW is not a worktree at ${LAUNCH_C:0:8}"; return 1; }
  st=$(git -C "$LW" status --porcelain) && [ -z "$st" ] || { say "$LW is not clean"; return 1; }
  s=$(sha256sum "$LW/metal/enclave-metal.mjs") && [ "${s%% *}" = "$LAUNCH_SHA" ] || { say "$LW's launcher is not the reviewed blob"; return 1; }
}
# the RUNNING node: its cwd and argv (a failed read prints nothing, which matches no directory)
node_pid() { local p; p=$(systemctl --user show enclave-metal-iso.service -p MainPID --value) && [[ "$p" =~ ^[1-9][0-9]*$ ]] && echo "$p"; }
node_runs_from() {   # $1 = worktree, $2 = the launcher's expected sha256
  local p c s; p=$(node_pid) || return 1
  [ "$(readlink "/proc/$p/cwd")" = "$1" ] && c=$(tr '\0' '|' < "/proc/$p/cmdline") && [ "$c" = "$NODE_CMD" ] \
    && s=$(sha256sum "$1/metal/enclave-metal.mjs") && [ "${s%% *}" = "$2" ]
}
unit_wd() { systemctl --user show enclave-metal-iso.service -p WorkingDirectory --value; }
