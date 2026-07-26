#!/usr/bin/env bash
# deploy.sh - push the relay daemons + systemd units to their boxes and
# restart them. Paths are relative to relay/ however this script is invoked.
#
# TWO hosts (ssh aliases; Host blocks in ~/.ssh/config, CI writes equivalents):
#   nan-relay - the TCP (SNI) + UDP relays. relay.js binds the whole 1-19999
#               public port range there, so the API relay CANNOT share this
#               box (its port 8100 sits inside that range).
#   nan       - the API relay (api.enclave.host: the box's Caddy fronts :8100).
#
# Host layout (see README): /opt/nan-relay/ holds the daemons and their
# node_modules; units live in /etc/systemd/system; env files under
# /etc/nan-relay/ are host state and are NOT touched here.
set -euo pipefail
cd "$(dirname "$0")"

# DEPENDENCIES: `npm ci` against a SHIPPED package-lock.json, never `npm install`
# against package.json alone. Every dependency here is a caret range, so
# resolving them on the box means whatever the registry serves that morning —
# on the host that holds the Stripe webhook secret, the accounts store, the
# vault relayer key and the payment indexer. The Dockerfile and cli/install.sh
# both already say this in their own words; this path was the one that drifted.
# A registry failure aborts before any restart (set -e, && chaining): the
# running processes keep serving from their already-loaded module graph, and
# the next deploy repairs the tree.
echo "== nan-relay: tcp (SNI) + tcp6 (dedicated-IP) + udp + egress relays"
# net-guard.mjs is a symlink to ../net-guard.mjs (the canonical SSRF classifier
# shared with the enclave's egress.js); scp follows it and ships the content.
# fleet.mjs is the shared fleet discovery (REGISTRY_ADDRESS / ENCLAVES) the
# tcp6/udp/egress relays use to follow an arbitrary, changing set of enclaves.
scp relay.js tcp6-relay.js udp-relay.js egress-relay.js dns-relay.js fleet.mjs net-guard.mjs package.json package-lock.json nan-relay:/opt/nan-relay/
scp systemd/enclave-tcp-relay.service systemd/enclave-tcp6-relay.service systemd/enclave-udp-relay.service systemd/enclave-egress-relay.service systemd/enclave-dns.service nan-relay:/etc/systemd/system/
# The egress relay only runs once /etc/nan-relay/egress-relay.env exists
# (REGISTRY_ADDRESS or ENCLAVES + EGRESS_RELAY_TOKEN + EGRESS_PREFIX=<same
# /64>). Until then its restart is a no-op failure; enable it explicitly when
# the operator adds the env.
# One-time migration from the pre-rename nan-* unit names: the old unit must
# be gone before the enclave-* one starts, or the two race for the same ports.
ssh nan-relay 'for u in nan-tcp-relay nan-tcp6-relay nan-udp-relay nan-egress-relay; do \
    if [ -f /etc/systemd/system/$u.service ]; then \
      systemctl disable --now $u || true; rm /etc/systemd/system/$u.service; fi; done \
  && cd /opt/nan-relay && npm ci --omit=dev --no-audit --no-fund \
  && systemctl daemon-reload \
  && systemctl enable enclave-tcp-relay enclave-tcp6-relay enclave-udp-relay \
  && systemctl restart enclave-tcp-relay enclave-tcp6-relay enclave-udp-relay \
  && sleep 4 \
  && if systemctl is-active --quiet enclave-tcp-relay enclave-tcp6-relay enclave-udp-relay; then echo "tcp/tcp6/udp relays: active"; \
     else echo "a data-plane relay FAILED to stay up after restart (crash loop?):"; \
          systemctl is-active enclave-tcp-relay enclave-tcp6-relay enclave-udp-relay || true; \
          journalctl -u enclave-tcp-relay -u enclave-tcp6-relay -u enclave-udp-relay -n 25 --no-pager; exit 1; fi \
  && if [ -f /etc/nan-relay/egress-relay.env ]; then \
       systemctl enable --now enclave-egress-relay && systemctl restart enclave-egress-relay \
       && systemctl is-active enclave-egress-relay; \
     else echo "enclave-egress-relay: no /etc/nan-relay/egress-relay.env yet — skipped"; fi \
  && if [ -f /etc/nan-relay/dns.env ]; then \
       systemctl enable --now enclave-dns && systemctl restart enclave-dns \
       && systemctl is-active enclave-dns; \
     else echo "enclave-dns: no /etc/nan-relay/dns.env yet — skipped (authoritative DNS for app./ip. zones)"; fi'

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
check_env_perms nan-relay
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
scp api-relay.js mcp.js auth.js billing.js indexer.js ofac.js provisioner.js vaultsvc.js secrets.js store.js fleet.mjs net-guard.mjs tunnel.js snp-verify.mjs package.json package-lock.json nan:/opt/nan-relay/
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
