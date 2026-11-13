#!/bin/bash
# Move the NucBox to the native desktop release SVN19 (de9e87e3...), the one whose controller carries the KVM Box
# page with the terminal, the one Start/Stop button and the corrected Open desktop link. The NucBox side of every
# step is desktop-svn19.ps1, beside this file.
#
#   desktop-svn19.sh status          read only: launchers, manager, staged files, relay policy, marker, signing page
#   desktop-svn19.sh stage           copy the release files to the NucBox and check them there; nothing running changes
#   desktop-svn19.sh fetch           read only: can the NucBox node's own fetcher get the new controller
#   desktop-svn19.sh policy          control VM: admit SVN19 in the relay's Shield policy; restarts the relay
#   desktop-svn19.sh switch          NucBox: pin the Node, then switch the Shield manager; writes the marker when settled
#   desktop-svn19.sh revert          NucBox: back to SVN18, Shield manager first, then the Node
#   desktop-svn19.sh policy-revert   control VM: the previous policy file back; restarts the relay
#
# Order: stage; the owner signs upload, publish and approve on the signing page; policy; switch; the owner signs the
# promote, which the page offers once the marker exists.
#
# What it costs. policy: the relay restarts, host tunnels drop for some seconds, and SVN18 is no longer admitted, so
# KVM Box is down from here until the promote. switch: the Node restart is refused the desktop only; the Shield
# manager restart gives every app VM on the NucBox a fresh boot (about eight minutes on 2026-11-13). Going back costs
# the same again. SVN19 passed an isolated KVM run; it has not been qualified on the NucBox's hardware.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
ACT=${ACT:-/home/steven/Documents/Codex/2026-10-23/it/work/native-terminal-image-v15/activation}
EXPORT=${EXPORT:-/home/steven/Documents/Codex/2026-10-23/it/outputs/kvm-box/native-platform-v15-owner-terminal}
CVM=${CVM:-/vm/enclave-volumes/rpc-snp-release-r14/cvm.sh}
SIGN=${SIGN:-http://127.0.0.1:42291}
NEW=de9e87e32cbacfa0dddb27422a36733dddadb3b87268aa14d7cc109bf9a1802e
CID=bafybeidkdt5kv3bkyygeyofbkoo3abqd2oi7o5wgcsbrkodmjf5q3zzub4
OLD_POLICY=e41ac8960c5112e55770c9350d85e135e15184e90d5a22790906791b6a4f911b
NEW_POLICY=a0e735027bb3d04cfb037574485206673a7cda8f7b81eda73d43eac7d995e3ee
DEST="C:/ProgramData/Enclave/native-desktop/releases/$NEW"
MARKER=$ACT/switched.json
LOG=$ACT/host-switch.log
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 minipc)

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
stop() { say "STOP: $*"; exit 1; }
quiet() { sed '/post-quantum\|store now\|openssh.com\/pq/d'; }

# box MODE [POWERSHELL LINE]: run one mode of desktop-svn19.ps1 on the NucBox; what it printed is left in $OUT
box() {
  { printf "\$mode='%s'\n%s\n" "$1" "${2:-}"; cat "$here/desktop-svn19.ps1"; } |
    "${SSH[@]}" 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"' 2>&1 |
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

stage() {
  local files; files=$(local_files) || stop "the local release files do not match prepared.json; nothing copied"
  box verify
  if did 'DONE staged'; then say "already staged"; return; fi
  box prepare; did 'DONE prepare' || stop "the release folder could not be prepared"
  local f
  for f in $files; do
    say "copying $(basename "$f") ($(stat -c %s "$f") bytes)"
    scp -q -o BatchMode=yes -o ConnectTimeout=15 "$f" "minipc:$DEST/$(basename "$f")" 2>&1 | quiet | tee -a "$LOG"
  done
  box verify; did 'DONE staged' || stop "the staged files did not verify on the NucBox"
  say "staged; nothing running was changed"
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
F = "/etc/nan-relay/shield-policy.json"; BAK = "/etc/nan-relay/shield-policy.before-native-svn19-20261113.json"
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
# (the ps1's fetch mode). The first copy of this check asked each source from this host and wanted two of them; the
# edges and the local replica hold a fixed set and answer 404 for any app component, the SVN18 controller included,
# so that check could never pass and stopped the owner's first switch at 23:42Z with nothing changed.
fetchable() { box fetch; did 'DONE fetch'; }

signed() { curl -s -m 20 "$SIGN/status" | python3 -I -c 'import json,sys; s=json.load(sys.stdin); sys.exit(0 if s.get("publish") is True and s.get("approve") is True else 1)' 2>/dev/null; }

settle() {
  local want=$1 yes=0 i
  say "waiting for the app VMs to come back ($want before; the node gives each a fresh boot)"
  sleep 240
  for i in $(seq 1 40); do
    box settled "\$want=$want"
    if did 'SETTLED yes'; then yes=$((yes+1)); [ $yes -ge 2 ] && return 0; else yes=0; fi
    sleep 30
  done
  return 1
}

switch() {
  if [ "${1:-}" != --unchecked ]; then
    signed || stop "the signing page at $SIGN does not show the new version published and approved: sign steps 1 to 3 there first (nothing changed)"
  fi
  [ "$(policy_sha)" = "$NEW_POLICY" ] || stop "the relay does not admit SVN19 yet: run '$0 policy' first (nothing changed)"
  say "can the node fetch the controller $CID?"
  fetchable || stop "the node's fetcher on the NucBox cannot get the controller; nothing changed"
  local want
  if [ -s "$ACT/switch-want" ]; then want=$(cat "$ACT/switch-want")
  else box count; want=$(sed -n 's/^DONE count \([0-9]*\)$/\1/p' "$OUT"); [ -n "$want" ] || stop "the manager's VM list could not be read; nothing changed"; echo "$want" > "$ACT/switch-want"; fi
  say "pinning the Node to SVN19"
  box node; did 'DONE node' || stop "the Node step did not finish; see the lines above"
  say "switching the Shield manager to SVN19"
  box shield
  if ! did 'DONE shield'; then
    say "the manager did not load SVN19: putting the Node back on SVN18"
    box revert-node
    stop "the Shield manager is on the release it was on; see the lines above"
  fi
  settle "$want" || stop "the app VMs were not all back and quiet within 24 minutes; the marker is not written. Run '$0 switch' again to keep waiting"
  printf '{"igvmSha256":"%s","at":"%s"}\n' "$NEW" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MARKER"
  rm -f "$ACT/switch-want"
  say "DONE: the NucBox loads SVN19 and its apps are back. Sign step 4 (promote) on the signing page now"
}

revert() {
  local want
  box count; want=$(sed -n 's/^DONE count \([0-9]*\)$/\1/p' "$OUT"); [ -n "$want" ] || want=0
  [ -f "$MARKER" ] && mv "$MARKER" "$MARKER.reverted-$(date -u +%Y%m%dT%H%M%SZ)"
  box revert-shield; did 'DONE shield' || stop "the Shield manager step did not finish; see the lines above"
  settle "$want" || say "the app VMs were not all back and quiet within 24 minutes; '$0 status' shows where they are"
  box revert-node; did 'DONE node' || stop "the Node step did not finish; see the lines above"
  say "the NucBox is back on SVN18. Still to do for KVM Box to run: '$0 policy-revert', and if the promote was signed, promote version 0 again"
}

status() {
  box status
  local p; p=$(policy_sha) || true
  if [ "$p" = "$NEW_POLICY" ]; then say "relay policy: SVN19"; elif [ "$p" = "$OLD_POLICY" ]; then say "relay policy: SVN18 (previous)"
  elif [ -z "$p" ]; then say "relay policy: not read"; else say "relay policy: another file ${p:0:16}"; fi
  say "marker: $([ -f "$MARKER" ] && cat "$MARKER" || echo none)"
  say "signing page: $(curl -s -m 20 "$SIGN/status" | python3 -I -c 'import json,sys; s=json.load(sys.stdin); print(", ".join("%s %s" % (k, "done" if s.get(k) else "ready" if s["ready"].get(k) else "waiting") for k in ("upload","publish","approve","promote")))' 2>/dev/null || echo 'not answering')"
}

mkdir -p "$ACT"
case ${1:-} in
  status) status;;
  stage) stage;;
  fetch) say "can the node fetch the controller $CID?"; fetchable && say "yes" || stop "the node's fetcher on the NucBox cannot get the controller";;
  policy) policy apply;;
  policy-revert) policy revert;;
  switch) switch "${2:-}";;
  revert) revert;;
  *) sed -n 2,20p "$0"; exit 2;;
esac
