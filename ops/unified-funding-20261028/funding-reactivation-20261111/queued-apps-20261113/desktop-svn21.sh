#!/bin/bash
# Move the NucBox to the native desktop release SVN21 (df63b626...), in which a Moonlight that pairs with the KVM Box
# desktop a second time stays paired (the guest's inner gateway and desktop automation service changed; enclave-apps
# pull request 9). Made from desktop-svn20.sh; desktop-svn19.sh has the history of each guard below. The NucBox side
# of every step is desktop-svn21.ps1, beside this file.
#
#   desktop-svn21.sh status          read only: launchers, manager, staged files, both policies, marker
#   desktop-svn21.sh stage           copy the release files to the NucBox and check them there; nothing running changes
#   desktop-svn21.sh fetch           read only: can the NucBox node's own fetcher get the controller
#   desktop-svn21.sh policy          control VM: admit SVN21 in the relay's Shield policy; restarts the relay
#   desktop-svn21.sh hostpolicy      NucBox: admit SVN21 in the host's own Shield policy; restarts its network agent
#   desktop-svn21.sh switch          NucBox: switch the Shield manager, wait, pin the Node; writes the marker when settled
#   desktop-svn21.sh settle          NucBox, read only: wait until it is back on SVN21, then write the marker
#   desktop-svn21.sh retry           ask the NucBox to claim KVM Box again (what Resume on the site sends), watch the launch
#   desktop-svn21.sh launch          read only: the desktop VM and what the node and the agent last logged for KVM Box
#   desktop-svn21.sh passes          read only: when the node started and last wrote an enrollment line
#   desktop-svn21.sh revert          NucBox: back to SVN20, Shield manager first, then the Node
#   desktop-svn21.sh hostpolicy-revert   NucBox: the previous host policy back; restarts its network agent
#   desktop-svn21.sh policy-revert   control VM: the previous policy file back; restarts the relay
#
# Order: stage; policy; hostpolicy; switch; then launch, and retry when the node gave the deployment up on the way.
# There is no owner signature in this release: the controller, its CID and the catalog version (2, label 0.9.2) are
# SVN20's. The relay and the node derive the desktop's app identity from the release their policy admits
# (relay/shield-app-verifier.mjs, network/shield-expectation.mjs), so the identity moves with the two policies and
# the image the manager loads. Each step refuses, with nothing changed, unless the one before it is in place:
# hostpolicy wants the relay on SVN21, switch wants the relay and the host both on SVN21 and the controller
# fetchable by the node.
#
# What it costs. policy: the relay restarts, host tunnels drop for some seconds, and SVN20 is no longer admitted, so
# KVM Box is down from here until the SVN21 desktop has launched and enrolled. hostpolicy: the network agent restarts
# (about 10 s, then its first chain read): the apps on the box have no route for that long. Each agent restart also
# leaves the running circuits' entries in the box's loopback-exemption list, which holds 682; nucbox-loopback.sh
# status reads how full it is. switch: the Shield manager restart gives every app VM on the NucBox a fresh boot
# (12 minutes for the whole SVN20 switch on 2026-11-14); the Node is restarted only after that has settled, never
# close to it (desktop-svn19.sh says what happened when it was). Going back costs the same again. The node does
# not keep the KVM Box lease across the switch: in the SVN20 switch it released it as soon as the manager loaded an
# image other than its pin, and stayed blocked after its own restart. So retry follows the switch: one claim from
# the app's gas reserve, sent a minute before the node's next enrollment pass. SVN21 passed an isolated KVM run and its pairing change
# was exercised against the guest's Sunshine binary in a sandbox; like SVN20 it has not been qualified on the
# NucBox's hardware. The marker says the host loads SVN21 with no recovered VM left; it does not say every app is back.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
ACT=${ACT:-/home/steven/Documents/Codex/2026-10-23/it/work/native-pair-image-v17/activation}
EXPORT=${EXPORT:-/home/steven/Documents/Codex/2026-10-23/it/outputs/kvm-box/native-platform-v17-pair-again}
CVM=${CVM:-/vm/enclave-volumes/rpc-snp-release-r14/cvm.sh}
NEW=df63b6266e5528c04e9be7d335296013ba6fecb4e0c94d7d1dd183e8637ca28a
CID=bafybeig564vcjghux3gnfgzpcdddtxl6mlvrzelmhe7qnapi7ejnsmpoxa
OLD_POLICY=54fed2c8eadd809770103ee63efdfd99540611efcfe0d99f3362b4f13c3ce60e
NEW_POLICY=2d245e6566f1e98389379430ed49de45c6583601ec7157023a884fddeceb0540
DEST="C:/ProgramData/Enclave/native-desktop/releases/$NEW"
KVM=0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b
HINT=${HINT:-https://api.enclave.host/v1/claim-hint}
MARKER=$ACT/switched.json
LOG=$ACT/host-switch.log
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 minipc)

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
stop() { say "STOP: $*"; exit 1; }
quiet() { sed '/post-quantum\|store now\|openssh.com\/pq/d'; }

# box MODE [POWERSHELL LINE]: run one mode of desktop-svn21.ps1 on the NucBox; what it printed is left in $OUT
# BOX_TIMEOUT=SECONDS ends a read-only call that hangs (one did, for ten minutes, on 2026-11-14); 0 is no limit.
box() {
  { printf "\$mode='%s'\n%s\n" "$1" "${2:-}"; cat "$here/desktop-svn21.ps1"; } |
    timeout "${BOX_TIMEOUT:-0}" "${SSH[@]}" 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"' 2>&1 |
    tr -d '\r' | quiet | tee "$OUT" | tee -a "$LOG" || true
}
did() { grep -q "^$1" "$OUT"; }

local_files() {
  python3 -I - "$ACT" "$EXPORT" <<'PY'
import hashlib, json, os, sys
act, export = sys.argv[1:]
for name, want in json.load(open(os.path.join(act, "prepared.json")))["stage"].items():
    if "copyFrom" in want: continue
    p = os.path.join(act if os.path.exists(os.path.join(act, name)) else export, name)
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    if os.path.getsize(p) != want["bytes"] or h.hexdigest() != want["sha256"]: sys.exit("%s is not the prepared file" % p)
    print(p)
PY
}

# the prepared host policy into the release folder, where the SVN20 release keeps its own; nothing reads it there
stage_policy() {
  [ "$(sha256sum "$ACT/shield-policy.json" | cut -d' ' -f1)" = "$NEW_POLICY" ] || stop "$ACT/shield-policy.json is not the prepared policy; nothing changed"
  BOX_TIMEOUT=120 box staged-policy
  if did 'DONE policy staged'; then return; fi
  say "copying shield-policy.json to the release folder"
  scp -q -o BatchMode=yes -o ConnectTimeout=15 "$ACT/shield-policy.json" "minipc:$DEST/shield-policy.json" 2>&1 | quiet | tee -a "$LOG"
  BOX_TIMEOUT=120 box staged-policy; did 'DONE policy staged' || stop "the staged policy did not verify on the NucBox; nothing running was changed"
}

stage() {
  local files; files=$(local_files) || stop "the local release files do not match prepared.json; nothing copied"
  box verify
  if did 'DONE staged'; then say "already staged"; stage_policy; return; fi
  box prepare; did 'DONE prepare' || stop "the release folder could not be prepared"
  local f
  for f in $files; do
    say "copying $(basename "$f") ($(stat -c %s "$f") bytes)"
    scp -q -o BatchMode=yes -o ConnectTimeout=15 "$f" "minipc:$DEST/$(basename "$f")" 2>&1 | quiet | tee -a "$LOG"
  done
  box verify; did 'DONE staged' || stop "the staged files did not verify on the NucBox"
  stage_policy
  say "staged; nothing running was changed"
}

answers() {
  local a
  for a in ef514ed3 7ae476a3 d9798e4c a77d0c57 a69dcbba 59f1273d c13d4b6a 38f368d6 "${KVM:2:8}"; do
    say "  $a.app.enclave.host: $(curl -s -m 20 -o /dev/null -w '%{http_code} in %{time_total} s' "https://$a.app.enclave.host/" || true)"
  done
}

# The NucBox's own Shield policy (desktop-svn21.ps1 says who reads it). Restarts the network agent, nothing else.
hostpolicy() {
  local mode=$1
  if [ "$mode" = hostpolicy ]; then stage_policy; [ "$(policy_sha)" = "$NEW_POLICY" ] || stop "the relay does not admit SVN21: run '$0 policy' first (nothing changed)"; fi
  box "$mode"; did 'DONE hostpolicy' || stop "the host policy step did not finish; see the lines above"
  say "public answers (the apps on the NucBox are slow or absent until the agent has its circuits and a chain read):"
  answers
}

host_admits() { BOX_TIMEOUT=120 box status; did 'host policy: SVN21' && did 'network agent started: after'; }

# The installed node (before 206f85fd5) writes a relaunched app's new expectation only in an enrollment pass: 60 s
# after the node starts, then 300 s after each pass ends (about 305 s apart; every '[network]' line in node.log is a
# pass's). A launch waits about two minutes for it: on 2026-11-14 a hint 86 s before a pass ran, one sent with no
# pass inside 190 s was given up. So the hint goes out a minute before the next pass is due. RETRY_NOW=1 does not wait.
wait_for_pass() {
  BOX_TIMEOUT=100 box passes
  local s n last anchor due k=0 w
  read -r s n last < <(sed -n 's/^DONE passes \([0-9]*\) \([0-9]*\) \([0-9]*\)$/\1 \2 \3/p' "$OUT") || true
  [ -n "${last:-}" ] || stop "the node's start time could not be read on the NucBox; nothing sent"
  anchor=$((s+60)); [ "$last" -gt "$anchor" ] && anchor=$last
  while :; do due=$((anchor + k*3052/10)); [ $((due-60)) -ge $((n+5)) ] && break; k=$((k+1)); done
  w=$((due-60-n))
  say "the node's next enrollment pass is due about $(date -u -d "@$due" +%H:%M:%SZ) (cycle $k from $(date -u -d "@$anchor" +%H:%M:%SZ)); the hint goes out in $w s"
  sleep "$w"
}

# A deployment the node gave up on stays blocked there until a forced claim hint names it. Each try costs the app a
# claim (paid from its gas reserve through the lease relay; eight a day), and a release if the launch fails, so this
# refuses while the box would launch the old image or refuse the release again.
retry() {
  on_new || stop "the NucBox does not load SVN21 in both launchers and the manager: a claim now would be given up again. Run '$0 switch' first (nothing sent)"
  did 'host policy: SVN21' && did 'network agent started: after' || stop "the NucBox's own policy does not admit SVN21, or its agent has not read it: run '$0 hostpolicy' first (nothing sent)"
  [ -n "${RETRY_NOW:-}" ] || wait_for_pass
  local since a i; since=$(date -u +%H:%M:%S)
  a=$(curl -s -m 90 -X POST -H 'content-type: application/json' -d "{\"id\":\"$KVM\",\"force\":true}" "$HINT" | tr -d '\n' | cut -c1-500) || true
  say "claim hint sent; the relay answered: ${a:-nothing}"
  for i in $(seq 1 24); do
    sleep 20
    BOX_TIMEOUT=100 box launch "\$since='$since'"
    if did 'DONE launch running'; then say "KVM Box runs on the NucBox"; answers; return; fi
    if did 'DONE launch gave-up' || grep -q 'giving up on 0x9a28642b' "$OUT"; then stop "the node gave up on the launch again; see its lines above"; fi
  done
  stop "no running desktop VM within eight minutes; '$0 launch' reads the state again"
}

# The relay reads the policy once, at start. The file is replaced only from the exact file expected, the previous one
# is kept, and if the relay is not healthy on the new one within three minutes the previous one is put back.
policy() {
  local mode=$1 b64=
  if [ "$mode" = apply ]; then
    [ "$(sha256sum "$ACT/shield-policy.json" | cut -d' ' -f1)" = "$NEW_POLICY" ] || stop "$ACT/shield-policy.json is not the prepared policy; nothing changed"
    b64=$(base64 -w0 "$ACT/shield-policy.json")
  fi
  { printf 'MODE = "%s"\nB64 = "%s"\nOLD = "%s"\nNEW = "%s"\n' "$mode" "$b64" "$OLD_POLICY" "$NEW_POLICY"; cat <<'PY'; } | CVM_TIMEOUT=600 "$CVM" 'sudo -n python3 -I -' 2>&1 | quiet | tee "$OUT" | tee -a "$LOG" || true
import base64, hashlib, json, os, subprocess, sys, time, urllib.request
F = "/etc/nan-relay/shield-policy.json"; BAK = "/etc/nan-relay/shield-policy.before-native-svn21-20261114.json"
ALLOW = "/etc/enclave-control/ALLOW_CONTROL_START"; UNIT = "enclave-api-relay"
sha = lambda b: hashlib.sha256(b).hexdigest()
def health():
    try: return json.load(urllib.request.urlopen("http://127.0.0.1:8100/health", timeout=5))
    except Exception: return None
def line(h): return "no answer" if h is None else "ok=%s enclaves=%s of %s" % (h.get("ok"), h.get("enclaves"), h.get("of"))
def wait(seconds):
    h = None
    for _ in range(seconds // 5):
        time.sleep(5); h = health()
        if h and h.get("ok") is True: break
    return h
def put(data):
    st = os.stat(F); tmp = F + ".new"
    with open(tmp, "wb") as f: f.write(data)
    os.chmod(tmp, st.st_mode & 0o777); os.chown(tmp, st.st_uid, st.st_gid); os.replace(tmp, F)
    subprocess.run(["systemctl", "restart", UNIT], check=True)
def stop(why): print("STOP: " + why); sys.exit(0)

live = open(F, "rb").read(); before = health()
source, target = (OLD, NEW) if MODE == "apply" else (NEW, OLD)
print("relay before: %s; policy %s" % (line(before), sha(live)[:16]))
if sha(live) == target:
    print("DONE policy (the file is already this one; relay %s)" % line(before)); sys.exit(0)
if sha(live) != source: stop("the live policy is neither the previous nor the new file; nothing changed")
if not os.path.exists(ALLOW): stop("the control VM does not allow the relay to start (%s is missing); nothing changed" % ALLOW)
if not (before and before.get("ok") is True): stop("the relay is not healthy now; nothing changed")
if MODE == "apply":
    data = base64.b64decode(B64)
    if sha(data) != NEW: stop("the policy that arrived is not the prepared one; nothing changed")
    if not os.path.exists(BAK):
        with open(BAK, "wb") as f: f.write(live)
        os.chmod(BAK, 0o644)
    if sha(open(BAK, "rb").read()) != OLD: stop("the kept copy %s is not the previous policy; nothing changed" % BAK)
else:
    if not os.path.exists(BAK): stop("no previous policy was kept; nothing changed")
    data = open(BAK, "rb").read()
    if sha(data) != OLD: stop("the kept copy is not the previous policy; nothing changed")
put(data)
after = wait(180)
print("relay after the restart: " + line(after))
if after and after.get("ok") is True:
    print("DONE policy %s (previous file kept as %s)" % (sha(data)[:16], os.path.basename(BAK))); sys.exit(0)
print("the relay is not healthy on this policy: putting the file back")
put(live)
again = wait(180)
log = subprocess.run(["journalctl", "-u", UNIT, "-n", "30", "--no-pager", "-o", "cat"], capture_output=True, text=True).stdout
for l in log.splitlines():
    if not any(w in l.lower() for w in ("key", "secret", "token", "password")): print("  " + l[:220])
stop("the policy was not changed; the file is back as it was and the relay reports " + line(again))
PY
  did 'DONE policy' || stop "the relay policy step did not finish; see the lines above"
}

policy_sha() { CVM_TIMEOUT=60 "$CVM" 'sha256sum /etc/nan-relay/shield-policy.json' 2>/dev/null | cut -d' ' -f1; }

# Can the node get the controller: its own fetcher on the NucBox, through its own source list, every block hashed
# (the ps1's fetch mode). Not asked from this host: the edges and the local replica hold a fixed set and answer 404
# for any app component, so only the gateway app serves it. It is the controller SVN20 runs, uploaded for 0.9.2.
fetchable() { box fetch; did 'DONE fetch'; }

# settle WANT new|old [FIRST_WAIT]: poll the ps1's settled mode until it says yes twice running, 35 minutes at most
settle() {
  local want=$1 to=$2 yes=0 i
  say "waiting for the NucBox to settle ($want app VMs before): no recovered partition, RAM known, node quiet"
  sleep "${3:-240}"
  for i in $(seq 1 60); do
    BOX_TIMEOUT=120 box settled "\$want=$want; \$to='$to'"
    if did 'SETTLED yes'; then yes=$((yes+1)); [ $yes -ge 2 ] && return 0; else yes=0; fi
    sleep 30
  done
  return 1
}

mark() {
  printf '{"igvmSha256":"%s","at":"%s"}\n' "$NEW" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MARKER"
  rm -f "$ACT/switch-want"
  say "DONE: the NucBox loads SVN21 and has settled. Nothing to sign: '$0 launch' reads whether KVM Box runs"
}

# both launchers name SVN21 and the manager reports it (the ps1's status mode)
on_new() { BOX_TIMEOUT=120 box status; did 'run-node.cmd names:   new' && did 'run-shield.cmd names: new' && grep -q '^manager: .*igvm=df63b6266e55' "$OUT"; }

# Restarts nothing. For a switch whose restarts are done and whose wait ran out or was interrupted.
settle_only() {
  [ "${1:-}" = checked ] || on_new || stop "the NucBox is not on SVN21 in both launchers and the manager: this waits only, run '$0 switch' (nothing changed)"
  local want=0; [ -s "$ACT/switch-want" ] && want=$(cat "$ACT/switch-want")
  settle "$want" new 0 || stop "the NucBox had not settled within 35 minutes; the marker is not written. Run '$0 settle' again to keep waiting"
  mark
}

switch() {
  if on_new; then say "both launchers and the manager are on SVN21 already: waiting only"; settle_only checked; return; fi
  [ "$(policy_sha)" = "$NEW_POLICY" ] || stop "the relay does not admit SVN21 yet: run '$0 policy' first (nothing changed)"
  host_admits || stop "the NucBox's own policy does not admit SVN21, or its agent has not read it: run '$0 hostpolicy' first (nothing changed)"
  say "can the node fetch the controller $CID?"
  fetchable || stop "the node's fetcher on the NucBox cannot get the controller; nothing changed"
  local want
  if [ -s "$ACT/switch-want" ]; then want=$(cat "$ACT/switch-want")
  else box count; want=$(sed -n 's/^DONE count \([0-9]*\)$/\1/p' "$OUT"); [ -n "$want" ] || stop "the manager's VM list could not be read; nothing changed"; echo "$want" > "$ACT/switch-want"; fi
  say "switching the Shield manager to SVN21"
  box shield; did 'DONE shield' || stop "the Shield manager is on the release it was on; see the lines above"
  settle "$want" new || stop "the NucBox had not settled within 39 minutes; the Node is not pinned and the marker is not written. Run '$0 switch' again to keep waiting"
  say "pinning the Node to SVN21"
  box node; did 'DONE node' || stop "the Node step did not finish; see the lines above"
  settle "$want" new 120 || stop "the NucBox had not settled after the Node restart within 37 minutes; the marker is not written. Run '$0 settle' to keep waiting"
  mark
}

revert() {
  local want
  box count; want=$(sed -n 's/^DONE count \([0-9]*\)$/\1/p' "$OUT"); [ -n "$want" ] || want=0
  [ -f "$MARKER" ] && mv "$MARKER" "$MARKER.reverted-$(date -u +%Y%m%dT%H%M%SZ)"
  box revert-shield; did 'DONE shield' || stop "the Shield manager step did not finish; see the lines above"
  settle "$want" old || stop "the NucBox had not settled within 39 minutes; the Node is still pinned to SVN21. Run '$0 revert' again to keep waiting"
  box revert-node; did 'DONE node' || stop "the Node step did not finish; see the lines above"
  say "the NucBox is back on SVN20. Still to do for KVM Box to run: '$0 hostpolicy-revert', then '$0 policy-revert'. Nothing was signed for SVN21, so nothing is promoted back"
}

status() {
  BOX_TIMEOUT=120 box status
  local p; p=$(policy_sha) || true
  if [ "$p" = "$NEW_POLICY" ]; then say "relay policy: SVN21"; elif [ "$p" = "$OLD_POLICY" ]; then say "relay policy: SVN20 (previous)"
  elif [ -z "$p" ]; then say "relay policy: not read"; else say "relay policy: another file ${p:0:16}"; fi
  say "marker: $([ -f "$MARKER" ] && cat "$MARKER" || echo none)"
}

mkdir -p "$ACT"
case ${1:-} in
  status) status;;
  stage) stage;;
  fetch) say "can the node fetch the controller $CID?"; fetchable && say "yes" || stop "the node's fetcher on the NucBox cannot get the controller";;
  policy) policy apply;;
  policy-revert) policy revert;;
  switch) switch;;
  settle) settle_only;;
  revert) revert;;
  hostpolicy|hostpolicy-revert) hostpolicy "$1";;
  retry) retry;;
  launch) BOX_TIMEOUT=100 box launch;;
  passes) BOX_TIMEOUT=100 box passes;;
  *) sed -n 2,40p "$0"; exit 2;;
esac
