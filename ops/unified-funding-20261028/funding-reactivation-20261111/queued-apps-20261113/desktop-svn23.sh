#!/bin/bash
# Move the relay and the NucBox to the native desktop release SVN23 (097affc3...) and to the host code that takes a
# desktop at any purchased share (platform main b602b569a: enclave-desktop-release/2, GPU share 1..1000 milli), so that
# KVM Box deployment 0xf9bb979a (17% CPU, 10% GPU) can be claimed. README.md beside this file says what the image is.
# Made after ops/.../queued-apps-20261113/desktop-svn22.sh; the NucBox side of each step is svn23-box.ps1.
#
#   svn23.sh status         read only: the relay's files and policy, the NucBox's bundle, hooks, policy, manager, node
#   svn23.sh stage          verify the staged release folder on the NucBox (copied 2026-11-20); nothing running changes
#   svn23.sh relay          control VM: two relay files and the Shield policy, then one relay restart
#   svn23.sh box            NucBox: the two local hooks and the box's policy to SVN23, then install host bundle 2026.11.20
#   svn23.sh retry          ask the NucBox to claim 0xf9bb979a now, and watch the launch
#   svn23.sh launch         read only: the desktop VM and what the node last logged for the deployment
#   svn23.sh box-revert     NucBox: hooks and policy back, then install host bundle 2026.11.18.1 again
#   svn23.sh relay-revert   control VM: the three previous files back, then one relay restart
#
# Order: relay, box, retry. The old release block (enclave-desktop-release/1) and the new one (/2) are each refused by
# the other code, so the relay's two files change with its policy, and the NucBox's bundle with its policy and hooks.
#
# What it costs. relay: the API relay restarts once (host tunnels drop for some seconds). From then on it admits only
# the SVN23 desktop; no desktop runs today, so nothing is lost by that. box: a full install of the host bundle, as on
# 2026-11-18 (docs/operations/windows-release-2026.11.18.md): Shield, Node, Network and Card restart, the manager
# recovers the running partitions and the node retires and starts them again. That took about ten minutes for the
# nine apps then. A lease that has less than that left lapses and is claimed again. The bundle differs from the
# installed 2026.11.18.1 in five control files, the network agent's bundle (seven lines), the tray and
# control-source.json; nothing else. SVN23 has not run on the NucBox's hardware: the root image booted in the
# isolated KVM probe, and the compute files ran in the desktop container. The purchased-share guest contract has not
# run in a booted guest at all.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
CVM=${CVM:-/vm/enclave-volumes/rpc-snp-release-r14/cvm.sh}
export CVM_IP=${CVM_IP:-172.25.202.35}   # the control VM's address since the NucBox restart of 2026-11-20 08:45Z
NEW=097affc33f87fc4603e273aee2ffc1e5571da9f2fd454222855ff1ac9e6bfede
OLD_POLICY=d202746f943486a7239f5180a0811dd35fbaab35fa11c1fbdf56f8e756349e62
NEW_POLICY=8b61bcb1d6d891a6fad840f9a617789337b8ccd43db299d160818805732480da
OLD_RELEASE_MJS=a84635db7e33d5fe4f68796f29945597dd4b341fc1996c0394f804331a49f38d
NEW_RELEASE_MJS=8f4428f8dee0014fb1a8abe562b5418e9cb3d301e0006008af7b720eabde62ba
OLD_DERIVE_MJS=52c99e557ac4f119e3e1cba1b69c0909d4bc06068cc784d0298f62261c09c6e4
NEW_DERIVE_MJS=41d15e2752134047805e82d6106ecf446257ef607bdcb908dfa064991042681c
KVM=0xf9bb979ae685c7f16f6c49df3f35f76ff38aca86b5ce3e76e02b83115360dd58
HINT=${HINT:-https://api.enclave.host/v1/claim-hint}
LOG=$here/host-switch.log
OUT=$(mktemp); trap 'rm -f "$OUT"' EXIT
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 minipc)
say() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
stop() { say "STOP: $*"; exit 1; }
quiet() { sed '/post-quantum\|store now\|openssh.com\/pq/d'; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
box() {
  { printf "\$mode='%s'\n%s\n" "$1" "${2:-}"; cat "$here/svn23-box.ps1"; } |
    timeout "${BOX_TIMEOUT:-0}" "${SSH[@]}" 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"' 2>&1 |
    tr -d '\r' | quiet | tee "$OUT" | tee -a "$LOG" || true
}
did() { grep -q "^$1" "$OUT"; }

relay() {
  local mode=$1 p= r= d=
  [ "$(sha "$here/shield-policy.json")" = "$NEW_POLICY" ] && [ "$(sha "$here/relay/shield-desktop-release.mjs")" = "$NEW_RELEASE_MJS" ] &&
    [ "$(sha "$here/relay/shield-desktop-derive.mjs")" = "$NEW_DERIVE_MJS" ] || stop "the prepared relay files are not the ones this script names; nothing changed"
  if [ "$mode" = apply ]; then p=$(base64 -w0 "$here/shield-policy.json"); r=$(base64 -w0 "$here/relay/shield-desktop-release.mjs"); d=$(base64 -w0 "$here/relay/shield-desktop-derive.mjs"); fi
  { printf 'MODE = "%s"\nB64 = {"policy": "%s", "release": "%s", "derive": "%s"}\n' "$mode" "$p" "$r" "$d"
    printf 'OLD = {"policy": "%s", "release": "%s", "derive": "%s"}\nNEW = {"policy": "%s", "release": "%s", "derive": "%s"}\n' \
      "$OLD_POLICY" "$OLD_RELEASE_MJS" "$OLD_DERIVE_MJS" "$NEW_POLICY" "$NEW_RELEASE_MJS" "$NEW_DERIVE_MJS"
    cat <<'PY'; } | CVM_TIMEOUT=600 "$CVM" 'sudo -n python3 -I -' 2>&1 | quiet | tee "$OUT" | tee -a "$LOG" || true
import base64, hashlib, json, os, subprocess, sys, time, urllib.request
FILES = {"policy": "/etc/nan-relay/shield-policy.json", "release": "/opt/nan-relay/shield-desktop-release.mjs", "derive": "/opt/nan-relay/shield-desktop-derive.mjs"}
BAK = ".before-native-svn23-20261120"
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
def put(name, data):
    f = FILES[name]; st = os.stat(f); tmp = f + ".new"
    with open(tmp, "wb") as o: o.write(data)
    os.chmod(tmp, st.st_mode & 0o777); os.chown(tmp, st.st_uid, st.st_gid); os.replace(tmp, f)
def stop(why): print("STOP: " + why); sys.exit(0)

live = {n: open(f, "rb").read() for n, f in FILES.items()}; before = health()
state = {n: "new" if sha(b) == NEW[n] else "old" if sha(b) == OLD[n] else "other" for n, b in live.items()}
print("relay before: %s; %s" % (line(before), ", ".join("%s %s" % (n, state[n]) for n in FILES)))
if MODE == "status": print("DONE status"); sys.exit(0)
source, target = ("old", "new") if MODE == "apply" else ("new", "old")
if all(s == target for s in state.values()): print("DONE relay (the three files are already these; relay %s)" % line(before)); sys.exit(0)
if any(s != source for s in state.values()): stop("the live files are not all the %s ones; nothing changed" % ("previous" if MODE == "apply" else "SVN23"))
if not os.path.exists(ALLOW): stop("the control VM does not allow the relay to start (%s is missing); nothing changed" % ALLOW)
if not (before and before.get("ok") is True): stop("the relay is not healthy now; nothing changed")
data = {}
for n, f in FILES.items():
    if MODE == "apply":
        data[n] = base64.b64decode(B64[n])
        if sha(data[n]) != NEW[n]: stop("the %s file that arrived is not the prepared one; nothing changed" % n)
        if not os.path.exists(f + BAK):
            with open(f + BAK, "wb") as o: o.write(live[n])
            os.chmod(f + BAK, 0o644)
        if sha(open(f + BAK, "rb").read()) != OLD[n]: stop("the kept copy %s is not the previous file; nothing changed" % (f + BAK))
    else:
        if not os.path.exists(f + BAK): stop("no previous %s file was kept; nothing changed" % n)
        data[n] = open(f + BAK, "rb").read()
        if sha(data[n]) != OLD[n]: stop("the kept copy of the %s file is not the previous one; nothing changed" % n)
for n in FILES: put(n, data[n])
subprocess.run(["systemctl", "restart", UNIT], check=True)
after = wait(180)
print("relay after the restart: " + line(after))
if after and after.get("ok") is True:
    print("DONE relay %s (previous files kept beside them as *%s)" % (sha(data["policy"])[:16], BAK)); sys.exit(0)
print("the relay is not healthy on these files: putting the three back")
for n in FILES: put(n, live[n])
subprocess.run(["systemctl", "restart", UNIT], check=True)
again = wait(180)
log = subprocess.run(["journalctl", "-u", UNIT, "-n", "30", "--no-pager", "-o", "cat"], capture_output=True, text=True).stdout
for l in log.splitlines():
    if not any(w in l.lower() for w in ("key", "secret", "token", "password")): print("  " + l[:220])
stop("nothing was changed; the files are back as they were and the relay reports " + line(again))
PY
  [ "$mode" = status ] || did 'DONE relay' || stop "the relay step did not finish; see the lines above"
}

answers() {
  local a
  for a in ef514ed3 7ae476a3 d9798e4c a77d0c57 a69dcbba 59f1273d c13d4b6a 38f368d6 "${KVM:2:8}"; do
    say "  $a.app.enclave.host: $(curl -s -m 20 -o /dev/null -w '%{http_code} in %{time_total} s' "https://$a.app.enclave.host/" || true)"
  done
}

case "${1:-}" in
  status) relay status; BOX_TIMEOUT=180 box status ;;
  stage) BOX_TIMEOUT=300 box verify; did 'DONE staged' || stop "the staged release folder does not verify on the NucBox" ;;
  relay) say "relay: SVN23 policy and the two release files"; relay apply ;;
  relay-revert) say "relay: back to the previous policy and files"; relay revert ;;
  box)
    relay status; grep -q 'policy new, release new, derive new' "$OUT" || stop "the relay is not on the SVN23 files: run '$0 relay' first (nothing changed)"
    BOX_TIMEOUT=300 box verify; did 'DONE staged' || stop "the staged release folder does not verify on the NucBox; nothing changed"
    say "NucBox: hooks and policy to SVN23, then host bundle 2026.11.20 (about ten minutes for the apps to come back)"
    BOX_TIMEOUT=2400 box apply; did 'DONE box' || stop "the NucBox step did not finish; see the lines above. '$0 status' reads where it stands"
    answers ;;
  box-revert)
    say "NucBox: hooks and policy back, then host bundle 2026.11.18.1"
    BOX_TIMEOUT=2400 box revert; did 'DONE box' || stop "the NucBox revert did not finish; see the lines above"
    answers ;;
  retry)
    BOX_TIMEOUT=180 box status; did 'manager: .*igvm=097affc33f87' || grep -q '^manager: .*igvm=097affc33f87' "$OUT" || stop "the NucBox manager does not report SVN23: run '$0 box' first (nothing sent)"
    since=$(date -u +%H:%M:%S)
    a=$(curl -s -m 90 -X POST -H 'content-type: application/json' -d "{\"id\":\"$KVM\",\"enclave\":\"nucbox-k11-4\",\"force\":true}" "$HINT" | tr -d '\n' | cut -c1-500) || true
    say "claim hint sent; the relay answered: ${a:-nothing}"
    for i in $(seq 1 30); do
      sleep 20; BOX_TIMEOUT=100 box launch "\$since='$since'"
      if did 'DONE launch running'; then say "KVM Box runs on the NucBox"; answers; exit 0; fi
      if did 'DONE launch refused'; then stop "the node refused the deployment; its line is above"; fi
    done
    stop "no running desktop VM within ten minutes; '$0 launch' reads the state again" ;;
  launch) BOX_TIMEOUT=100 box launch "\$since='00:00:00'" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
