# eu-source-common.sh - shared definitions for eu-source-stop.sh, eu-source-restore.sh and the transfer scripts (sourced;
# changes nothing). The eu-central DigitalOcean lease relay (134.209.248.172, payee 0xC5D88d2D...), installed from the SAME
# reviewed kit as us-west (work/lease-relay-activation/final-94f4ebdf: eu-central-credential-unit.json = unit 4b3e5ac7,
# eu-central-install.json = relay.env 7c05d44a): unit enclave-lease-relay.service, a real unit file in /etc/systemd/system;
# key /var/lib/enclave-lease-relay/relay.key (root, 0600); send record under /var/lib/private/enclave-lease-relay-state.
# Adapted from work/windows-local-relay-migration/root/relay-source-common.sh (us-west -> minipc, used by root 2026-10-21);
# the only differences are the payee, the https front, and the transfer markers below.
# No key or send-record CONTENT is ever printed: the key is only stat()ed; the send record is public signed bytes, of which
# only its shape (nonce, hash) and sha256 are printed.
#
# FSROOT (TEST ONLY): a prefix for every path, so the isolated lifecycle tests run these exact scripts against a mock
# filesystem and a mock systemctl on PATH. Production never sets it; when it is set the scripts say so on every run.
set -euo pipefail
FSROOT=${FSROOT:-}
UNIT=enclave-lease-relay.service
UNIT_PATH=$FSROOT/etc/systemd/system/$UNIT
UNIT_SHA=4b3e5ac7b384911aec0995bc42d255c1b503197935aa24f5945984fd4e09b6ba     # the reviewed credential-copy unit (relays-active.json)
ENV_FILE=$FSROOT/etc/enclave-lease-relay/relay.env
ENV_SHA=7c05d44ad8b0ad2777d73af8cb7895c6dbb8abd040ce8e5cb36e8d466b0d6769      # the reviewed relay.env (final-94f4ebdf)
KEY=$FSROOT/var/lib/enclave-lease-relay/relay.key
STATE_DIR=$FSROOT/var/lib/private/enclave-lease-relay-state
STATE=$STATE_DIR/relay-send.json
MIG=$FSROOT/var/lib/enclave-lease-relay-migration                           # root-only: rollback unit copy, moved unit, receipts
PAYEE=0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a
FRONT=${RELAY_FRONT_ORIGIN:-https://134.209.248.172}
# The key may have run on the target from the moment a transfer BEGINS: transfer-to-warden.sh writes this create-only, on
# THIS host, before anything is copied. Once it exists the source restarts only from the target's returned journal
# (eu-source-restore.sh --after-target-start), never from its own (possibly stale) record - with ONE exception: the
# transfer script itself proved that nothing reached the target (TRANSFER_NOTHING; see transfer-to-warden.sh).
TRANSFER_BEGUN=$MIG/transfer-begun
TRANSFER_NOTHING=$MIG/transfer-key-not-delivered
RETURNED=$STATE.from-target
[ -n "$FSROOT" ] && echo "** TEST ROOT $FSROOT (FSROOT set): not a production run **"

now() { date -u +%FT%TZ; }
say() { echo "[$(now)] $*"; }
sha() { sha256sum "$1" | cut -c1-64; }
lc() { tr 'A-F' 'a-f'; }
journal() { [ -d "$MIG" ] && echo "$(now) $*" >> "$MIG/progress.log"; return 0; }
show() { systemctl show -p "$1" --value "$UNIT" 2>/dev/null || true; }
masked_link() { [ -L "$UNIT_PATH" ] && [ "$(readlink "$UNIT_PATH")" = /dev/null ]; }
# does ANYTHING still answer as the payee? the local listener, the https front (nginx state is metadata only: ask it)
answers_as_payee() {
  local p; p=$(echo "${PAYEE#0x}" | lc)
  curl -fsS --max-time 5 http://127.0.0.1:8549/v1/info 2>/dev/null | lc | grep -q "$p" && return 0
  curl -fsS --max-time 8 "$FRONT/v1/info" 2>/dev/null | lc | grep -q "$p" && return 0
  return 1
}
relay_process() { pgrep -f 'lease-relay\.mjs' >/dev/null 2>&1; }
listener() { ss -Hltn 'sport = :8549' 2>/dev/null | grep -q .; }
# the send record's public shape: "nothing unresolved" | "UNRESOLVED nonce N hash H" | "absent" | "not a send record"
state_shape() {
  [ -f "$STATE" ] || { echo absent; return; }
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const k=Object.keys(j).sort().join(",");
    if(k==="")console.log("nothing unresolved");else if(k==="hash,nonce,raw")console.log(`UNRESOLVED nonce ${j.nonce} hash ${j.hash}`);else console.log("not a send record")}catch{console.log("not a send record")}' "$STATE"
}
need_root() { [ -n "$FSROOT" ] || [ "$(id -u)" = 0 ] || { echo "refused: run as root"; exit 2; }; }
# the key: present, regular, 0600, root-owned (production), non-empty - never opened
key_ok() {
  [ -f "$KEY" ] && [ ! -L "$KEY" ] && [ -s "$KEY" ] || return 1
  [ "$(stat -c %a "$KEY")" = 600 ] || return 1
  [ -n "$FSROOT" ] || [ "$(stat -c %U "$KEY")" = root ]
}

# compare-and-swap rechecks, run immediately before every write that depends on them
cas_unit_at() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(sha "$1")" = "$UNIT_SHA" ]; }
cas_env() { [ -f "$ENV_FILE" ] && [ "$(sha "$ENV_FILE")" = "$ENV_SHA" ]; }

# The migration gate's environment, built EXPLICITLY (never by sourcing relay.env, never inheriting this shell's environment):
#   - from relay.env, only these public names (parsed as NAME=value lines, no shell evaluation; values never printed);
#   - LEASE_RELAY_KEY_FILE = the PROTECTED ORIGINAL key ($KEY). The unit sets its own KEY_FILE only through Environment= to
#     the LoadCredential copy under %t/enclave-lease-relay-credentials, which vanishes when the unit stops;
#   - LEASE_RELAY_STATE = the record being judged (the unit sets STATE only through Environment= too);
#   - LEASE_RELAY_EXPECTED_PAYEE = the moved key's address.
GATE_PUBLIC=(LEASE_RELAY_RECORD LEASE_RELAY_DIGEST LEASE_RELAY_RPCS LEASE_RELAY_QUORUM LEASE_RELAY_MAX_FLOAT_ETH LEASE_RELAY_MIN_FLOAT_ETH)
gate_env() {   # -> NAME=value lines on stdout (consumed by run_gate only)
  local rec=$1 name val
  for name in "${GATE_PUBLIC[@]}"; do
    val=$(grep -E "^${name}=" "$ENV_FILE" | tail -1 | cut -d= -f2-) || true
    [ -n "$val" ] || { echo "relay.env has no $name" >&2; return 1; }
    printf '%s=%s\n' "$name" "$val"
  done
  printf 'LEASE_RELAY_KEY_FILE=%s\nLEASE_RELAY_STATE=%s\nLEASE_RELAY_EXPECTED_PAYEE=%s\n' "$KEY" "$rec" "$PAYEE"
}
run_gate() {   # run_gate <gate.mjs> <record>: the gate with exactly that environment (+ PATH), nothing else
  local gate=$1 rec=$2 lines
  lines=$(gate_env "$rec") || return 1
  mapfile -t vars <<<"$lines"
  env -i PATH="$PATH" "${vars[@]}" node "$gate"
}
