#!/usr/bin/env bash
# Candidate non-DO provider on warden-host, CONFIG ONLY, into a STAGING root (ENCLAVE_NETWORK_ROOT): bundle wg-provider from
# canonical source (read-only) with network/build.mjs's options, run the EXISTING install.sh --config-only (it writes
# provider.json and validates it with the release's --check-config; no package, firewall, sysctl or service). The staging
# operator key is a throwaway made by install.sh: it is shredded at the end and never printed.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; E=$W/enclave; D=$W/non-do-ingress-20261021/provider-candidate
REL=$D/release; ST=$D/staging; rm -rf "$REL" "$ST"; mkdir -p "$REL" "$ST"
cd "$E" && node --input-type=module -e "
import {build} from 'esbuild';
await build({entryPoints:['network/wg-provider/main.mjs'], outfile:'$REL/wg-provider.mjs', bundle:true, platform:'node', format:'esm', target:'node22',
  banner:{js:'import {createRequire as bundleRequire} from \"node:module\"; const require=bundleRequire(import.meta.url);'}});"
cp "$E/network/wg-provider/install.sh" "$REL/install.sh"
cp "$W/../outputs/network-authority-release/authority-pins.json" "$D/authority-pins.json"
sha256sum "$REL/wg-provider.mjs" "$REL/install.sh" "$D/authority-pins.json"
cd "$REL"
ENCLAVE_NETWORK_ROOT="$ST" bash install.sh candidate warden-site \
  --checkers 0x57144c9008cff0b3ed94f6e40964a321fbee848a,0x033bc2b92bb1bb97c7dadf2879d3048748e2257b \
  --rpc https://mainnet.base.org --rpc https://base-rpc.publicnode.com --rpc https://base.drpc.org \
  --directory http://134.199.235.187:8188 --directory http://134.209.248.172:8188 --directory http://146.190.246.39:8188 --directory http://165.245.191.129:8188 \
  --pins "$D/authority-pins.json" --zone app.enclave.host --probe-zone probe.enclave.host \
  --public-address 4.15.13.178 --uplink enp162s0u1u3 --roles guard,ingress,egress --config-only
CFG="$ST/etc/enclave-network/provider.json"
python3 -c "
import json; c=json.load(open('$CFG')); c['operatorKeyFile']='<staging throwaway, removed>'; c['stateDir']='<staging>'
print(json.dumps(c, indent=1))" > "$D/provider.candidate.json"
node "$REL/wg-provider.mjs" --check-config "$CFG" && echo "CHECK-CONFIG OK"
shred -u "$ST/etc/enclave-network/operator.key"; rm -rf "$ST"
sha256sum "$D/provider.candidate.json"
