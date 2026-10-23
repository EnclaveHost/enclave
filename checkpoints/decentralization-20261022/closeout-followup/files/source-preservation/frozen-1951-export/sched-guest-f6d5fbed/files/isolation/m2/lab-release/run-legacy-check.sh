#!/usr/bin/env bash
# The LEGACY path of a -release guestd, on real SEV-SNP: a deployment the supervisor does not mark release is built
# from the PREVIOUS tree (-legacy-isolation, 0181bce3) and booted by THIS tree's run-domain.sh with a CID guestd chose.
# Nothing like it has run on hardware before; it is the pre-4d check in production-release-d1a38994/INSTALL.md.
#
#   the app      = the hookbin canary's catalog app (0xf7e65a8f…/4, CID bafkreidocb…), with the derivation record the
#                  relay's known-answer test pins (relay/measurement-predict.mjs KNOWN_ANSWERS[0], security/attested-release)
#   PASS         = the guest is judged attested, its AppID and measurement equal the LIVE canary's VCEK-signed values
#                  (d2c4dfc0… / be6b8644…) AND expected-measurement.sh --pin 5c3561f9 (release-0181bce3), and the app
#                  answers through the front
#
# The legacy tree is `git archive 0181bce3` extracted into the run dir: a lab must not build in ~/enclave-prod (a build
# writes into its tree). The deployment id is synthetic. No config, secret, ticket or relay is involved.
# SAFETY (enclave-d1's lab conditions): -instance-prefix lb, lab vsock ports (bind-probed), MemAvailable >= 44 GiB, the
# m2-gd* units recorded before and after (a change is FATAL), every process running from the run dir ended at cleanup.
#
# usage: bash isolation/m2/lab-release/run-legacy-check.sh
set -euo pipefail
# the releases the legacy tree (0181bce3) was installed from, DERIVED from their release.json (guestd refuses a pre-chain
# tree named any other way): 5c3561f9 and 6f14ce75
LEGACY_RELEASES=${LEGACY_RELEASES:-@$HOME/enclave-prod/release-0181bce3/release.json,@$HOME/enclave-prod/release-6757d139/release.json}
HERE=$(cd "$(dirname "$0")" && pwd)
ISO=$(cd "$HERE/../.." && pwd)
REPO=$(cd "$ISO/.." && pwd)
L=${LAB_DIR:-$HOME/enclave-bench/lab-release/legacy-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$L"; chmod 700 "$L"
say() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$L/run.txt"; }
LEGACY_COMMIT=0181bce3aac5fa03dfaf2928d834ecd04d2a4a73
LIVE_RELEASE_ID=5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2
LIVE_RELEASE_DIR=${LIVE_RELEASE_DIR:-$HOME/enclave-prod/release-0181bce3}
WANT_APPID=d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24
WANT_MEAS=be6b8644384eee12396881e3e4cbca4259ae1a16a1e198d2c48d577ff7b3c6d355971eccebe8353749439adca718da4d
CID=bafkreidocbixnql7lroykdtwx4r2fmi5n6sra4lj7b7vhscsfqn4gctlee
DERIVE='{"derivation":"enclave-catalog-bundle/2","catalog":{"app":"0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3","version":4},"cid":"'$CID'","http":8000,"policy":{"cpuPercent":100,"memMiB":256,"vcpus":1},"runtimeId":"ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8"}'
ID=0x$(printf 'enclave-5d legacy-path lab' | sha256sum | cut -c1-64)
PIDS=(); VM=""
lab_procs() { for d in /proc/[0-9]*; do case "$(readlink "$d/exe" 2>/dev/null)" in "$L"/*) echo "${d#/proc/}";; esac; done; }
cleanup() {
  set +e
  if [ -n "$VM" ]; then curl -s -m 30 -X DELETE "http://127.0.0.1:18095/vms/$VM" > /dev/null; sleep 3; fi
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  sleep 1
  systemctl --user list-units --plain --no-legend --all 'm2-lb*' | awk '{print $1}' | while read -r u; do
    [ -n "$u" ] && systemctl --user stop "$u"; done
  for p in $(lab_procs); do kill "$p" 2>/dev/null; done
  sleep 1
  if [ -n "$(lab_procs)" ]; then say "FAIL: lab processes outlived cleanup: $(lab_procs | tr '\n' ' ')"; exit 1; fi
  systemctl --user list-units --plain --no-legend --all 'm2-gd*' | awk '{print $1, $3, $4}' > "$L/prod-units-after.txt"
  if ! diff -q "$L/prod-units-before.txt" "$L/prod-units-after.txt" > /dev/null; then
    say "FAIL: the production m2-gd* units CHANGED during the lab (see prod-units-*.txt)"; exit 1
  fi
  say "cleanup done; production m2-gd* units unchanged"
}

# ---- 0. the shared host ----
case "$ISO" in "$HOME"/enclave-prod/*) echo "this is a production tree ($ISO): run the lab from a lab worktree" >&2; exit 1 ;; esac
if [ -n "$(systemctl --user list-units --plain --no-legend --all 'm2-lb*')" ]; then
  echo "m2-lb* units exist already: another lab is running; refusing" >&2; exit 1
fi
[ -z "$(ss -ltnH 'sport = :18095' 2>/dev/null)" ] || { echo "127.0.0.1:18095 is already held; refusing" >&2; exit 1; }
( cd "$ISO/m2" && go build -o "$L/portprobe" ./lab-release/portprobe )
"$L/portprobe" 19444 19445 || { echo "a lab vsock port is already held; refusing" >&2; exit 1; }
avail=$(awk '/^MemAvailable:/ {print int($2/1024/1024)}' /proc/meminfo)
[ "$avail" -ge 44 ] || { echo "MemAvailable ${avail} GiB: under the 40 GiB guard plus the lab's 4 GiB; refusing" >&2; exit 1; }
[ -f "$LIVE_RELEASE_DIR/release.json" ] || { echo "no live release at $LIVE_RELEASE_DIR" >&2; exit 1; }
systemctl --user list-units --plain --no-legend --all 'm2-gd*' | awk '{print $1, $3, $4}' > "$L/prod-units-before.txt"
trap cleanup EXIT
say "legacy-path lab $L; production units before: $(wc -l < "$L/prod-units-before.txt"); MemAvailable ${avail} GiB"
say "this tree: $(git -C "$REPO" rev-parse --short HEAD) (run-domain.sh, fwd, judge, guestd); legacy tree: ${LEGACY_COMMIT:0:8}"

# ---- 1. the legacy tree (an archive, not a checkout of production's) and the lab guestd ----
mkdir -p "$L/legacy"
git -C "$REPO" archive "$LEGACY_COMMIT" isolation relay test/fixtures/amd | tar -x -C "$L/legacy"
( cd "$ISO/m4/guestd" && GOFLAGS= go build -trimpath -o "$L/guestd" . )
GUESTD_ENABLE=1 "$L/guestd" -isolation "$ISO" -root "$L/guestd-root" -listen 127.0.0.1:18095 \
  -gateway https://trustless-gateway.link -release -isolation-release none -legacy-isolation "$L/legacy/isolation" -legacy-isolation-release "$LEGACY_RELEASES" -instance-prefix lb \
  -ticket-port 19444 -egress-port 19445 -guest-mem-mib 4096 -guest-cpus 2 > "$L/guestd.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 120); do curl -sf -m 2 http://127.0.0.1:18095/health > "$L/health.json" 2>/dev/null && break; sleep 1; done
node -e 'const h=JSON.parse(require("fs").readFileSync(process.argv[1]));
  if(!(h.supports&&h.supports.release&&h.supports.legacyImage)) { console.error("health:", JSON.stringify(h.supports)); process.exit(1) }' "$L/health.json" \
  || { say "FAIL: the lab guestd is not a -release guestd with a legacy image"; exit 1; }
say "lab guestd up: supports.release and supports.legacyImage true, config/secrets $(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1])).supports;console.log(s.config+"/"+s.secrets)' "$L/health.json")"

# ---- 2. one NON-release deployment guest: the canary's app, by its catalog derivation ----
curl -sS -m 600 -X POST http://127.0.0.1:18095/vms -H 'content-type: application/json' \
  -d "{\"image\":\"ipfs://$CID\",\"name\":\"$ID\",\"derive\":$DERIVE}" > "$L/create.json" || true
VM=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).id||"")}catch{console.log("")}' "$L/create.json")
[ -n "$VM" ] || { say "FAIL: create refused: $(head -c 400 "$L/create.json")"; exit 1; }
say "created $VM (release false); building from the legacy tree and booting"
st=""
for _ in $(seq 1 300); do
  curl -sf -m 5 "http://127.0.0.1:18095/vms/$VM" > "$L/vm.json" || true
  st=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).status||"")}catch{console.log("")}' "$L/vm.json")
  case "$st" in running|failed|error|stopped) break ;; esac
  sleep 2
done
v() { node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1]));let x=o;for(const k of process.argv[2].split("."))x=x==null?x:x[k];console.log(x==null?"":typeof x=="object"?JSON.stringify(x):x)' "$L/vm.json" "$1"; }
say "status $st, verdict $(v verdict), release $(v release), legacyImage $(v legacyImage) $(v error)"
fail=0
[ "$st" = running ] && [ "$(v verdict)" = attested ] || { say "FAIL: not running and attested"; fail=1; }
if [ "$(v appId)" = "$WANT_APPID" ]; then say "ok   AppID = the live canary's ($WANT_APPID)"; else say "FAIL AppID $(v appId)"; fail=1; fi
if [ "$(v measurement)" = "$WANT_MEAS" ]; then say "ok   measurement = the live canary's VCEK-signed $WANT_MEAS"; else say "FAIL measurement $(v measurement)"; fail=1; fi
B=$(ls "$L"/guestd-root/lb*/app.bundle 2>/dev/null | head -1)
EM=$(sh "$L/legacy/isolation/m4/expected-measurement.sh" --pin "$LIVE_RELEASE_ID" "$LIVE_RELEASE_DIR" "$B" 1 | sed -n 's/^measurement //p')
if [ "$EM" = "$WANT_MEAS" ]; then say "ok   expected-measurement.sh --pin ${LIVE_RELEASE_ID:0:8} reproduces it"; else say "FAIL the live release reconstructs $EM"; fail=1; fi
PORT=$(v hostPort)
code=$(curl -sk -m 20 -o "$L/app-answer.txt" -w '%{http_code}' "https://127.0.0.1:$PORT/" || true)
case "$code" in 2??|3??|4??) say "ok   the app answers through the front: HTTP $code" ;; *) say "FAIL the app did not answer (HTTP $code)"; fail=1 ;; esac
serial=$(ls "$L"/guestd-root/lb*/*.serial "$L"/guestd-root/failed/*/*.serial 2>/dev/null | head -1 || true)
[ -n "$serial" ] && grep -a '^DOM ' "$serial" | head -12 > "$L/serial-dom.txt" || true
if [ "$fail" = 0 ]; then say "LEGACY PATH PASS: 0181bce3's image, booted by this tree, is the live canary's image and serves"; else say "LEGACY PATH FAIL"; exit 1; fi
