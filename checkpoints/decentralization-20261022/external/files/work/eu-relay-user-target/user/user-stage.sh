#!/usr/bin/env bash
# user-stage.sh - the operator user stages the user-service target on warden-host BEFORE the eu-central source is touched.
# Nothing runs and nothing listens afterwards: the release is installed and verified, the configuration and record are
# installed, the state directory is created EMPTY (0700), and the unit is rendered into migration/ only - NOT into the
# user unit directory, so nothing can start the role before the moved key and journal arrive.
#   bash user-stage.sh --check <release.tar> <tar sha256> <stage dir>    READ-ONLY: every precondition
#   bash user-stage.sh --stage <release.tar> <tar sha256> <stage dir>    install (create-only; a partial stage never starts)
#   bash user-stage.sh --unstage                                          only while nothing moved or ran: the target root is
#                                                                         moved aside to <root>.unstaged-<time> (never deleted)
# <stage dir>: host-relay.json (user-render-config.mjs output) and lease-gas-deployment.json (1665c218).
set -euo pipefail
. "$(dirname "$0")/user-common.sh"
MODE=${1:-}
case "$MODE" in
  --check|--stage) [ $# -eq 4 ] || { echo "usage: user-stage.sh --check|--stage <release.tar> <tar sha256> <stage dir> | --unstage"; exit 2; }; TAR=$2; TAR_SHA=$3; SRC=$4 ;;
  --unstage) [ $# -eq 1 ] || { echo "usage: user-stage.sh --unstage"; exit 2; } ;;
  *) echo "usage: user-stage.sh --check|--stage <release.tar> <tar sha256> <stage dir> | --unstage"; exit 2 ;;
esac
need_user
[[ "$TARGET_ROOT" =~ ^/[A-Za-z0-9_./-]+$ ]] && [[ "$TARGET_ROOT" != *..* ]] || { echo "refused: the target root is not a plain absolute path"; exit 2; }

if [ "$MODE" = --unstage ]; then
  [ -d "$TARGET_ROOT" ] && [ ! -L "$TARGET_ROOT" ] && [ "$(stat -c %u "$TARGET_ROOT")" = "$EXPECTED_UID" ] || { echo "REFUSED: $TARGET_ROOT is not a staged target of this user"; exit 2; }
  [ ! -e "$EVER_STARTED" ] && [ ! -e "$UNIT_PATH" ] && [ ! -L "$UNIT_PATH" ] || { echo "REFUSED: the role was installed or started here: use user-out-of-service.sh"; exit 2; }
  [ ! -e "$DIR" ] || dir_empty "$DIR" || { echo "REFUSED: $DIR is not empty (a moved key or journal is there): never moved or removed by a script"; exit 2; }
  aside="$TARGET_ROOT.unstaged-$(date -u +%Y%m%dT%H%M%SZ)"
  mv --no-clobber -T "$TARGET_ROOT" "$aside" && [ ! -e "$TARGET_ROOT" ] || { echo "UNSTAGE FAILED: $TARGET_ROOT could not be moved aside"; exit 1; }
  say "UNSTAGED: the staged target is kept at $aside (nothing was deleted)"; exit 0
fi

# ---- preconditions (read-only; the release is examined in a private temporary copy that is removed afterwards)
problems=()
parent=$(dirname "$TARGET_ROOT")
if [ -d "$parent" ] && [ ! -L "$parent" ] && [ "$(stat -c %u "$parent")" = "$EXPECTED_UID" ] && [ $(( 0$(stat -c %a "$parent") & 022 )) -eq 0 ]; then :; else problems+=("$parent must be an existing directory owned by uid $EXPECTED_UID, not a symlink, not group/other writable"); fi
[ ! -e "$TARGET_ROOT" ] && [ ! -L "$TARGET_ROOT" ] || problems+=("$TARGET_ROOT exists (create-only: an earlier stage is unstaged first, never reused)")
if [ -d "$UNIT_DIR" ] && [ ! -L "$UNIT_DIR" ] && [ "$(stat -c %u "$UNIT_DIR")" = "$EXPECTED_UID" ]; then :; else problems+=("$UNIT_DIR must be the operator's user unit directory (owned, not a symlink)"); fi
for u in "$UNIT_PATH" "$LAN_UNIT_PATH"; do [ ! -e "$u" ] && [ ! -L "$u" ] || problems+=("$u exists (installed or masked earlier)"); done
[ "$(show ActiveState)" != active ] || problems+=("$UNIT is active")
! listener || problems+=("something already listens on :$PORT")
[ -f "$TAR" ] && [ ! -L "$TAR" ] && [ "$(sha "$TAR")" = "$TAR_SHA" ] || problems+=("the release archive is not the pinned $TAR_SHA")
for f in host-relay.json lease-gas-deployment.json; do [ -f "$SRC/$f" ] && [ ! -L "$SRC/$f" ] || problems+=("$SRC/$f is absent"); done
[ ! -f "$SRC/lease-gas-deployment.json" ] || [ "$(sha "$SRC/lease-gas-deployment.json")" = "$RECORD_SHA" ] || problems+=("lease-gas-deployment.json is not the reviewed $RECORD_SHA")
v=$("$NODE" -v 2>/dev/null || echo none); echo "node $NODE: $v"; [[ "$v" =~ ^v(2[2-9]|[3-9][0-9])\. ]] || problems+=("$NODE is $v; the role needs node >= 22")
REL_ID=""
if [ ${#problems[@]} -eq 0 ]; then
  # the archive: exactly one top directory named by a 64-hex id; only regular files and directories; no absolute or .. names
  bad=$(tar -tvf "$TAR" | awk '{print substr($1,1,1)}' | grep -v '^[-d]$' | head -1 || true); [ -z "$bad" ] || problems+=("the archive holds a link or special file")
  names=$(tar -tf "$TAR"); tops=$(printf '%s\n' "$names" | cut -d/ -f1 | sort -u)
  if [ "$(printf '%s\n' "$tops" | wc -l)" != 1 ] || ! [[ "$tops" =~ ^[0-9a-f]{64}$ ]] || printf '%s\n' "$names" | grep -qE '(^/|(^|/)\.\.(/|$))'; then problems+=("the archive is not one release directory"); else REL_ID=$tops; fi
fi
if [ -n "$REL_ID" ]; then
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  ( umask 077; tar -xf "$TAR" -C "$T" --no-same-owner --no-same-permissions --delay-directory-restore ) || problems+=("the archive does not extract")
  find "$T/$REL_ID" -type d -exec chmod 0700 {} + ; find "$T/$REL_ID" -type f -exec chmod 0600 {} +
  r=$("$NODE" "$T/$REL_ID/verify-release.mjs" 2>&1 | tail -1); echo "release: $r"; [[ "$r" == "release $REL_ID verified"* ]] || problems+=("release: $r")
  # the role's OWN validation (the release's copy), plus the fixed values these scripts and the unit rely on
  c=$("$NODE" --input-type=module -e '
    const [rel, file, target] = process.argv.slice(1);
    const fs = await import("node:fs"); const R = JSON.parse(fs.readFileSync(rel + "/RELEASE.json", "utf8"));
    const { validateHostRelayConfig } = await import(rel + "/app/network/host-services/lease-relay-host.mjs");
    let c; try { c = validateHostRelayConfig(JSON.parse(fs.readFileSync(file, "utf8"))); } catch (e) { console.log(e.message); process.exit(0); }
    const bad = [], want = (k, v, x) => { if (v !== x) bad.push(`${k} must be ${x}`); };
    want("stateRoot", c.stateRoot, target + "/state"); want("packagesDir", c.packagesDir, `${target}/releases/${R.releaseId}/packages`);
    want("relay.package", c.relay.package, R.relayPackage.pin); want("relay.record", c.relay.record, target + "/etc/lease-gas-deployment.json");
    want("relay.port", c.relay.port, 8549); want("relay.bind", c.relay.bind, "127.0.0.1"); want("platformHostPolicy", c.platformHostPolicy, "production");
    want("platformHostPolicyCarriers.importDir", c.platformHostPolicyCarriers?.importDir, target + "/etc/platform-policy-import");
    want("host.endpoint", c.host.endpoint, "https://api.enclave.host/t/metal0");
    if (c.relay.extraCaFile !== undefined) bad.push("relay.extraCaFile is not part of this target");
    if (c.host.publicEndpoints.length) bad.push("host.publicEndpoints must be empty (nothing is advertised)");
    console.log(bad.length ? bad.join("; ") : "ok");' "$T/$REL_ID" "$SRC/host-relay.json" "$TARGET_ROOT" 2>&1 | tail -1)
  echo "host-relay.json: $c"; [ "$c" = ok ] || problems+=("host-relay.json: $c")
fi
if [ ${#problems[@]} -gt 0 ]; then for p in "${problems[@]}"; do echo "PRECONDITION FAILED: $p"; done; echo "NOTHING CHANGED"; exit 2; fi
if [ "$MODE" = --check ]; then echo "CHECK OK: release $REL_ID; every precondition holds (read-only; nothing changed)"; exit 0; fi

# ---- --stage: create-only, each step verified; a failure leaves an incomplete target that can never start (no unit)
fail() { journal "stage FAILED: $1"; echo "STAGE INCOMPLETE: $1 (no unit exists, nothing can start; inspect, then user-stage.sh --unstage)"; exit 1; }
umask 077
mkdir -m 0700 "$TARGET_ROOT" || fail "could not create $TARGET_ROOT"
mkdir -m 0700 "$TARGET_ROOT/releases" "$ETC" "$POLICY_IMPORT" "$STATE_ROOT" "$DIR" "$MIG" || fail "the target directories could not be created"
journal "stage begin; release $REL_ID; archive $TAR_SHA"
inc=$TARGET_ROOT/releases/.incoming-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n'); mkdir -m 0700 "$inc"
tar -xf "$TAR" -C "$inc" --no-same-owner --no-same-permissions || fail "the archive did not extract"
find "$inc/$REL_ID" -type d -exec chmod 0700 {} + ; find "$inc/$REL_ID" -type f -exec chmod 0600 {} +
r=$("$NODE" "$inc/$REL_ID/verify-release.mjs" 2>&1 | tail -1); [[ "$r" == "release $REL_ID verified"* ]] || fail "the installed release did not verify: $r"
mv --no-clobber -T "$inc/$REL_ID" "$TARGET_ROOT/releases/$REL_ID" && rmdir "$inc" || fail "the release could not be moved into place"
put() { [ ! -e "$2" ] || fail "$2 appeared meanwhile"; install -m 0600 "$1" "$2.stage-tmp" && mv --no-clobber -T "$2.stage-tmp" "$2" && [ "$(sha "$2")" = "$(sha "$1")" ] || fail "$2 could not be installed"; }
put "$SRC/host-relay.json" "$CONFIG"; put "$SRC/lease-gas-deployment.json" "$RECORD"
( set -o noclobber; echo "$REL_ID" > "$MIG/release-id"; sha "$CONFIG" > "$MIG/config.sha256" ) || fail "the pins could not be written"
for u in "$UNIT:enclave-host-relay-eu.service.in" "$LAN_UNIT:enclave-host-relay-eu-lan.service.in"; do
  sed -e "s#@TARGET@#$TARGET_ROOT#g" -e "s#@RELEASE@#$REL_ID#g" "$TARGET_ROOT/releases/$REL_ID/units/${u#*:}" > "$MIG/${u%%:*}.staged" || fail "the unit could not be rendered"
  ! grep -q '@[A-Z]*@' "$MIG/${u%%:*}.staged" || fail "the rendered unit still holds a placeholder"
done
dir_empty "$DIR" || fail "$DIR is not empty"
( set -o noclobber; printf '{"stagedAt":"%s","release":"%s","archiveSha256":"%s","configSha256":"%s","recordSha256":"%s","unitStagedSha256":"%s","lanUnitStagedSha256":"%s","unitInstalled":false,"stateDirEmpty":true}\n' \
  "$(now)" "$REL_ID" "$TAR_SHA" "$(sha "$CONFIG")" "$RECORD_SHA" "$(sha "$MIG/$UNIT.staged")" "$(sha "$MIG/$LAN_UNIT.staged")" > "$MIG/staging-receipt.json" ) || fail "the receipt could not be written"
journal "stage done"
say "STAGED: release $REL_ID verified and installed; unit NOT installed (nothing can start the role); $DIR empty. Config sha256 $(sha "$CONFIG")"
