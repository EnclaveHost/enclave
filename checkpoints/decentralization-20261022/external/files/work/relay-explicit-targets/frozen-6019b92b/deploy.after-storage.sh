#!/usr/bin/env bash
# Deploy Enclave's control API and authoritative DNS to the targets the operator names. Hosts' privacy agents and the
# Enclave-network providers are deployed separately. Host-owned state (env files, state directories, installed units,
# anything else in the install directory) is never replaced; only the files this script ships are.
#
#   RELAY_DEPLOY_ROLES=api,dns \
#   RELAY_API_TARGET=<ssh alias or user@host> RELAY_API_DIR=/opt/nan-relay \
#   RELAY_DNS_TARGET=<ssh alias or user@host> RELAY_DNS_DIR=/opt/enclave-dns \
#     bash relay/deploy.sh [preflight args]
#   bash relay/deploy.sh --check-config     validate the configuration only (no ssh, no build, no preflight)
#
# There is no default host: a target comes from the operator (an alias in their own ssh config, or user@host) and a
# directory must equal the WorkingDirectory of the unit already installed there. API and DNS are separate roles even on
# one host: separate directory, unit, staging and checks. A selected role that cannot be reached or does not agree
# fails the whole deploy before anything is copied; nothing is skipped while reporting success.
set -euo pipefail
cd "$(dirname "$0")"

# ---- configuration: explicit and validated before ANY side effect ----------
die() { echo "::error::$*" >&2; exit 2; }
TARGET_RE='^([a-z_][a-z0-9_-]{0,31}@)?[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'   # no options, ports, paths or shell
DIR_RE='^/opt/[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*$'                                       # one /opt component, no ".."
[ -n "${RELAY_DEPLOY_ROLES:-}" ] || die "RELAY_DEPLOY_ROLES is not set: name the roles to deploy (api, dns or api,dns); there is no default target"
ROLES=()
set -f; read -ra REQUESTED <<<"${RELAY_DEPLOY_ROLES//,/ }"; set +f
for r in "${REQUESTED[@]}"; do
  case "$r" in api|dns) [[ " ${ROLES[*]-} " == *" $r "* ]] || ROLES+=("$r") ;; *) die "RELAY_DEPLOY_ROLES: unknown role '$r' (api, dns)" ;; esac
done
[ ${#ROLES[@]} -gt 0 ] || die "RELAY_DEPLOY_ROLES names no role (api, dns)"
has() { [[ " ${ROLES[*]} " == *" $1 "* ]]; }
declare -A TARGET DIR UNIT ENTRY
UNIT[api]=enclave-api-relay; ENTRY[api]=api-relay.js
UNIT[dns]=enclave-dns;       ENTRY[dns]=dns-relay.js
for r in "${ROLES[@]}"; do
  R=${r^^}; t="RELAY_${R}_TARGET"; d="RELAY_${R}_DIR"
  [ -n "${!t:-}" ] || die "role $r: $t is not set (the ssh alias from your ssh config, or user@host, of the $r host)"
  [ -n "${!d:-}" ] || die "role $r: $d is not set (the installed ${UNIT[$r]} unit's WorkingDirectory, e.g. $( [ "$r" = api ] && echo /opt/nan-relay || echo /opt/enclave-dns ))"
  [[ "${!t}" =~ $TARGET_RE ]] || die "role $r: $t must be an ssh alias or user@host (letters, digits, '.', '-'; no options, port, path or spaces)"
  [[ "${!d}" =~ $DIR_RE ]] || die "role $r: $d must be one directory directly under /opt (e.g. /opt/nan-relay)"
  TARGET[$r]=${!t}; DIR[$r]=${!d}
done
if has api && has dns && [ "${TARGET[api]}" = "${TARGET[dns]}" ] && [ "${DIR[api]}" = "${DIR[dns]}" ]; then
  die "the api and dns roles name the same directory ${DIR[api]} on ${TARGET[api]}: they are separate installs"
fi
int() { [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -ge "$3" ] && [ "$2" -le "$4" ] || die "$1 must be an integer $3..$4"; }
WAIT_LIMIT="${PREDICTION_WAIT_SEC:-600}"; int PREDICTION_WAIT_SEC "$WAIT_LIMIT" 0 3600
POLL="${PREDICTION_POLL_SEC:-5}"; int PREDICTION_POLL_SEC "$POLL" 1 60
SETTLE="${RELAY_RESTART_SETTLE_SEC:-4}"; int RELAY_RESTART_SETTLE_SEC "$SETTLE" 0 60
if [ "${1:-}" = --check-config ]; then
  for r in "${ROLES[@]}"; do echo "role $r: ${TARGET[$r]}:${DIR[$r]} (unit ${UNIT[$r]})"; done
  for r in api dns; do has "$r" || echo "role $r: not selected"; done
  exit 0
fi
ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
# Every connection: the operator's known_hosts only (no trust on first use), no prompts, bounded connect.
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }
# A copy into a role's staging directory is also recorded, with its sha256, in that role's manifest: the box verifies
# exactly what these scp lines shipped (path relative to the install directory, as the service will resolve it).
declare -A STAGE MANIFEST
scp() {
  local dest=${*: -1} r sub f
  command scp -q "${SSH_OPTS[@]}" "$@" || return
  for r in "${!STAGE[@]}"; do
    case "$dest" in "${TARGET[$r]}:${STAGE[$r]}/"*) sub=${dest#"${TARGET[$r]}:${STAGE[$r]}/"}
      for f in "${@:1:$#-1}"; do printf '%s  %s\n' "$(sha256sum < "$f" | cut -d' ' -f1)" "$sub$(basename "$f")" >> "${MANIFEST[$r]}"; done ;;
    esac
  done
}

# This branch removes the public data plane. Refuse to publish that change
# while any admitted application lacks a working replacement endpoint.
node ../network/preflight.mjs "$@"

# ---- read-only checks of every selected role, before anything is copied ----
for r in "${ROLES[@]}"; do
  ssh "${TARGET[$r]}" true || { echo "::error::role $r: ${TARGET[$r]} does not answer ssh (batch mode, strict host key): nothing was copied or restarted" >&2; exit 1; }
  # The installed unit decides where the service runs. Its directory must be the one named here: shipping to any other
  # directory would restart the old code (or the wrong service). Units are never replaced by this script.
  show=$(ssh "${TARGET[$r]}" "systemctl show ${UNIT[$r]} -p LoadState -p WorkingDirectory -p ExecStart && { test -d ${DIR[$r]} && echo DIR_PRESENT || echo DIR_ABSENT; }") \
    || { echo "::error::role $r: cannot read the ${UNIT[$r]} unit or ${DIR[$r]} on ${TARGET[$r]}: nothing was copied or restarted" >&2; exit 1; }
  grep -qx 'LoadState=loaded' <<<"$show" && grep -qx "WorkingDirectory=${DIR[$r]}" <<<"$show" && grep -q "^ExecStart=.*argv\[\]=[^;]* ${DIR[$r]}/${ENTRY[$r]} " <<<"$show" && grep -qx DIR_PRESENT <<<"$show" || {
    echo "::error::role $r: the ${UNIT[$r]} unit on ${TARGET[$r]} does not run ${DIR[$r]}/${ENTRY[$r]} from WorkingDirectory=${DIR[$r]} (found: $(grep -E '^(LoadState|WorkingDirectory)=' <<<"$show" | tr '\n' ' ')): set RELAY_${r^^}_DIR to the installed directory, or install the unit first (relay/README.md); nothing was copied or restarted" >&2
    exit 1; }
done

# A relay restart kills a running measurement prediction (isolation/m4/expected-measurement.sh, ~30 min for a big app),
# and every guest of that app release then dies at boot until it is predicted again (2026-10-14: two restarts tonight,
# eyesoff /85's guests powering down ~140 s into boot). Refuse before anything is copied; rerun when it has finished.
# WAIT for a gap first: after a relay restart the predictor works through a queue of short predictions back to back
# (2026-10-17 05:44-06:40Z: busy at every look for an hour, a fresh pin every few seconds), so a single look refused every
# deploy. Look every PREDICTION_POLL_SEC (5 s) for up to PREDICTION_WAIT_SEC (default 600, inside the CI job's timeout)
# and go at the first moment none is running. The answer must be KNOWN: pgrep's 1 is idle, 0 is running, and anything
# else (ssh failure 255, a pgrep error) refuses - an unreadable predictor is never treated as idle.
waited=0
prediction_gap() {
  [ "${ROLES[*]}" != dns ] || return 0
  while :; do
    set +e; ssh "${TARGET[api]}" 'pgrep -f "isolation/m4/[e]xpected-measurement[.]sh" >/dev/null'; rc=$?; set -e
    case "$rc" in
      1) return 0 ;;
      0) ;;
      *) echo "::error::cannot tell whether a measurement prediction is running on ${TARGET[api]} (exit $rc): not restarting the relay" >&2; return 1 ;;
    esac
    if [ "$waited" -ge "$WAIT_LIMIT" ]; then
      echo "::error::a measurement prediction has been running on ${TARGET[api]} at every look for ${WAIT_LIMIT}s: not restarting the relay now (rerun this deploy)" >&2
      return 1
    fi
    [ $((waited % 60)) -eq 0 ] && echo "a measurement prediction is running on ${TARGET[api]}; waiting for a gap (${waited}s of ${WAIT_LIMIT}s)"
    sleep "$POLL"; waited=$((waited + POLL))
  done
}
prediction_gap || exit 1

# --- secret-bearing env files: check, never touch ---------------------------
# /etc/nan-relay/*.env hold real secrets — PROVISIONER_PRIVATE_KEY is a funded
# Base key that moves USDC, alongside STRIPE_SECRET_KEY, SECRETS_KEY and
# UPLOAD_KEY. systemd reads them as root before dropping to the DynamicUser, so
# nothing needs them group- or world-readable. Nothing in this repo has ever
# checked, and a key you cannot rule out as leaked is a key you have to rotate.
# Reported, not modified: this script promises not to touch host env state, and
# a loud line the operator acts on beats a silent chmod they never see. Only
# modes and owners are read, never contents.
check_env_perms() {
  ssh "$1" 'for f in /etc/nan-relay/*.env; do [ -e "$f" ] || continue;
    m=$(stat -c %a "$f"); o=$(stat -c %U "$f");
    case "$m" in *[1-7]|*[1-7]?) echo "  !! $f is mode $m (owner $o) — readable beyond its owner; run: sudo chmod 600 $f" ;;
                 *) echo "  ok $f mode $m ($o)" ;; esac; done' || true
}
echo "== env-file permissions (secrets live here)"
for r in "${ROLES[@]}"; do echo " ${TARGET[$r]} ($r)"; check_env_perms "${TARGET[$r]}"; done

# DEPENDENCIES: `npm ci` against a SHIPPED package-lock.json, never `npm install`
# against package.json alone. Every dependency here is a caret range, so
# resolving them on the box means whatever the registry serves that morning —
# on the host that holds the Stripe webhook secret, the accounts store, the
# vault relayer key and the payment indexer. The Dockerfile and cli/install.sh
# both already say this in their own words; this path was the one that drifted.
# Install scripts stay off on the box too (the relay lockfile has none), so no
# package code runs as root beside the host's secrets.
# The bundle is built HERE, so this checkout needs the packages of both
# lockfiles (the graph uses the root's and relay/'s). CI's runner checks out
# with no node_modules at all: the first CI relay deploy after fe2067efc
# (10-08, 0af0ea4ce) died on a missing esbuild before touching the API. The
# installs use the same pinned lockfiles, with scripts off.
[ -d ../node_modules/esbuild ] || (cd .. && npm ci --no-audit --no-fund --ignore-scripts)
[ -d node_modules/viem ] || npm ci --no-audit --no-fund --ignore-scripts
node build-network.mjs

# ---- staging: every file lands in a fresh sibling directory first ----------
# <dir>.deploy-<id> receives the payload and the sha256 manifest; the box then verifies the exact file set, installs the
# locked dependencies into the staging directory and loads the network bundle there. A copy, registry or load failure
# stops here: the running service keeps serving from the untouched install directory.
STAGE_VERIFY='set -euo pipefail; cd "$1"
sha256sum -c --quiet --strict .deploy-manifest
diff <(find . -type f ! -name .deploy-manifest | sed "s|^\./||" | sort) <(awk "{print \$2}" .deploy-manifest | sort) >/dev/null || { echo "staging holds files outside the manifest" >&2; exit 1; }
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node network-runtime.bundle.mjs'
PHASE=staging
cleanup_stages() { for r in "${!STAGE[@]}"; do ssh "${TARGET[$r]}" "rm -rf ${STAGE[$r]}" || true; done; }
on_exit() { local rc=$?; rm -f "${MANIFEST[@]}"; if [ "$rc" -ne 0 ] && [ "$PHASE" = staging ]; then cleanup_stages
  echo "::error::staging failed (copy, manifest, locked dependencies or bundle load): nothing was restarted; every service keeps its running release" >&2; fi; }
trap on_exit EXIT
stage_open() {  # role -> a fresh remote staging directory and an empty local manifest
  STAGE[$1]="${DIR[$1]}.deploy-$ID"; MANIFEST[$1]=$(mktemp)
  ssh "${TARGET[$1]}" "mkdir -m 700 ${STAGE[$1]}"
}
stage_finish() {  # role -> ships the manifest, verifies the exact file set, installs locked dependencies, loads the bundle
  command scp -q "${SSH_OPTS[@]}" "${MANIFEST[$1]}" "${TARGET[$1]}:${STAGE[$1]}/.deploy-manifest"
  ssh "${TARGET[$1]}" bash -s -- "${STAGE[$1]}" <<<"$STAGE_VERIFY"
}

if has dns; then
  echo "== dns (${TARGET[dns]}:${DIR[dns]})"
  # DNS remains a control-plane service; its authorization dependencies are in the flat network bundle.
  stage_open dns; DNS_TARGET=${TARGET[dns]} DNS_STAGE=${STAGE[dns]}
scp dns-relay.js fleet.mjs net-guard.mjs fleet-auth.js boxhost.js network-runtime.bundle.mjs network-runtime.bundle.mjs.manifest.json package.json package-lock.json "$DNS_TARGET":"$DNS_STAGE"/
  stage_finish dns
fi

if has api; then
  echo "== api relay (${TARGET[api]}:${DIR[api]})"
  stage_open api; API_TARGET=${TARGET[api]} API_STAGE=${STAGE[api]}
  ssh "$API_TARGET" "mkdir ${API_STAGE}/vendor ${API_STAGE}/fixtures"
scp network-runtime.bundle.mjs network-runtime.bundle.mjs.manifest.json "$API_TARGET":"$API_STAGE"/
  # api-relay.js imports ./fleet.mjs (shared discovery: registry read + TRUSTED_OPERATORS
  # filter + on-chain runner routing), ./net-guard.mjs (SSRF classifier for discovered
  # origins), ./tunnel.js (fleet tunnel for CGNAT self-hosted enclaves) AND ./mcp.js
  # (the MCP coding-agent endpoint, mcp.enclave.host); fleet.mjs imports ./net-guard.mjs
  # too. ALL of them MUST ship alongside or the service crash-loops with ERR_MODULE_NOT_FOUND.
  # auth/billing modules (account sessions, orders, Stripe webhook, PaymentRouter
  # indexer, OFAC screen, provisioner) ship alongside; they self-disable without
  # StateDirectory/env, so shipping them is always safe. npm ci installs
  # their deps (@simplewebauthn/server, jose) from the SHIPPED lockfile.
  # A hand-maintained file list can miss modules while still passing scp
  # (test/relay-deploy-closure.test.mjs walks the import graph of every line below).
scp api-relay.js lease-generation.mjs registry-liveness.mjs host-liveness.mjs host-capacity-record.mjs canonical.mjs guest-prediction-row.mjs mcp.js auth.js sso.js billing.js indexer.js ofac.js provisioner.js vaultsvc.js secrets.js secrets-release.mjs custody-state.mjs measurement-predict.mjs host-delegation.mjs fleet-auth.js certs.js domains.js store.js fleet.mjs net-guard.mjs tunnel.js pvm-cpu-tier.mjs pvm-market.mjs pvm-secrets.mjs pvm-app-attest.mjs pvm-evidence-core.mjs snp-verify.mjs avf-verify.mjs avf-policy.mjs avf-binding.mjs vbs-verify.mjs vbs-policy.mjs vbs-credential.mjs vbs-tcglog.mjs vbs-tcglog-core.mjs vbs-tpm.mjs hvnode-verify.mjs hvnode-core.mjs vbs-app-verify.mjs vbs-vm-report.mjs vbs-runtime.mjs shield-app-policy.mjs shield-app-verifier.mjs shield-marketplace.mjs shield-market-evidence.mjs shield-app-fresh.mjs snp-app-fresh.mjs pvm-app-fresh.mjs shield-derive.mjs pads.mjs host-sponsor.mjs host-names.mjs referrals.mjs route-grace.mjs pad-grant.mjs pad-state.mjs pad-shipment-store.mjs pad-ack.mjs boxhost.js package.json package-lock.json shield-secrets.mjs placement.mjs cheapest-claim.mjs contract-owner-signature.mjs sessions.mjs sessions-abi.mjs vbs-app-core.mjs vbs-vm-report-core.mjs "$API_TARGET":"$API_STAGE"/
  # hvnode-verify.mjs is the NucBox node's attach (tunnel mode hv-node), built on the vbs-*.mjs TPM
  # and measured-boot primitives (the VBS-enclave attach itself is retired). api-relay.js reads the
  # pinned AMD fTPM roots from ./fixtures/tpm-roots.pem (vbs-policy.mjs VBS_DEFAULT_EK_ROOTS) at
  # startup when RELAY_HVNODE_ATTACH is set, so the bundle ships with the modules.
  # the repository's own verifier, vendored for the relay (the release-document judgement loads it; verifier/node/build.mjs writes it)
scp vendor/enclave-verifier-node.mjs vendor/enclave-verifier-node.MANIFEST.json "$API_TARGET":"$API_STAGE"/vendor/
scp fixtures/tpm-roots.pem "$API_TARGET":"$API_STAGE"/fixtures/
  stage_finish api
fi
PHASE=apply

# ---- apply: replace exactly the shipped files, restart, roll back on failure
# One role at a time, under a lock beside the install directory. Every file named in the manifest (and node_modules) is
# saved to <dir>.rollback-<id> first; files the manifest does not name stay as they are. If the unit is not active after
# the restart, the saved files return, files new in this release are removed, the old service is restarted, and the
# deploy fails. The previous release's rollback directory is kept until the next successful deploy.
APPLY='set -euo pipefail; dir=$1 stage=$2 unit=$3 id=$4 settle=$5 back="$1.rollback-$4"
exec 9>"$dir.deploy.lock"; flock -n 9 || { echo "another deploy holds $dir.deploy.lock" >&2; exit 1; }
mkdir -m 700 "$back"; : > "$back/.new"
while read -r _ f; do
  if [ -e "$dir/$f" ]; then mkdir -p "$back/$(dirname "$f")"; cp -a "$dir/$f" "$back/$f"; else echo "$f" >> "$back/.new"; fi
done < "$stage/.deploy-manifest"
[ ! -e "$dir/node_modules" ] || mv "$dir/node_modules" "$back/node_modules"
restore() {
  while read -r _ f; do if grep -qxF "$f" "$back/.new"; then rm -f "$dir/$f"; elif [ -e "$back/$f" ]; then cp -a "$back/$f" "$dir/$f"; fi; done < "$stage/.deploy-manifest"
  rm -rf "$dir/node_modules"; [ ! -e "$back/node_modules" ] || mv "$back/node_modules" "$dir/node_modules"
}
while read -r _ f; do mkdir -p "$dir/$(dirname "$f")"; cp "$stage/$f" "$dir/$f.deploy-tmp"; mv -f "$dir/$f.deploy-tmp" "$dir/$f"; done < "$stage/.deploy-manifest"
mv "$stage/node_modules" "$dir/node_modules"
if systemctl restart "$unit" && sleep "$settle" && systemctl is-active --quiet "$unit"; then
  echo "$unit: active"
  for old in "$dir".rollback-*; do [ "$old" = "$back" ] || rm -rf "$old"; done
  rm -rf "$stage"; exit 0
fi
echo "$unit FAILED to stay up after restart (crash loop?) — last logs:"; journalctl -u "$unit" -n 25 --no-pager || true
restore; systemctl restart "$unit" || true; sleep "$settle"
if systemctl is-active --quiet "$unit"; then echo "$unit: previous release restored and active"; else echo "$unit: previous release restored but NOT active"; fi
rm -rf "$stage"; exit 1'
apply() {  # role
  ssh "${TARGET[$1]}" bash -s -- "${DIR[$1]}" "${STAGE[$1]}" "${UNIT[$1]}" "$ID" "$SETTLE" <<<"$APPLY" || {
    echo "::error::role $1: ${UNIT[$1]} on ${TARGET[$1]} did not stay up; its previous release was restored" >&2; return 1; }
}
if has dns; then apply dns || { cleanup_stages; exit 1; }; fi
if has api; then
  # the copy and install took time: look again (same budget) right before the restart that would kill a prediction
  prediction_gap || { cleanup_stages; echo "::error::role api: not restarted; the staged release was removed" >&2; exit 1; }
  apply api || exit 1
fi
PHASE=done
for r in api dns; do has "$r" || echo "note: the $r role was not selected (RELAY_DEPLOY_ROLES=$RELAY_DEPLOY_ROLES): it was not deployed"; done
echo "deployed: ${ROLES[*]}"
