# warden-common.sh - shared definitions for the warden (metal0 host) side of the eu-central relay move (sourced; changes
# nothing). The TARGET is main's lease-relay HOST ROLE, unchanged: relay/systemd/enclave-host-relay.service (d279eb49)
# running /opt/enclave/network/host-services/lease-relay-host.mjs (init / check / run) under the platform host policy gate
# (a ban stops the relay, sticky until the administrator's admit). Nothing here changes that role; these scripts only put
# the MOVED key and its STOPPED journal where the role keeps its own, and refuse every state in which the role's `init`
# could generate a different key or two machines could sign with one.
#
# DynamicUser + StateDirectory=enclave-host-relay: the role's state lives at /var/lib/private/enclave-host-relay (systemd
# links /var/lib/enclave-host-relay to it and chowns it to the dynamic user at every start). The config's stateRoot is the
# path the SERVICE sees (/var/lib/enclave-host-relay); root works on the real directory below.
#
# FSROOT (TEST ONLY): a prefix for every path, so the isolated tests run these exact scripts against a mock filesystem and
# mock systemctl/curl/pgrep/ss. Production never sets it; when it is set the scripts say so on every run.
set -euo pipefail
FSROOT=${FSROOT:-}
UNIT=enclave-host-relay.service
UNIT_PATH=$FSROOT/etc/systemd/system/$UNIT
UNIT_SHA=d279eb490d879d23c01190a3682e262205234c3ab14158721be6a85b8395f4c6      # main relay/systemd/enclave-host-relay.service
REPO=$FSROOT/opt/enclave                                                       # the reviewed checkout the unit runs
HOST_MJS_SHA=05b7c409d5c9526fe3cdc898e7ce4b4036ea6348fd11b8bed2b33b82e25b8e19   # main network/host-services/lease-relay-host.mjs
PKG_PIN=sha256:e3ae3c74cdc47a65a477f2f47e154bde7780bef55e893a1a15e4a64b074dc414  # lease-relay.package.json (built from main)
BUNDLE_SHA=ae4f9127bb45e4e8a1ee2c6dc4de7ecbcdc1fda171359ee3a13f86b20e0f7666     # lease-relay.mjs (named by that manifest)
GATE_SHA=80d64e2f4cb37e1982e0a04423be8c16f2a681175d8fd93ac697fbf6016084f0       # main's lease-relay-migration-check.mjs, built
CONFIG=$FSROOT/etc/enclave/host-relay.json
RECORD=$FSROOT/etc/enclave/lease-gas-deployment.json
RECORD_SHA=1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089     # the reviewed lease-gas deployment record
POLICY_IMPORT=$FSROOT/etc/enclave/platform-policy-import                       # platformHostPolicyCarriers.importDir
PKG_DIR=$FSROOT/opt/enclave-host-relay/packages
PRIV=$FSROOT/var/lib/private/enclave-host-relay
DIR=$PRIV/lease-relay
KEY=$DIR/relay.key
ADDR=$DIR/relay.address
STATE=$DIR/relay-send.json
MIG=$FSROOT/var/lib/enclave-host-relay-migration                               # root-only: staged unit, gate, receipts
GATE=$MIG/gate/lease-relay-migration-check.mjs
STAGED_UNIT=$MIG/unit.staged
EVER_STARTED=$MIG/target-ever-started
PAYEE=0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a
SOURCE_ORIGIN=https://134.209.248.172
PORT=8549
NODE=${NODE:-/usr/bin/node}                                                    # the unit's interpreter
[ -n "$FSROOT" ] && echo "** TEST ROOT $FSROOT (FSROOT set): not a production run **"

now() { date -u +%FT%TZ; }
say() { echo "[$(now)] $*"; }
sha() { sha256sum "$1" | cut -c1-64; }
lc() { tr 'A-F' 'a-f'; }
journal() { [ -d "$MIG" ] && echo "$(now) $*" >> "$MIG/progress.log"; return 0; }
show() { systemctl show -p "$1" --value "$UNIT" 2>/dev/null || true; }
masked_link() { [ -L "$UNIT_PATH" ] && [ "$(readlink "$UNIT_PATH")" = /dev/null ]; }
need_root() { [ -n "$FSROOT" ] || [ "$(id -u)" = 0 ] || { echo "refused: run as root"; exit 2; }; }
# a public field of the staged configuration (JSON; never a secret: the role refuses any key-like field)
cfg() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],c);
  console.log(Array.isArray(v)?v.join(","):String(v))' "$CONFIG" "$1"; }
info_url() { local b; b=$(cfg relay.bind); case "$b" in 0.0.0.0|::|127.0.0.1) echo "http://127.0.0.1:$PORT/v1/info" ;; ::1) echo "http://[::1]:$PORT/v1/info" ;; *) echo "http://$b:$PORT/v1/info" ;; esac; }
relay_process() { pgrep -f 'lease-relay-host\.mjs|packages/lease-relay\.mjs' >/dev/null 2>&1; }
listener() { ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; }
answers_as_payee() { local p; p=$(echo "${PAYEE#0x}" | lc); curl -fsS --max-time 5 "$(info_url)" 2>/dev/null | lc | grep -q "$p"; }
# the send record's public shape: "nothing unresolved" | "UNRESOLVED nonce N hash H" | "absent" | "not a send record"
state_shape() {
  [ -f "$STATE" ] || { echo absent; return; }
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const k=Object.keys(j).sort().join(",");
    if(k==="")console.log("nothing unresolved");else if(k==="hash,nonce,raw")console.log(`UNRESOLVED nonce ${j.nonce} hash ${j.hash}`);else console.log("not a send record")}catch{console.log("not a send record")}' "$STATE"
}
# a moved file: present, regular, non-empty, 0600 (root-owned in production until the role's first start chowns it) - never opened
moved_ok() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ -s "$1" ] || return 1
  [ "$(stat -c %a "$1")" = 600 ] || return 1
  [ -n "$FSROOT" ] || [ "$(stat -c %U "$1")" = root ]
}
dir_empty() { [ -d "$1" ] && [ -z "$(ls -A "$1")" ]; }
