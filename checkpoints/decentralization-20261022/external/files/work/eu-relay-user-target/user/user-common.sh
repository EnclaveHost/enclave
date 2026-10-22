# user-common.sh - shared definitions for the USER-SERVICE target of the eu-central relay move (sourced; changes nothing).
# The target is main's lease-relay HOST ROLE run by the host operator's own user manager (systemctl --user), from an
# immutable release (build-release.mjs) under the operator's home, with the MOVED key and its STOPPED journal in a 0700
# state directory owned by that user. Root-free: every step runs as the operator user; the eu-central source side keeps
# its root scripts (source/eu-source-*.sh, byte-identical to the tested ones). One-active-key discipline:
#   - a staged target holds NO unit, so nothing can start the role before the moved files arrive;
#   - the role's unit never runs `init` (it can never generate a key); `check` refuses without the key;
#   - transfer writes the source's transfer-begun marker first, then the journal, then the key;
#   - activation writes target-ever-started BEFORE the unit can start; from then on only this host's journal may go back.
# TEST_* variables exist for the isolated tests only and are announced on every run; production never sets them.
set -euo pipefail
EXPECTED_USER=steven
TARGET_ROOT=${TEST_TARGET_ROOT:-/home/steven/enclave-prod/host-relay-eu}
UNIT_DIR=${TEST_UNIT_DIR:-$HOME/.config/systemd/user}
EXPECTED_UID=${TEST_EXPECTED_UID:-$(id -u)}
NODE=${TEST_NODE:-/usr/bin/node}
if [ -n "${TEST_TARGET_ROOT:-}${TEST_UNIT_DIR:-}${TEST_EXPECTED_UID:-}${TEST_NODE:-}${TEST_GATE:-}" ]; then echo "** TEST target (TEST_* set): not a production run **"; fi
# TEST ONLY: a stub migration gate, honoured only with a test target root (the mock lifecycle never contacts a chain)
if [ -n "${TEST_GATE:-}" ] && [ -z "${TEST_TARGET_ROOT:-}" ]; then echo "refused: TEST_GATE without a TEST_TARGET_ROOT"; exit 2; fi
UNIT=enclave-host-relay-eu.service
LAN_UNIT=enclave-host-relay-eu-lan.service
UNIT_PATH=$UNIT_DIR/$UNIT
LAN_UNIT_PATH=$UNIT_DIR/$LAN_UNIT
ETC=$TARGET_ROOT/etc
CONFIG=$ETC/host-relay.json
RECORD=$ETC/lease-gas-deployment.json
POLICY_IMPORT=$ETC/platform-policy-import
STATE_ROOT=$TARGET_ROOT/state
DIR=$STATE_ROOT/lease-relay
KEY=$DIR/relay.key
ADDR=$DIR/relay.address
STATE=$DIR/relay-send.json
MIG=$TARGET_ROOT/migration
EVER_STARTED=$MIG/target-ever-started
RECORD_SHA=1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089     # the reviewed lease-gas deployment record
PAYEE=0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a                              # the moved eu-central relay key's address
SOURCE_ORIGIN=https://134.209.248.172
PORT=8549
INFO_URL=http://127.0.0.1:$PORT/v1/info
LAN_LISTEN=192.168.8.249
SYSTEMCTL=(systemctl --user)

now() { date -u +%FT%TZ; }
say() { echo "[$(now)] $*"; }
sha() { sha256sum "$1" | cut -c1-64; }
lc() { tr 'A-F' 'a-f'; }
journal() { [ -d "$MIG" ] && [ ! -L "$MIG" ] && echo "$(now) $*" >> "$MIG/progress.log"; return 0; }
show() { "${SYSTEMCTL[@]}" show -p "$1" --value "${2:-$UNIT}" 2>/dev/null || true; }
masked_link() { [ -L "${1:-$UNIT_PATH}" ] && [ "$(readlink "${1:-$UNIT_PATH}")" = /dev/null ]; }
need_user() { [ -n "${TEST_EXPECTED_UID:-}${TEST_TARGET_ROOT:-}" ] || [ "$(id -un)" = "$EXPECTED_USER" ] || { echo "refused: run as $EXPECTED_USER (the operator user), not $(id -un)"; exit 2; }; [ "$(id -u)" != 0 ] || { echo "refused: not as root (this is the user-service target)"; exit 2; }; }
# ownership: the entry exists, is not a symlink, is owned by the operator uid, and has no group/other bits
owned() { [ -e "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = "$EXPECTED_UID" ] && [ $(( 0$(stat -c %a "$1") & 077 )) -eq 0 ]; }
owned_dir() { owned "$1" && [ -d "$1" ] && [ "$(stat -c %a "$1")" = 700 ]; }
owned_file() { owned "$1" && [ -f "$1" ] && [ -s "$1" ] && [ "$(stat -c %a "$1")" = 600 ]; }
# every path component from the target root down is the operator's (no symlinked or foreign directory on the way)
chain_ok() { local p=$1; while [ "$p" != "$TARGET_ROOT" ] && [ "$p" != / ]; do p=$(dirname "$p"); [ "$p" = "$TARGET_ROOT" ] || owned_dir "$p" || return 1; done; owned_dir "$TARGET_ROOT"; }
dir_empty() { [ -d "$1" ] && [ -z "$(ls -A "$1")" ]; }
listener() { ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; }
relay_process() { pgrep -u "$EXPECTED_UID" -f "host-relay-eu/releases/.*/(app/network/host-services/lease-relay-host\.mjs|packages/lease-relay\.mjs)" >/dev/null 2>&1; }
answers_as_payee() { local p; p=$(echo "${PAYEE#0x}" | lc); curl -fsS --max-time 5 "$INFO_URL" 2>/dev/null | lc | grep -q "$p"; }
state_shape() {
  [ -f "$STATE" ] || { echo absent; return; }
  "$NODE" -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const k=Object.keys(j).sort().join(",");
    if(k==="")console.log("nothing unresolved");else if(k==="hash,nonce,raw")console.log(`UNRESOLVED nonce ${j.nonce} hash ${j.hash}`);else console.log("not a send record")}catch{console.log("not a send record")}' "$STATE"
}
# the staged release (its id is pinned at staging); a public field of the staged configuration (no secret: the role refuses key-like fields)
release_id() { cat "$MIG/release-id"; }
RELEASE() { echo "$TARGET_ROOT/releases/$(release_id)"; }
cfg() { "$NODE" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],c);
  console.log(Array.isArray(v)?v.join(","):String(v))' "$CONFIG" "$1"; }
verify_release() { "$NODE" "$(RELEASE)/verify-release.mjs"; }
gate_path() { echo "${TEST_GATE:-$(RELEASE)/gate/lease-relay-migration-check.mjs}"; }
