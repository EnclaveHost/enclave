#!/bin/sh
# Regenerate patches/offchain-heartbeat.patch: base/layer0/ (current work/enclave + the three UNMODIFIED host-capacity
# producer patches in patches/prereq/, applied in the order supervisor, dockerfile, windows-agent) -> tree/.
set -e
# network/host-liveness.mjs is NOT added here: current work/enclave already carries it (untracked), byte-identical to this candidate.
W=$(cd "$(dirname "$0")" && pwd); T=$W/tree; B=$W/base/layer0; OUT=$W/patches/offchain-heartbeat.patch
: > "$OUT"
m() { diff -u --label "a/$1" --label "b/$1" "$B/$1" "$T/$1" >> "$OUT" || true; }
a() { diff -u --label /dev/null --label "b/$1" /dev/null "$T/$1" >> "$OUT" || true; }
for f in supervisor.js windows/node/host.mjs windows/node/chain.mjs windows/node/keys.mjs windows/node/gas-runway.mjs \
         network/host-capacity-http.mjs cli/independent.mjs cli/enclave.mjs cli/host-independent-lifecycle.mjs \
         relay/api-relay.js relay/fleet.mjs relay/deploy.sh relay/mcp.js scripts/enclave-discover.mjs \
         contracts/README.md docs/network/independent-capacity.md docs/network/independent-cli.md docs/network/independent-host-onboarding.md \
         metal/PROTOCOL.md metal/config.example.json docs/billing-runbook.md isolation/DEPLOYMENT-PATH.md \
         test/registry-advertise-retry.test.mjs test/registry-schema.test.mjs test/windows-node-sponsor-retry.test.mjs \
         Dockerfile network/host-capacity-producer.mjs test/relay-hvnode-owner-only.test.mjs; do m "$f"; done
for f in relay/host-liveness.mjs relay/canonical.mjs relay/host-capacity-record.mjs relay/registry-liveness.mjs \
         docs/network/host-liveness.md test/host-liveness.test.mjs test/offchain-heartbeat-writers.test.mjs test/helpers/resolve-example-org.mjs \
         network/registry-reconcile.mjs test/registry-reconcile.test.mjs test/cli-signed-liveness.test.mjs; do a "$f"; done
sha256sum "$OUT" patches/prereq/*.patch | sed "s#$W/##"
