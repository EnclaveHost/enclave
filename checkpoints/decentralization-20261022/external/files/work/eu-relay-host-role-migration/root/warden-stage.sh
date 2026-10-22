#!/usr/bin/env bash
# warden-stage.sh - ROOT runs this ON warden (metal0's host) BEFORE the eu-central source is touched. It installs the host
# role's reviewed inputs and an EMPTY protected state directory - and deliberately NOT the unit: with no unit file in
# /etc/systemd/system nothing can start the role, so its `init` can never generate a fresh key in the directory the moved
# key goes to. Staging changes nothing that runs; its rollback is warden-stage.sh --unstage (only while nothing was moved).
#   sudo bash warden-stage.sh --check   <stage dir>   READ-ONLY: every precondition and every staged input's sha256
#   sudo bash warden-stage.sh --stage   <stage dir>   install (create-only; identical bytes already in place are accepted)
#   sudo bash warden-stage.sh --unstage               remove what --stage installed, ONLY while the state dir is still empty
# <stage dir> holds: lease-relay.mjs, lease-relay.package.json (the package), lease-relay-migration-check.mjs (the gate),
# host-relay.json (render-host-relay-config.mjs output), lease-gas-deployment.json, enclave-host-relay.service.
set -euo pipefail
. "$(dirname "$0")/warden-common.sh"
MODE=${1:-}; SRC=${2:-}
case "$MODE" in --check|--stage) [ -d "$SRC" ] || { echo "usage: warden-stage.sh --check|--stage <stage dir> | --unstage"; exit 2; } ;; --unstage) ;; *) echo "usage: warden-stage.sh --check|--stage <stage dir> | --unstage"; exit 2 ;; esac
need_root

if [ "$MODE" = --unstage ]; then
  [ -f "$MIG/staging-receipt.json" ] || { echo "REFUSED: no staging receipt; nothing to unstage"; exit 2; }
  [ ! -e "$EVER_STARTED" ] && [ ! -e "$UNIT_PATH" ] || { echo "REFUSED: the role was installed or started: use warden-out-of-service.sh"; exit 2; }
  dir_empty "$DIR" || { echo "REFUSED: $DIR is not empty (a moved key or journal is there): never removed by a script"; exit 2; }
  # only the exact bytes --stage installed are removed (CAS); anything else is kept and named
  for f in "$PKG_DIR/lease-relay.mjs:$BUNDLE_SHA" "$PKG_DIR/lease-relay.package.json:${PKG_PIN#sha256:}" "$RECORD:$RECORD_SHA" "$CONFIG:$(cat "$MIG/config.sha256" 2>/dev/null)"; do
    p=${f%%:*}; s=${f#*:}; [ -e "$p" ] || continue
    if [ -f "$p" ] && [ "$(sha "$p")" = "$s" ]; then rm -f "$p"; else echo "kept $p: not the staged bytes"; fi
  done
  rmdir "$DIR" "$PRIV" "$PKG_DIR" "$POLICY_IMPORT" 2>/dev/null || true
  mv -T "$MIG" "$MIG.unstaged-$(date -u +%Y%m%dT%H%M%SZ)"
  say "UNSTAGED (the receipts are kept in $MIG.unstaged-*)"; exit 0
fi

# ---- preconditions (read-only)
problems=()
want() { local f=$SRC/$1 s; [ -f "$f" ] || { problems+=("$1 is absent from $SRC"); return; }; s=$(sha "$f"); echo "staged $1 sha256 $s"; [ -z "$2" ] || [ "$s" = "$2" ] || problems+=("$1 is $s, not the reviewed $2"); }
want lease-relay.package.json "${PKG_PIN#sha256:}"; want lease-relay.mjs "$BUNDLE_SHA"; want lease-relay-migration-check.mjs "$GATE_SHA"
want lease-gas-deployment.json "$RECORD_SHA"; want enclave-host-relay.service "$UNIT_SHA"; want host-relay.json ""
v=$("$NODE" -v 2>/dev/null || echo none); echo "node $NODE: $v"; [[ "$v" =~ ^v(2[2-9]|[3-9][0-9])\. ]] || problems+=("$NODE is $v; the role needs node >= 22")
if [ -f "$REPO/network/host-services/lease-relay-host.mjs" ]; then h=$(sha "$REPO/network/host-services/lease-relay-host.mjs"); echo "role supervisor $REPO/network/host-services/lease-relay-host.mjs sha256 $h"
  [ "$h" = "$HOST_MJS_SHA" ] || problems+=("the role supervisor is $h, not main's $HOST_MJS_SHA"); [ -d "$REPO/node_modules/viem" ] || problems+=("$REPO/node_modules/viem is absent (the supervisor imports it)")
else problems+=("no reviewed checkout at $REPO (the unit runs $REPO/network/host-services/lease-relay-host.mjs)"); fi
if [ -f "$SRC/host-relay.json" ] && [ -f "$REPO/network/host-services/lease-relay-host.mjs" ]; then
  # the role's OWN validation, plus the fixed values these scripts rely on
  r=$("$NODE" --input-type=module -e '
    const [repo, file, pin, port] = process.argv.slice(1);
    const { validateHostRelayConfig } = await import(repo + "/network/host-services/lease-relay-host.mjs");
    let c; try { c = validateHostRelayConfig(JSON.parse((await import("node:fs")).readFileSync(file, "utf8"))); } catch (e) { console.log(e.message); process.exit(0); }
    const bad = [];
    if (c.relay.package !== pin) bad.push(`relay.package is ${c.relay.package}, not ${pin}`);
    if (c.stateRoot !== "/var/lib/enclave-host-relay") bad.push("stateRoot must be /var/lib/enclave-host-relay (the unit StateDirectory)");
    if (c.packagesDir !== "/opt/enclave-host-relay/packages") bad.push("packagesDir must be /opt/enclave-host-relay/packages");
    if (c.relay.record !== "/etc/enclave/lease-gas-deployment.json") bad.push("relay.record must be /etc/enclave/lease-gas-deployment.json");
    if (String(c.relay.port) !== port) bad.push(`relay.port must be ${port}`);
    if (c.platformHostPolicy === "off") bad.push("platformHostPolicy off is not a production configuration");
    if (!c.platformHostPolicyCarriers) bad.push("no platform host policy carriers: with the fleet mirrors down the relay could not start");
    console.log(bad.length ? bad.join("; ") : "ok");' "$REPO" "$SRC/host-relay.json" "$PKG_PIN" "$PORT" 2>&1 | tail -1)
  echo "host-relay.json: $r"; [ "$r" = ok ] || problems+=("host-relay.json: $r")
fi
[ ! -e "$UNIT_PATH" ] || problems+=("$UNIT_PATH exists: the role is already installed here")
[ "$(show ActiveState)" != active ] || problems+=("$UNIT is active")
if [ -e "$DIR" ]; then dir_empty "$DIR" || problems+=("$DIR is not empty (a key or journal is already there)"); fi
! listener || problems+=("something already listens on :$PORT")
[ ! -e "$EVER_STARTED" ] || problems+=("$EVER_STARTED exists: the role ran here before; a new move needs a new review")
for f in "$PKG_DIR/lease-relay.mjs:$SRC/lease-relay.mjs" "$PKG_DIR/lease-relay.package.json:$SRC/lease-relay.package.json" "$CONFIG:$SRC/host-relay.json" "$RECORD:$SRC/lease-gas-deployment.json"; do
  d=${f%%:*}; s=${f#*:}; [ ! -e "$d" ] || [ ! -f "$s" ] || [ "$(sha "$d")" = "$(sha "$s")" ] || problems+=("$d exists with other bytes (never overwritten)")
done
if [ ${#problems[@]} -gt 0 ]; then for p in "${problems[@]}"; do echo "PRECONDITION FAILED: $p"; done; echo "NOTHING CHANGED"; exit 2; fi
if [ "$MODE" = --check ]; then echo "CHECK OK: every precondition holds (read-only; nothing changed)"; exit 0; fi

# ---- --stage (create-only; each copy verified)
fail() { journal "stage FAILED: $1"; echo "STAGE INCOMPLETE: $1 (nothing runs; re-run --stage after fixing, or --unstage)"; exit 1; }
put() {   # put <src> <dst> <mode>: create-only; an identical file already in place is accepted
  if [ -e "$2" ]; then [ "$(sha "$2")" = "$(sha "$1")" ] || fail "$2 appeared with other bytes"; return 0; fi
  install -D -m "$3" "$1" "$2.stage-tmp" && mv --no-clobber -T "$2.stage-tmp" "$2" && [ "$(sha "$2")" = "$(sha "$1")" ] || fail "$2 could not be installed"
}
[ -d "$MIG" ] || mkdir -m 0700 "$MIG" || fail "could not create $MIG"
journal "stage begin"
put "$SRC/lease-relay.mjs" "$PKG_DIR/lease-relay.mjs" 0644
put "$SRC/lease-relay.package.json" "$PKG_DIR/lease-relay.package.json" 0644
put "$SRC/lease-gas-deployment.json" "$RECORD" 0644
put "$SRC/host-relay.json" "$CONFIG" 0644
put "$SRC/lease-relay-migration-check.mjs" "$GATE" 0600
put "$SRC/enclave-host-relay.service" "$STAGED_UNIT" 0600
mkdir -p -m 0755 "$POLICY_IMPORT"
[ -d "$FSROOT/var/lib/private" ] || mkdir -m 0700 "$FSROOT/var/lib/private"
[ -d "$PRIV" ] || mkdir -m 0700 "$PRIV"; [ -d "$DIR" ] || mkdir -m 0700 "$DIR"
dir_empty "$DIR" || fail "$DIR is not empty"
[ -f "$MIG/config.sha256" ] || ( set -o noclobber; sha "$CONFIG" > "$MIG/config.sha256" ) || fail "the config pin could not be written"
[ "$(cat "$MIG/config.sha256")" = "$(sha "$CONFIG")" ] || fail "the installed config is not the one staged earlier"
[ -f "$MIG/staging-receipt.json" ] || ( set -o noclobber; printf '{"stagedAt":"%s","package":"%s","bundleSha256":"%s","gateSha256":"%s","recordSha256":"%s","unitSha256":"%s","configSha256":"%s","unitInstalled":false,"stateDir":"%s","stateDirEmpty":true}\n' \
  "$(now)" "$PKG_PIN" "$BUNDLE_SHA" "$GATE_SHA" "$RECORD_SHA" "$UNIT_SHA" "$(sha "$CONFIG")" "${DIR#$FSROOT}" > "$MIG/staging-receipt.json" ) || fail "the receipt could not be written"
journal "stage done"
say "STAGED: inputs installed, unit NOT installed (nothing can start the role), $DIR empty. Config sha256 $(sha "$CONFIG")"
