#!/usr/bin/env bash
# The attested release, END TO END, on real SEV-SNP with SYNTHETIC config and secrets (a lab, not production).
#
#   a REAL per-app SNP guest (this tree's front, lab pins) --vsock 9444--> a LAB guestd's ticket service
#                                                          --vsock 19443--> the lab egress router --> the LAB relay
#   the LAB relay = the relay's own code: enclave-99's secrets-release.mjs (from security/attested-release) and
#                   relay/snp-verify.mjs, judging the guest's hardware report against the release binding
#   the app       = api-mcp-adapter (catalog 0x5bca36b5…/0, pinned sha256), which must serve MCP tools/list with the
#                   SYNTHETIC key the release delivered, and refuse without it
#
# What it proves: a guest boots, reads its ticket, reports with the release binding, releases through its own pinned
# TLS, VERIFIES the lab relay's signature, opens, derives its allowlist, writes /etc/hosts, audits its listeners, hands
# init the resolved config, and the app serves on it - while no secret value appears in anything the host holds.
# What is LAB: the relay's ticket skips the operator/lease/chip checks; its expected measurement/AppID/runtime come
# from guestd's own prediction; the pins (relay name, CA, release key) are generated for this run (-tags releaselab),
# so the image is a lab image no production relay admits.
#
# SAFETY on a shared host: the lab guestd runs with -instance-prefix lb, so its boot sweep can only touch m2-lb*
# units (a default-prefix guestd would stop the production m2-gd* guests). The script refuses to start if any m2-lb*
# unit already exists, records the m2-gd* units before and after, and fails if they changed.
#
# usage: bash isolation/m2/lab-release/run-lab.sh     (needs: go, node + node_modules at the repo root, openssl, curl,
#        the SEV-SNP host setup guestd already uses; takes ~5-10 min)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ISO=$(cd "$HERE/../.." && pwd)
REPO=$(cd "$ISO/.." && pwd)
L=${LAB_DIR:-$HOME/enclave-bench/lab-release/$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$L"
chmod 700 "$L"
say() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$L/run.txt"; }
PIDS=()
LINKED_NM=""
LABPINS="$ISO/m2/release/labpins"
MODCOPY="$REPO/relay/.lab-secrets-release.mjs"
VM=""
cleanup() {
  set +e
  if [ -n "$VM" ]; then curl -s -m 30 -X DELETE "http://127.0.0.1:18095/vms/$VM" > /dev/null; sleep 3; fi
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  sleep 1
  systemctl --user list-units --plain --no-legend --all 'm2-lb*' | awk '{print $1}' | while read -r u; do
    [ -n "$u" ] && systemctl --user stop "$u"; done
  rm -rf "$LABPINS" "$MODCOPY"
  [ -n "$LINKED_NM" ] && rm -f "$REPO/node_modules"
  systemctl --user list-units --plain --no-legend --all 'm2-gd*' | awk '{print $1, $3, $4}' > "$L/prod-units-after.txt"
  if ! diff -q "$L/prod-units-before.txt" "$L/prod-units-after.txt" > /dev/null; then
    say "FAIL: the production m2-gd* units CHANGED during the lab (see prod-units-*.txt)"; exit 1
  fi
  say "cleanup done; production m2-gd* units unchanged"
}

# ---- 0. the shared host ----
if [ -n "$(systemctl --user list-units --plain --no-legend --all 'm2-lb*')" ]; then
  echo "m2-lb* units exist already: another lab is running; refusing" >&2; exit 1
fi
systemctl --user list-units --plain --no-legend --all 'm2-gd*' | awk '{print $1, $3, $4}' > "$L/prod-units-before.txt"
trap cleanup EXIT
say "lab dir $L; production units before: $(wc -l < "$L/prod-units-before.txt")"
# the lab relay (99's module imports the relay's fleet-auth.js) and guestd's judge need the repo's node_modules
if [ ! -e "$REPO/node_modules" ]; then
  MAIN=${ENCLAVE_MAIN_CHECKOUT:-$HOME/Projects/enclave}
  [ -d "$MAIN/node_modules" ] || { say "FAIL: no node_modules (npm ci at the repo root)"; exit 1; }
  ln -s "$MAIN/node_modules" "$REPO/node_modules"; LINKED_NM=1
fi

# ---- 1. lab pins: a CA and the relay's certificate for the lab name, and a release key ----
# LAB_SESSION=<dir> reuses a session's pins (ca.pem, relay.pem, relay.key, release.seed): the pins are COMPILED into the
# image, so a lab domain release built from them (phase 2's) predicts this run's image only with the same pins
if [ -n "${LAB_SESSION:-}" ]; then
  for f in ca.pem relay.pem relay.key release.seed; do install -m 600 "$LAB_SESSION/$f" "$L/$f"; done
  say "lab pins from the session $LAB_SESSION"
else
  ( cd "$L" && umask 077
    openssl ecparam -name prime256v1 -genkey -noout -out ca.key 2>/dev/null
    openssl req -x509 -new -key ca.key -days 2 -subj "/CN=release lab CA $(date -u +%s)" -out ca.pem 2>/dev/null
    openssl ecparam -name prime256v1 -genkey -noout -out relay.key 2>/dev/null
    openssl req -new -key relay.key -subj "/CN=release-lab.enclave.test" -out relay.csr 2>/dev/null
    printf 'subjectAltName=DNS:release-lab.enclave.test\nextendedKeyUsage=serverAuth\n' > relay.ext
    openssl x509 -req -in relay.csr -CA ca.pem -CAkey ca.key -set_serial 0x$(openssl rand -hex 8) -days 2 -extfile relay.ext -out relay.pem 2>/dev/null
    openssl rand -hex 32 > release.seed )
fi
git -C "$REPO" show origin/security/attested-release:relay/secrets-release.mjs > "$MODCOPY"
PUB=$(cd "$REPO" && node -e 'import(process.argv[1]).then(R=>console.log(R.ed25519RawPublic(R.signingKeyFromSeed(Buffer.from(require("fs").readFileSync(process.argv[2],"utf8").trim(),"hex"))).toString("hex")))' "$MODCOPY" "$L/release.seed")
mkdir -p "$LABPINS"
cp "$L/ca.pem" "$LABPINS/ca.pem"
printf '%s\n' "$PUB" > "$LABPINS/release-key.hex"
say "lab pins written (relay name release-lab.enclave.test, release key ${PUB:0:16}…)"

# ---- 2. the app: the pinned api-mcp-adapter component, as a contract bundle ----
CID=bafybeie5qxmirydhcjn2g4v23npfhrw3mskaxgdlddijksa7zpt56knq6i
SHA=ca30761416d5b15be66c469f4bc9a375f3178714b94061d6bda01e1678b4d7f2
curl -sfSL -m 120 -o "$L/app.wasm" "https://ipfs.enclave.host/ipfs/$CID"
[ "$(sha256sum "$L/app.wasm" | cut -c1-64)" = "$SHA" ] || { say "FAIL: the component is not the pinned one"; exit 1; }
( cd "$ISO/contract" && go run ./cmd/bundle build -label api-mcp-adapter -world wasi:http -mem 256 "$L/app.wasm" "$L/app.bundle" ) | tee -a "$L/run.txt"

# ---- 3. synthetic config and secrets (the real adapter's shape; every value made up; a 0600 file) ----
KEY="synthetic-$(openssl rand -hex 12)"
( umask 077; node -e '
  const fs = require("fs");
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const secrets = { MCP_ADAPTER_API_KEY: process.argv[2], IMAGE_ENDPOINT: "https://images.lab.invalid",
    VM_ENDPOINT: "https://vm.lab.invalid", VM_API_KEY: "synthetic-vm-" + process.argv[2].slice(-6),
    NOTES_ENDPOINT: "https://notes.lab.invalid", NOTES_API_KEY: "synthetic-notes-" + process.argv[2].slice(-6) };
  fs.writeFileSync(process.argv[3], JSON.stringify({ config, secrets }));
' "$ISO/m2/appconfig/testdata/mcp-adapter-synthetic.json" "$KEY" "$L/release.json" )
ID=0x$(printf 'enclave-5d attested-release lab' | sha256sum | cut -c1-64)
say "synthetic deployment $ID"

# ---- 4. the lab relay, the lab egress router, the lab guestd ----
( cd "$REPO" && PORT=18443 LAB_RELEASE_MODULE="$MODCOPY" LAB_TLS_CERT="$L/relay.pem" LAB_TLS_KEY="$L/relay.key" \
  LAB_SIGNING_SEED="$L/release.seed" LAB_VCEK="$HOME/.cache/enclave-isolation/m3-clean/vcek.der" \
  LAB_CHAIN="$REPO/test/fixtures/amd/Turin-cert_chain.pem" LAB_MIN_TCB="$HOME/.cache/enclave-isolation/m3-clean/min-tcb.json" \
  LAB_RELEASE_FILE="$L/release.json" node "$ISO/m2/lab-release/relay.mjs" > "$L/relay.log" 2>&1 ) &
PIDS+=($!)
( cd "$ISO/m2" && go build -o "$L/lab-egress" ./lab-release/egress )
"$L/lab-egress" -relay-addr 127.0.0.1:18443 > "$L/egress.log" 2>&1 &
PIDS+=($!)
( cd "$ISO/m4/guestd" && go build -o "$L/guestd" . )
GUESTD_ENABLE=1 GOFLAGS=-tags=releaselab "$L/guestd" -isolation "$ISO" -root "$L/guestd-root" -listen 127.0.0.1:18095 \
  -release -instance-prefix lb -guest-mem-mib 4096 -guest-cpus 2 > "$L/guestd.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 120); do curl -sf -m 2 http://127.0.0.1:18095/health > "$L/health.json" 2>/dev/null && break; sleep 1; done
grep -q '"release":true' "$L/health.json" || { say "FAIL: the lab guestd did not come up with -release"; exit 1; }
say "lab relay, egress router and guestd (prefix lb, -release) up"

# ---- 5. the supervisor's part: create a RELEASE guest, and hand it a ticket once it waits ----
curl -sf -m 60 -X POST http://127.0.0.1:18095/vms -H 'content-type: application/json' \
  -d "{\"image\":\"file://$L/app.bundle\",\"name\":\"$ID\",\"release\":true}" > "$L/create.json"
VM=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).id)' "$L/create.json")
say "created $VM; building and booting"
field() { node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(v[process.argv[2]]??"")' "$L/vm.json" "$1"; }
handed=""
for _ in $(seq 1 900); do
  curl -sf -m 5 "http://127.0.0.1:18095/vms/$VM" > "$L/vm.json" || true
  st=$(field status)
  if [ -z "$handed" ] && [ "$(field awaitingTicket)" = "true" ]; then
    curl -sfk -m 10 -X POST https://127.0.0.1:18443/lab/expect -H 'content-type: application/json' \
      -d "{\"id\":\"$ID\",\"measurement\":\"$(field measurement)\",\"appId\":\"$(field appId)\",\"runtimeId\":\"$(field runtimeId)\"}" > /dev/null
    T=$(curl -sfk -m 10 -X POST https://127.0.0.1:18443/v1/secrets/release-ticket -H 'content-type: application/json' -d "{\"id\":\"$ID\"}" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).ticket))')
    curl -sf -m 10 -X POST "http://127.0.0.1:18095/vms/$VM/ticket" -H 'content-type: application/json' -d "{\"ticket\":\"$T\"}" > /dev/null
    unset T
    handed=1; say "the guest waited for its ticket: handed (measurement $(field measurement | cut -c1-16)…)"
  fi
  [ "$st" = running ] || [ "$st" = failed ] && break
  sleep 1
done
say "instance status: $st $(field error)"
# LAB_DOMAIN_RELEASE=<dir> and LAB_DOMAIN_RELEASE_ID=<id>: the image guestd built must be the one a verifier
# reconstructs from that published release and this bundle (expected-measurement.sh --pin) - what the relay's
# predictor relies on (phase 2)
if [ -n "${LAB_DOMAIN_RELEASE:-}" ]; then
  EM=$(sh "$ISO/m4/expected-measurement.sh" --pin "$LAB_DOMAIN_RELEASE_ID" "$LAB_DOMAIN_RELEASE" "$L/app.bundle" 1 | sed -n 's/^measurement //p')
  if [ -n "$EM" ] && [ "$EM" = "$(field measurement)" ]; then say "ok   guestd's image measurement equals the pinned lab domain release's reconstruction ($EM)"
  else say "FAIL the image does not reproduce from the pinned domain release: guestd $(field measurement) vs release ${EM:-none}"; exit 1; fi
fi
[ "$st" = running ] || { say "FAIL: the release guest did not reach running"; exit 1; }

# ---- 6. the app serves on the RELEASED config: the synthetic key admits, anything else is refused ----
HP=$(field hostPort)
mcp() { curl -sk -m 15 -o "$L/mcp.json" -w '%{http_code}' -X POST "https://127.0.0.1:$HP/mcp" -H 'content-type: application/json' "$@" \
          -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'; }
fail=0
code=$(mcp -H "X-Api-Key: $KEY")
if [ "$code" = 200 ] && grep -q generate_image "$L/mcp.json"; then say "ok   tools/list with the released synthetic key: 200"; else say "FAIL tools/list with the key: $code"; fail=1; fi
for k in "" "synthetic-wrong"; do
  c=$(if [ -n "$k" ]; then mcp -H "X-Api-Key: $k"; else mcp; fi)
  if [ "$c" = 401 ]; then say "ok   tools/list with ${k:-no} key: 401"; else say "FAIL tools/list with ${k:-no} key: $c"; fail=1; fi
done

# ---- 7. nothing secret in anything the host holds (the release file is the lab's own input) ----
grep -a "DOM release:\|DOM app config\|listener audit" "$L"/guestd-root/lb*/*.serial 2>/dev/null | tee -a "$L/run.txt" || true
leaks=$(grep -rlaF -e "$KEY" -e "synthetic-vm-" -e "synthetic-notes-" "$L" --exclude=release.json --exclude=run.txt --exclude=mcp.json 2>/dev/null || true)
if [ -z "$leaks" ]; then say "ok   no synthetic secret value in any host-side file (guestd root and logs, serial console, relay and router logs)"
else say "FAIL a synthetic secret value appears in: $leaks"; fail=1; fi
[ "$fail" = 0 ] && say "LAB PASS: the release reached a real SNP guest and its app serves on it" || { say "LAB FAIL"; exit 1; }
