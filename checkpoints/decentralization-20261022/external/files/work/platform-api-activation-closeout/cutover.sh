#!/bin/bash
# cutover.sh -- ROOT's sequenced cutover of api.enclave.host from the ordinary minipc control VM to the measured platform API
# group. Prepared by the worker, NEVER executed by it. Default prints the plan; `cutover.sh run <step>` runs exactly ONE step;
# steps that touch production also need CUTOVER_ACK=<groupId> in the environment. Every value comes from root (below); the
# worker guessed no unit name, path or address.
#
# Root sets:
#   TREE               the reviewed enclave tree (bundle 2dbdde0e… pinned; scripts/build-platform-api-guest-bundle.mjs --check green)
#   CFG                directory holding every member's direct config m*.json (identical platformApi; public)
#   GENESIS_CFG        the ONE member config genesis targets (its own members[] entry gives the controlUrl)
#   EXPECT_MEASUREMENT the SNP launch measurement of root's image build carrying the bundle (96 hex)
#   OLD_DATA_DIR       the old API's AUTH_DATA_DIR on the minipc control VM   (read only, by the opaque helpers)
#   OLD_ENV_FILE       the old API's EnvironmentFile                            (read only, by the opaque helpers)
#   OLD_STOP_CMD       root's command that stops the old API AND disables its autostart (the fence)
#   WORK               a NEW 0700 directory on the old box (plaintext copy + creds live here until step 9)
#   SIGNATURE          (step 6 only) the admin's 0x… signature over genesis-message.txt
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)/helpers"
export ENCLAVE_TREE="${TREE:-}"
need() { for v in "$@"; do [ -n "${!v:-}" ] || { echo "set $v first" >&2; exit 2; }; done; }
ack() { need TREE GENESIS_CFG; local gid; gid=$(node "$H/pa-group-id.mjs" "$GENESIS_CFG")
        [ "${CUTOVER_ACK:-}" = "$gid" ] || { echo "production step: set CUTOVER_ACK=$gid to run it" >&2; exit 3; }; }
flags() { local f; for f in "$CFG"/m*.json; do printf -- '%s %s ' "$1" "$f"; done; }
target() { node "$H/pa-group-id.mjs" "$GENESIS_CFG" --control-url; }
admin() { (cd "$TREE" && node scripts/platform-api-admin.mjs "$@"); }

plan() { cat <<'EOF'
0  BUILD CHECK (pure)        node $TREE/scripts/build-platform-api-guest-bundle.mjs --check; bundle sha256 must be 2dbdde0e…
1  CONFIG CHECK (pure)       pa-config-check.mjs --direct-config $CFG/m*.json [--relay-env $WORK/relay-env.json after step 4]
2  PREFLIGHT (read-only)     pa-preflight.mjs --target-config $CFG/m*.json --expect-measurement $EXPECT_MEASUREMENT
                             -> every member verified (registry ACTIVE with this boot's proof key), >= 3 distinct SNP chips
3  FENCE (production)        $OLD_STOP_CMD; confirm the old API serves nothing and will not autostart. API down until step 8.
4  OPAQUE EXPORT (old box)   pa-credentials-assemble.mjs --env-file $OLD_ENV_FILE --creds-out $WORK/creds.json --public-out $WORK/relay-env.json
                               --imports-out $WORK/imports.json
                             pa-export-check.mjs --data-dir $OLD_DATA_DIR --imports $WORK/imports.json --manifest-out $WORK/export-manifest.json
                               --copy-to $WORK/data          (route-state and other out-of-directory state imported into the copy)
                             then re-run 1 with --relay-env (relayEnv must keep every old public value, with the state paths rewritten)
5  GENESIS UNSIGNED          platform-api-admin.mjs genesis --target <controlUrl> --target-config $GENESIS_CFG --import-dir $WORK/data
                               --credentials $WORK/creds.json --envelope-out $WORK/recovery-envelope.json --print-message
                               --package-out $WORK/genesis-package.json > $WORK/genesis-message.txt
6  SIGN (USER) + SEND        an admins[] hardware wallet personal_signs genesis-message.txt; then
                             platform-api-admin.mjs genesis --target <controlUrl> --target-config $GENESIS_CFG --package $WORK/genesis-package.json --signature 0x…
7  GROUP UP (read-only)      pa-preflight.mjs … --after-genesis -> a majority holds K, one leader; `latest` + recovery.json at every sink
8  ACCEPTANCE, THEN SWITCH   acceptance A1-A9 (outputs/platform-api-activation-review) against the members; then DNS + WebPKI + S4
                             ingress for api.enclave.host (other owners; not scripted here)
9  CLEANUP (after rollback window) rm -rf $WORK/data $WORK/creds.json; keep OLD_DATA_DIR, export-manifest.json, recovery-envelope.json
EOF
}
run() {
  case "$1" in
  0) need TREE; (cd "$TREE" && node scripts/build-platform-api-guest-bundle.mjs --check && sha256sum metal/guest/platform-api.bundle.mjs) ;;
  1) need TREE CFG; if [ -n "${WORK:-}" ] && [ -f "$WORK/relay-env.json" ]; then node "$H/pa-config-check.mjs" $(flags --direct-config) --relay-env "$WORK/relay-env.json"
     else node "$H/pa-config-check.mjs" $(flags --direct-config); fi ;;
  2) need TREE CFG EXPECT_MEASUREMENT; node "$H/pa-preflight.mjs" $(flags --target-config) --expect-measurement "$EXPECT_MEASUREMENT" ;;
  3) need OLD_STOP_CMD; ack; bash -c "$OLD_STOP_CMD" ;;
  4) need OLD_DATA_DIR OLD_ENV_FILE WORK; ack; if [ -e "$WORK" ]; then echo "WORK exists: refusing" >&2; exit 2; fi; mkdir -m 700 "$WORK"
     node "$H/pa-credentials-assemble.mjs" --env-file "$OLD_ENV_FILE" --creds-out "$WORK/creds.json" --public-out "$WORK/relay-env.json" --imports-out "$WORK/imports.json"
     node "$H/pa-export-check.mjs" --data-dir "$OLD_DATA_DIR" --imports "$WORK/imports.json" --manifest-out "$WORK/export-manifest.json" --copy-to "$WORK/data" ;;
  5) need WORK; ack; admin genesis --target "$(target)" --target-config "$GENESIS_CFG" --import-dir "$WORK/data" --credentials "$WORK/creds.json" \
       --envelope-out "$WORK/recovery-envelope.json" --print-message --package-out "$WORK/genesis-package.json" > "$WORK/genesis-message.txt" ;;
  6) need WORK SIGNATURE; ack; admin genesis --target "$(target)" --target-config "$GENESIS_CFG" --package "$WORK/genesis-package.json" --signature "$SIGNATURE" ;;
  7) need TREE CFG EXPECT_MEASUREMENT; node "$H/pa-preflight.mjs" $(flags --target-config) --expect-measurement "$EXPECT_MEASUREMENT" --after-genesis ;;
  8|9) echo "step $1 is manual (see plan)"; plan | grep "^$1 " ;;
  *) echo "unknown step $1" >&2; exit 2 ;;
  esac
}
if [ "${1:-}" = run ]; then run "${2:?run <step>}"; else plan; fi
