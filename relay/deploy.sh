#!/usr/bin/env bash
# Deploy Nan's control API and authoritative DNS. Host TUNA adapters are
# deployed separately. Keep /etc/nan-relay/*.env as host-owned state.
set -euo pipefail
cd "$(dirname "$0")"

# This branch removes the public data plane. Refuse to publish that change
# while any admitted application lacks a working replacement endpoint.
node ../network/preflight.mjs "$@"

# DEPENDENCIES: `npm ci` against a SHIPPED package-lock.json, never `npm install`
# against package.json alone. Every dependency here is a caret range, so
# resolving them on the box means whatever the registry serves that morning —
# on the host that holds the Stripe webhook secret, the accounts store, the
# vault relayer key and the payment indexer. The Dockerfile and cli/install.sh
# both already say this in their own words; this path was the one that drifted.
# A registry failure aborts before any restart (set -e, && chaining): the
# running processes keep serving from their already-loaded module graph, and
# the next deploy repairs the tree.
# DNS remains a control-plane service. TUNA providers and host adapters have
# separate deployments; this script never starts retired Enclave data relays.
DNS_HOST="${DNS_HOST:-nan-relay}"
scp dns-relay.js fleet.mjs net-guard.mjs fleet-auth.js boxhost.js package.json package-lock.json "$DNS_HOST":/opt/nan-relay/
scp systemd/enclave-dns.service "$DNS_HOST":/etc/systemd/system/
ssh "$DNS_HOST" 'cd /opt/nan-relay && npm ci --omit=dev --no-audit --no-fund && systemctl daemon-reload && systemctl restart enclave-dns && systemctl is-active enclave-dns'

# --- secret-bearing env files: check, never touch ---------------------------
# /etc/nan-relay/*.env hold real secrets — PROVISIONER_PRIVATE_KEY is a funded
# Base key that moves USDC, alongside STRIPE_SECRET_KEY, SECRETS_KEY and
# UPLOAD_KEY. systemd reads them as root before dropping to the DynamicUser, so
# nothing needs them group- or world-readable. Nothing in this repo has ever
# checked, and a key you cannot rule out as leaked is a key you have to rotate.
# Reported, not modified: this script promises not to touch host env state, and
# a loud line the operator acts on beats a silent chmod they never see.
check_env_perms() {
  ssh "$1" 'for f in /etc/nan-relay/*.env; do [ -e "$f" ] || continue;
    m=$(stat -c %a "$f"); o=$(stat -c %U "$f");
    case "$m" in *[1-7]|*[1-7]?) echo "  !! $f is mode $m (owner $o) — readable beyond its owner; run: sudo chmod 600 $f" ;;
                 *) echo "  ok $f mode $m ($o)" ;; esac; done' || true
}
echo "== env-file permissions (secrets live here)"
check_env_perms "$DNS_HOST"
check_env_perms nan

echo "== api relay (site box)"
# api-relay.js imports ./fleet.mjs (shared discovery: registry read + TRUSTED_OPERATORS
# filter + on-chain runner routing), ./net-guard.mjs (SSRF classifier for discovered
# origins), ./tunnel.js (fleet tunnel for CGNAT self-hosted enclaves) AND ./mcp.js
# (the MCP coding-agent endpoint, mcp.enclave.host); fleet.mjs imports ./net-guard.mjs
# too. ALL of them MUST ship alongside or the service crash-loops with ERR_MODULE_NOT_FOUND.
# auth/billing modules (account sessions, orders, Stripe webhook, PaymentRouter
# indexer, OFAC screen, provisioner) ship alongside; they self-disable without
# StateDirectory/env, so shipping them is always safe. npm ci below installs
# their deps (@simplewebauthn/server, jose) from the SHIPPED lockfile.
# Build the entire import graph; a hand-maintained file list can miss modules
# while still passing scp, leaving the API unable to start after a restart.
# The bundle is built HERE, so this checkout needs the packages of both
# lockfiles (the graph uses the root's and relay/'s). CI's runner checks out
# with no node_modules at all: the first CI relay deploy after fe2067efc
# (10-08, 0af0ea4ce) died on a missing esbuild before touching the API. The
# installs use the same pinned lockfiles, with scripts off.
[ -d ../node_modules/esbuild ] || (cd .. && npm ci --no-audit --no-fund --ignore-scripts)
[ -d node_modules/viem ] || npm ci --no-audit --no-fund --ignore-scripts
node build-network.mjs
scp network-runtime.bundle.mjs network-runtime.bundle.mjs.manifest.json nan:/opt/nan-relay/
ssh nan 'node /opt/nan-relay/network-runtime.bundle.mjs'
scp api-relay.js guest-prediction-row.mjs mcp.js auth.js sso.js billing.js indexer.js ofac.js provisioner.js vaultsvc.js secrets.js secrets-release.mjs measurement-predict.mjs host-delegation.mjs fleet-auth.js certs.js domains.js store.js fleet.mjs net-guard.mjs tunnel.js pvm-cpu-tier.mjs pvm-market.mjs pvm-app-attest.mjs snp-verify.mjs reverify.mjs avf-verify.mjs avf-policy.mjs avf-binding.mjs vbs-verify.mjs vbs-policy.mjs vbs-credential.mjs vbs-tcglog.mjs hvnode-verify.mjs vbs-app-verify.mjs vbs-vm-report.mjs vbs-runtime.mjs shield-app-policy.mjs shield-app-verifier.mjs shield-marketplace.mjs shield-derive.mjs pads.mjs pad-grant.mjs pad-state.mjs pad-shipment-store.mjs pad-ack.mjs boxhost.js package.json package-lock.json shield-secrets.mjs placement.mjs cheapest-claim.mjs contract-owner-signature.mjs sessions.mjs sessions-abi.mjs nan:/opt/nan-relay/
# hvnode-verify.mjs is the NucBox node's attach (tunnel mode hv-node), built on the vbs-*.mjs TPM
# and measured-boot primitives (the VBS-enclave attach itself is retired). api-relay.js reads the
# pinned AMD fTPM roots from ./fixtures/tpm-roots.pem (vbs-policy.mjs VBS_DEFAULT_EK_ROOTS) at
# startup when RELAY_HVNODE_ATTACH is set, so the bundle ships with the modules.
ssh nan 'mkdir -p /opt/nan-relay/fixtures'
# the repository's own verifier, vendored for the relay (relay/reverify.mjs loads it; verifier/node/build.mjs writes it)
ssh nan 'mkdir -p /opt/nan-relay/vendor'
scp vendor/enclave-verifier-node.mjs vendor/enclave-verifier-node.MANIFEST.json nan:/opt/nan-relay/vendor/
scp fixtures/tpm-roots.pem nan:/opt/nan-relay/fixtures/
scp systemd/enclave-api-relay.service nan:/etc/systemd/system/
ssh nan 'if [ -f /etc/systemd/system/nan-api-relay.service ]; then \
    systemctl disable --now nan-api-relay || true; rm /etc/systemd/system/nan-api-relay.service; fi \
  && cd /opt/nan-relay && npm ci --omit=dev --no-audit --no-fund \
  && systemctl daemon-reload \
  && systemctl enable enclave-api-relay \
  && systemctl restart enclave-api-relay \
  && sleep 4 \
  && if systemctl is-active --quiet enclave-api-relay; then echo "enclave-api-relay: active"; \
     else echo "enclave-api-relay FAILED to stay up after restart (crash loop?) — last logs:"; \
          journalctl -u enclave-api-relay -n 25 --no-pager; exit 1; fi'
