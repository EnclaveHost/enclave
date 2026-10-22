#!/bin/bash
# The source patch (a/ = work/enclave, b/ = tree) and its hash inventory. File operations only.
set -euo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); S="$H/../enclave"; T="$H/tree"
FILES="network/host-service-names.mjs network/host-service-ingress.mjs network/host-service-transport.mjs
network/wg-provider/provider.mjs network/wg-provider/kernel.mjs network/wg-provider/control.mjs network/wg-provider/main.mjs network/wg-provider/host-services-config.mjs network/wg-provider/dns-probe.mjs network/wg-provider/install.sh
network/wg-circuit-runtime.mjs network/wg-control.mjs network/wg-grants.mjs network/enclave-network-host.mjs network/privacy-agent.mjs network/build.mjs
network/wg/forward.go network/wg/udpforward.go network/wg/udpforward_test.go network/wg/cmd/enclave-wg/main.go
network/host-services/roles.mjs network/host-services/stage-tool.mjs relay/dns-relay.js scripts/check-transport-profile.mjs windows/node/network-enroll.mjs windows/installer/stage-bundle.sh
test/wg-provider-host-services.test.mjs test/wg-provider-dns-kernel.test.mjs test/host-service-ingress.test.mjs test/host-service-transport.test.mjs test/host-service-dns-publication.test.mjs test/host-service-cold-bootstrap.test.mjs test/host-service-replica-peers.test.mjs test/privacy-agent-host-services-start.test.mjs test/route-dns-transport-rate.test.mjs
test/netns/host-service-e2e.sh test/netns/hs-provider-node.mjs test/netns/hs-host-node.mjs"
out="$H/patch/host-service-transport.patch"; : > "$out"; inv="$H/patch/HASHES.txt"
{ echo "# path  base-sha256 (work/enclave; - = new file)  new-sha256 (tree)"; } > "$inv"
for f in $FILES; do
  b="$S/$f"; n="$T/$f"
  if [ -e "$b" ]; then bs=$(sha256sum "$b" | cut -d' ' -f1); (cd "$H/.." && diff -u --label "a/$f" --label "b/$f" "enclave/$f" "host-service-transport-20261021/tree/$f" >> "$out") || true
  else bs=-; (cd "$H/.." && diff -u --label /dev/null --label "b/$f" /dev/null "host-service-transport-20261021/tree/$f" >> "$out") || true; fi
  echo "$f  $bs  $(sha256sum "$n" | cut -d' ' -f1)" >> "$inv"
done
echo "patch/host-service-transport.patch  $(sha256sum "$out" | cut -d' ' -f1)  ($(grep -c '^+++ ' "$out") files)" >> "$inv"
for b in enclave-wg enclave-wg.exe wg-udp-test.exe; do [ -e "$H/probe/bin/$b" ] && echo "probe/bin/$b (amd64, CGO 0, -trimpath, tree source)  $(sha256sum "$H/probe/bin/$b" | cut -d' ' -f1)" >> "$inv"; done
cat "$inv"
