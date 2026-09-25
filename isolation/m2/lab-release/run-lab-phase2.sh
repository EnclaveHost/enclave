#!/usr/bin/env bash
# The release lab, PHASE 2: admission INDEPENDENT of the host. Everything on the release path is production code:
#   - the SUPERVISOR's own spawn path (supervisor.js RELEASE_SELFTEST spawnReal): isolationSpawnRelease, the relay's
#     list, isolationDerivation, POST /vms over guestd-control/1 (a paired lab guestd), the ticket pump and the
#     operator-signed fetchReleaseTicket;
#   - a lab guestd from this tree (-release, -instance-prefix lb, lab ports), building the guest from the CATALOG
#     derivation (ipfs:// + derive), exactly as for a real deployment;
#   - enclave-99's lab relay (docs/security/attested-release-lab/lab-relay.mjs on security/attested-release): the REAL
#     handleRelease with the REAL predictor over a PINNED lab domain release, verifyEvidence with KDS collateral, the
#     chip proven from a real report on this host; lab only in its ledger row, its synthetic keys and its synthetic
#     config/secrets, each labelled in its own output. It must already be serving (99 starts it).
# The PASS CONDITION was recorded by the relay before any guest existed (99, under lab release 1428c0c4):
#   AppID 94c04c0edb6b4ca11b9bd0b6e4adfa98afdfa04692e6c10af79755e6db0ba0f2
#   measurement 54ffacdda729a013d3ca59f1b321ce9f6390974d71d82e9f8e5b1b14229ec26950e9d67fbf15dae1ea180cba1665f376
# The guest is released only if its hardware report carries exactly that prediction; this script checks the guest it
# got carries it too, that the app serves on the released synthetic key, and that no secret reaches the host.
#
# usage: LAB_SESSION=<phase2 session dir> bash isolation/m2/lab-release/run-lab-phase2.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ISO=$(cd "$HERE/../.." && pwd)
REPO=$(cd "$ISO/.." && pwd)
SES=${LAB_SESSION:?LAB_SESSION=<phase2 session dir>}
REL_ID=${LAB_DOMAIN_RELEASE_ID:-1428c0c4ff9a9238f96b9dd3c636351f65d2022dc201e3135bbbbf6dd585cdca}
REL_DIR=${LAB_DOMAIN_RELEASE:-$SES/domain-release-020f76e7}
ID=${LAB_ID:-0x1ab5feb710ec35a291d5c84f01142e2bfa4611b88a1e3e031eb49ecf80780503}
WANT_APPID=94c04c0edb6b4ca11b9bd0b6e4adfa98afdfa04692e6c10af79755e6db0ba0f2
WANT_MEAS=54ffacdda729a013d3ca59f1b321ce9f6390974d71d82e9f8e5b1b14229ec26950e9d67fbf15dae1ea180cba1665f376
ENDPOINT=https://lab-iso.enclave.test
L=${LAB_DIR:-$HOME/enclave-bench/lab-release/phase2-run-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$L"; chmod 700 "$L"
say() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$L/run.txt"; }
PIDS=(); LINKED_NM=""; LABPINS="$ISO/m2/release/labpins"
cleanup() {
  set +e
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  sleep 1
  systemctl --user list-units --plain --no-legend --all 'm2-lb*' | awk '{print $1}' | while read -r u; do
    [ -n "$u" ] && systemctl --user stop "$u"; done
  rm -rf "$LABPINS"
  [ -n "$LINKED_NM" ] && rm -f "$REPO/node_modules"
  systemctl --user list-units --plain --no-legend --all 'm2-gd*' | awk '{print $1, $3, $4}' > "$L/prod-units-after.txt"
  if ! diff -q "$L/prod-units-before.txt" "$L/prod-units-after.txt" > /dev/null; then
    say "FAIL: the production m2-gd* units CHANGED during the lab (see prod-units-*.txt)"; exit 1
  fi
  say "cleanup done; production m2-gd* units unchanged"
}

# ---- 0. the shared host (enclave-d1's conditions, as in run-lab.sh) ----
case "$ISO" in "$HOME"/enclave-prod/*) echo "this is a production tree ($ISO)" >&2; exit 1 ;; esac
[ -z "$(systemctl --user list-units --plain --no-legend --all 'm2-lb*')" ] || { echo "m2-lb* units exist: refusing" >&2; exit 1; }
busy=$(ss --vsock -ln 2>/dev/null | awk '{print $5}' | grep -E ':(9443|9444|19443|19444|19445)$' || true)
[ -z "$busy" ] || { echo "vsock port(s) already held: $busy" >&2; exit 1; }
avail=$(awk '/^MemAvailable:/ {print int($2/1024/1024)}' /proc/meminfo)
[ "$avail" -ge 44 ] || { echo "MemAvailable ${avail} GiB < 44" >&2; exit 1; }
for f in ca.pem relay.pem relay.key release.seed operator.key synthetic-release.json; do [ -f "$SES/$f" ] || { echo "missing $SES/$f" >&2; exit 1; }; done
[ -f "$REL_DIR/release.json" ] || { echo "no lab domain release at $REL_DIR" >&2; exit 1; }
systemctl --user list-units --plain --no-legend --all 'm2-gd*' | awk '{print $1, $3, $4}' > "$L/prod-units-before.txt"
trap cleanup EXIT
say "phase 2: lab dir $L; production units before: $(wc -l < "$L/prod-units-before.txt"); MemAvailable ${avail} GiB"
if [ ! -e "$REPO/node_modules" ]; then ln -s "${ENCLAVE_MAIN_CHECKOUT:-$HOME/Projects/enclave}/node_modules" "$REPO/node_modules"; LINKED_NM=1; fi

# ---- 1. 99's relay must already be serving, and list the lab id ----
st=$(curl -sf --cacert "$SES/ca.pem" --resolve release-lab.enclave.test:19480:127.0.0.1 -m 5 \
  "https://release-lab.enclave.test:19480/v1/secrets/release-status?id=$ID" || true)
echo "$st" | grep -q '"listed":true' || { say "FAIL: 99's lab relay is not serving on 127.0.0.1:19480, or does not list $ID ($st)"; exit 1; }
curl -sf -m 5 "http://127.0.0.1:19481/v1/secrets/release-status?id=$ID" | grep -q '"listed":true' || { say "FAIL: the relay's loopback ticket listener (19481)"; exit 1; }
say "99's lab relay serving: TLS 19480 (the guest's pinned path) and loopback 19481 (tickets), $ID listed"

# ---- 2. the lab pins this lab release was built with, the router, a PAIRED lab guestd ----
mkdir -p "$LABPINS"; cp "$SES/ca.pem" "$LABPINS/ca.pem"; cat "$SES/release.pub.hex" > "$LABPINS/release-key.hex"
( cd "$ISO/m2" && go build -o "$L/lab-egress" ./lab-release/egress )
"$L/lab-egress" -relay-addr 127.0.0.1:19480 > "$L/egress.log" 2>&1 &
PIDS+=($!)
( cd "$ISO/m4/guestd" && go build -o "$L/guestd" . )
GUESTD_ENABLE=1 "$L/guestd" -gen-key "$L/pair.key" > /dev/null
GUESTD_ENABLE=1 ISOLATION_LAB_FRONT=1 "$L/guestd" -isolation "$ISO" -root "$L/guestd-root" -listen 127.0.0.1:18095 \
  -auth-key "$L/pair.key" -release -instance-prefix lb -ticket-port 19444 -egress-port 19445 \
  -guest-mem-mib 4096 -guest-cpus 2 > "$L/guestd.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 120); do curl -sf -m 2 http://127.0.0.1:18095/control/hello > /dev/null 2>&1 && break; sleep 1; done
curl -sf -m 2 http://127.0.0.1:18095/control/hello > /dev/null || { say "FAIL: the lab guestd did not come up"; exit 1; }
say "router -> 19480; paired lab guestd up (prefix lb, -release, lab ports)"

# ---- 3. the SUPERVISOR's own spawn: list, derive, create a release guest, pump its ticket (signed), wait ----
SPEC=$(node -e 'console.log(JSON.stringify({ deploymentId: process.argv[1], image: { reference: "ipfs://bafybeie5qxmirydhcjn2g4v23npfhrw3mskaxgdlddijksa7zpt56knq6i" },
  catalogRef: "catalog://0x5bca36b520b80fa26272f34886e38344393e1f69098be8ad5a0d2372ec3147bc/0", versionMemMb: 128, ports: [],
  config: "", configCid: "bafkreilabsyntheticconfigdonotuse", secrets: null, secretsStaged: true, cpuShare: 0.01, gpuShare: 0, appPort: 8080, hosts: [] }))' "$ID")
# the (synthetic) operator key reaches the supervisor through an EXPORT, never an argument
( cd "$REPO"
  export REGISTRY_PRIVATE_KEY; REGISTRY_PRIVATE_KEY=$(cat "$SES/operator.key")
  env SECRET=lab-secret ENABLE_MPS=0 MOCK_SPAWN= ADDRESS_BOOK_ADDRESS= REGISTRY_ENABLED= CLAIM_ENABLED= \
    ISOLATION_BACKEND=snp-guest-per-app PROVISION_BACKEND=vm ISOLATION_RELEASE=1 VMMGR_URL=http://127.0.0.1:18095 \
    GUESTD_KEY_FILE="$L/pair.key" SECRETS_API=http://127.0.0.1:19481 \
    RELEASE_SELFTEST="{\"spawnReal\":{\"endpoint\":\"$ENDPOINT\",\"spec\":$SPEC}}" node supervisor.js ) > "$L/spawn.txt" 2> "$L/supervisor.log" || true
tail -1 "$L/spawn.txt" > "$L/spawn.json"
v() { node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1]));const p=process.argv[2].split(".");let x=o;for(const k of p)x=x?.[k];console.log(x??"")' "$L/spawn.json" "$1"; }
say "supervisor spawn: vm $(v vmId), pump $(v pump), status $(v view.status) $(v error)$(v view.error)"
[ "$(v view.status)" = running ] || { say "FAIL: the release guest did not reach running"; exit 1; }

# ---- 4. the guest is the PREDICTED one ----
fail=0
if [ "$(v view.appId)" = "$WANT_APPID" ]; then say "ok   AppID = the relay's prediction ($WANT_APPID)"; else say "FAIL AppID $(v view.appId) != $WANT_APPID"; fail=1; fi
if [ "$(v view.measurement)" = "$WANT_MEAS" ]; then say "ok   guestd's measurement = the relay's prediction"; else say "FAIL measurement $(v view.measurement) != $WANT_MEAS"; fail=1; fi
EM=$(sh "$ISO/m4/expected-measurement.sh" --pin "$REL_ID" "$REL_DIR" "$(ls "$L"/guestd-root/lb*/app.bundle | head -1)" 1 | sed -n 's/^measurement //p')
if [ "$EM" = "$WANT_MEAS" ]; then say "ok   expected-measurement.sh --pin $REL_ID reproduces it from the release and the derived bundle"; else say "FAIL the pinned release reconstructs $EM"; fail=1; fi

# ---- 5. the app serves on the RELEASED synthetic config ----
KEY=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).secrets.MCP_ADAPTER_API_KEY)' "$SES/synthetic-release.json")
HP=$(v view.hostPort)
# -k is INHERENT here: the domain's own self-signed key, which guestd's judge attested before "running"
mcp() { curl -sk -m 15 -o "$L/mcp.json" -w '%{http_code}' -X POST "https://127.0.0.1:$HP/mcp" -H 'content-type: application/json' "$@" \
          -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'; }
code=$(mcp -H "X-Api-Key: $KEY")
if [ "$code" = 200 ] && grep -q generate_image "$L/mcp.json"; then say "ok   tools/list with the released synthetic key: 200"; else say "FAIL tools/list with the key: $code"; fail=1; fi
for k in "" "synthetic-wrong"; do
  c=$(if [ -n "$k" ]; then mcp -H "X-Api-Key: $k"; else mcp; fi)
  if [ "$c" = 401 ]; then say "ok   tools/list with ${k:-no} key: 401"; else say "FAIL tools/list with ${k:-no} key: $c"; fail=1; fi
done
unset KEY

# ---- 6. no secret value in anything the host holds ----
grep -a "DOM release:\|DOM app config\|listener audit" "$L"/guestd-root/lb*/*.serial 2>/dev/null | tee -a "$L/run.txt" || true
journalctl --user -u 'm2-lb*' --no-pager > "$L/journal-lb.txt" 2>/dev/null || true
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1])).secrets;for(const v of Object.values(s))console.log(v)' "$SES/synthetic-release.json" > "$L/.needles"
chmod 600 "$L/.needles"
leaks=$(grep -rlaF -f "$L/.needles" "$L" --exclude=.needles --exclude=mcp.json 2>/dev/null || true)
rm -f "$L/.needles"
if [ -z "$leaks" ]; then say "ok   no synthetic secret value in any host-side file (guestd root and logs, serial, the units' journal, supervisor, router)"
else say "FAIL a synthetic secret value appears in: $leaks"; fail=1; fi
[ "$fail" = 0 ] && say "PHASE 2 PASS: admitted by the relay's own prediction, released, and serving on the released config" || { say "PHASE 2 FAIL"; exit 1; }
