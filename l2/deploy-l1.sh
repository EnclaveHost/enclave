#!/usr/bin/env bash
# deploy-l1.sh - deploy the Enclave L2's L1 contracts with op-deployer, then
# turn on permissionless (SUPER_CANNON_KONA) fault proofs. Testnet tooling:
# it refuses any L1 other than Sepolia.
#
# Why it is staged this way (each found on a Sepolia fork, 2026-11-03):
#  - Sepolia's OPCM (8.0.1) has SUPER_ROOT_GAMES_MIGRATION on, so the only
#    initial games it accepts are SUPER_PERMISSIONED (5) and SUPER_CANNON_KONA (9).
#  - An initial permissionless deploy runs OP's StandardValidator, which
#    rejects any non-OP L1 ProxyAdmin owner, challenger or SuperchainConfig.
#    Enclave keeps its own authorities, so it deploys with game 5 and adds
#    game 9 afterwards through opcm.upgrade.
#  - opcm.upgrade must be DELEGATECALLed by the L1 ProxyAdmin owner, so that
#    owner is a Safe (l2/safe.mjs), not an EOA.
#  - The kona-client prestate embeds the final rollup config, so it can only
#    be built after prepare has fixed the genesis and addresses.
#
# Every stage writes a marker under $WORK/stages and is skipped on re-run.
#
# Env: L1_RPC (Sepolia execution RPC), KEYS (dir of <role>.key/<role>.addr),
#      WORK (output dir), OP_DEPLOYER (binary), MONOREPO (optimism checkout at
#      the kona-client tag the challenger bundles), L2_CHAIN_ID,
#      GENESIS_OFFSET (s, default 600), INIT_BOND_WEI (default 1e15), SAFE_SALT (default L2_CHAIN_ID).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${L1_RPC:?}" "${KEYS:?}" "${WORK:?}" "${OP_DEPLOYER:?}" "${MONOREPO:?}" "${L2_CHAIN_ID:?}"
GENESIS_OFFSET=${GENESIS_OFFSET:-600}
INIT_BOND_WEI=${INIT_BOND_WEI:-1000000000000000}
OPCM=${OPCM:-0x6abfabbc793883add5fa308a97163e8225a9f4ca}

[ "$(cast chain-id --rpc-url "$L1_RPC")" = 11155111 ] || { echo "deploy-l1: L1 is not Sepolia; refusing" >&2; exit 1; }
mkdir -p "$WORK/stages"; cd "$WORK"
addr() { cat "$KEYS/$1.addr"; }
done_() { touch "stages/$1"; echo "== stage $1 done"; }
have() { [ -e "stages/$1" ]; }
cache=(--cache-dir "$WORK/op-deployer-cache")
log() { echo "[$(date -u +%FT%TZ)] $*"; }
balance() { cast balance "$(addr deployer)" --rpc-url "$L1_RPC"; }
echo "deployer $(addr deployer) balance $(balance) wei at start" | tee -a costs.log

if ! have safe; then
  log "creating the 1-of-1 Safe that owns the L1 ProxyAdmins (admin key stands in for the Trezor)"
  node "$here/safe.mjs" create --rpc "$L1_RPC" --key "$KEYS/admin.key" --salt "${SAFE_SALT:-$L2_CHAIN_ID}" > safe.json
  cat safe.json; done_ safe
fi
SAFE=$(jq -r .safe safe.json)

if ! have superchain; then
  log "bootstrapping an Enclave-owned SuperchainConfig (guardian = admin; OP's Sepolia guardian has no power here)"
  DEPLOYER_PRIVATE_KEY=$(cat "$KEYS/deployer.key") "$OP_DEPLOYER" "${cache[@]}" bootstrap superchain \
    --l1-rpc-url "$L1_RPC" --superchain-proxy-admin-owner "$SAFE" --guardian "$(addr admin)" --no-verify \
    --outfile superchain.json > superchain.log 2>&1
  cat superchain.json; done_ superchain
fi

if ! have intent; then
  "$OP_DEPLOYER" init --l1-chain-id 11155111 --l2-chain-ids "$L2_CHAIN_ID" --workdir .deployer --intent-type standard-overrides
  python3 - "$SAFE" "$(addr admin)" "$(addr sequencer)" "$(addr batcher)" "$(addr proposer)" "$(addr challenger)" \
            "$(jq -r .superchainConfigProxyAddress superchain.json)" <<'EOF'
import sys, re
safe, admin, seq, bat, prop, chal, scfg = sys.argv[1:]
p = '.deployer/intent.toml'; s = open(p).read()
sets = {k: admin for k in ['baseFeeVaultRecipient', 'l1FeeVaultRecipient', 'sequencerFeeVaultRecipient',
                           'operatorFeeVaultRecipient', 'l2ProxyAdminOwner', 'systemConfigOwner']}
sets.update(l1ProxyAdminOwner=safe, unsafeBlockSigner=seq, batcher=bat, proposer=prop, challenger=chal)
for k, v in sets.items():
    s, n = re.subn(rf'(\b{k} = )"0x[0-9a-fA-F]+"', rf'\1"{v}"', s)
    assert n == 1, k
s = s.replace('useInterop = false', f'useInterop = false\nsuperchainConfigProxy = "{scfg}"', 1)
s += '\n  [chains.deployOverrides]\n    respectedGameType = 5\n'
open(p, 'w').write(s)
EOF
  cat .deployer/intent.toml; done_ intent
fi

if ! have prepare; then
  DEPLOYER_PRIVATE_KEY=$(cat "$KEYS/deployer.key") "$OP_DEPLOYER" "${cache[@]}" prepare --workdir .deployer \
    --l1-rpc-url "$L1_RPC" --genesis-time-offset "$GENESIS_OFFSET" > prepare.log 2>&1
  "$OP_DEPLOYER" prestate --workdir .deployer > prestate-permissioned.log 2>&1
  done_ prepare
fi

if ! have continue; then
  log "broadcasting OPCM.deploy"
  DEPLOYER_PRIVATE_KEY=$(cat "$KEYS/deployer.key") "$OP_DEPLOYER" "${cache[@]}" continue --workdir .deployer \
    --l1-rpc-url "$L1_RPC" > continue.log 2>&1
  grep -E 'transaction confirmed' continue.log | tail -3
  "$OP_DEPLOYER" inspect rollup --workdir .deployer "$L2_CHAIN_ID" > rollup.json
  "$OP_DEPLOYER" inspect genesis --workdir .deployer "$L2_CHAIN_ID" > genesis.json
  jq '.opChainDeployments[0] | del(.allocs)' .deployer/state.json > chain-addresses.json
  done_ continue
fi

if ! have prestate-build; then
  log "building the reproducible kona-client prestate with this chain's rollup config embedded"
  node "$here/kona-custom-configs.mjs" --rollup rollup.json --out kona-configs --proxy-admin-owner "$SAFE"
  rm -rf prestate-out
  start=$(date +%s)
  docker build --platform linux/amd64 --target export-stage --build-arg KONA_CUSTOM_CONFIGS=true \
    --build-context kona-custom-configs="$WORK/kona-configs" --output "$WORK/prestate-out" --progress plain \
    -f "$MONOREPO/rust/kona/docker/fpvm-prestates/cannon-repro.dockerfile" "$MONOREPO" > prestate-build.log 2>&1
  echo "prestate build seconds: $(( $(date +%s) - start ))" | tee -a prestate-build.log
  grep -q 'merging custom chains' prestate-build.log || { echo "deploy-l1: build did not merge the custom chain" >&2; exit 1; }
  jq -r .pre prestate-out/prestate-artifacts-cannon-interop/prestate-proof.json > prestate-super.txt
  cat prestate-super.txt; done_ prestate-build
fi
PRESTATE=$(cat prestate-super.txt)

SC=$(jq -r .SystemConfigProxy chain-addresses.json)
ASR=$(jq -r .AnchorStateRegistryProxy chain-addresses.json)
DGF=$(jq -r .DisputeGameFactoryProxy chain-addresses.json)
if ! have add-game; then
  # OPCM v2 wants one config per valid game type, in its fixed order:
  # CANNON, PERMISSIONED_CANNON, CANNON_KONA, SUPER_PERMISSIONED, SUPER_CANNON_KONA, ZK.
  # SUPER_PERMISSIONED stays enabled (bond 0) as the guardian's fallback.
  jq -n --arg prank "$SAFE" --arg opcm "$OPCM" --arg sc "$SC" --arg pre "$PRESTATE" --arg prop "$(addr proposer)" \
        --argjson bond "$INIT_BOND_WEI" \
    '{prank:$prank, opcm:$opcm, upgradeInput:{systemConfig:$sc, extraInstructions:[], disputeGameConfigs:[
       {enabled:false, initBond:0, gameType:0}, {enabled:false, initBond:0, gameType:1}, {enabled:false, initBond:0, gameType:8},
       {enabled:true, initBond:0, gameType:5, superPermissionedDisputeGameConfig:{proposer:$prop}},
       {enabled:true, initBond:$bond, gameType:9, faultDisputeGameConfig:{absolutePrestate:$pre}},
       {enabled:false, initBond:0, gameType:10}]}}' > add-game.json
  "$OP_DEPLOYER" manage add-game-type-v2 --l1-rpc-url "$L1_RPC" --config add-game.json "${cache[@]}" \
    --outfile add-game-calldata.json > add-game.log 2>&1
  [ "$(jq -r '.[0].to' add-game-calldata.json | tr A-Z a-z)" = "$(echo "$SAFE" | tr A-Z a-z)" ] || { echo "deploy-l1: unexpected calldata target" >&2; exit 1; }
  node "$here/safe.mjs" exec --rpc "$L1_RPC" --key "$KEYS/admin.key" --safe "$SAFE" --to "$OPCM" \
    --data "$(jq -r '.[0].data' add-game-calldata.json)" --delegatecall > add-game-exec.json
  cat add-game-exec.json; done_ add-game
fi

if ! have respected; then
  cast send "$ASR" 'setRespectedGameType(uint32)' 9 --private-key "$(cat "$KEYS/admin.key")" --rpc-url "$L1_RPC" --json \
    | jq '{transactionHash, gasUsed, status}' > respected.json
  cat respected.json; done_ respected
fi

jq -n --arg safe "$SAFE" --arg asr "$ASR" --arg dgf "$DGF" --arg pre "$PRESTATE" \
  --arg respected "$(cast call "$ASR" 'respectedGameType()(uint32)' --rpc-url "$L1_RPC")" \
  --arg g5 "$(cast call "$DGF" 'gameImpls(uint32)(address)' 5 --rpc-url "$L1_RPC")" \
  --arg g9 "$(cast call "$DGF" 'gameImpls(uint32)(address)' 9 --rpc-url "$L1_RPC")" \
  --arg bond9 "$(cast call "$DGF" 'initBonds(uint32)(uint256)' 9 --rpc-url "$L1_RPC" | cut -d' ' -f1)" \
  --arg owner "$(cast call "$(jq -r .OpChainProxyAdminImpl chain-addresses.json)" 'owner()(address)' --rpc-url "$L1_RPC")" \
  '{l1ProxyAdminOwnerSafe:$safe, proxyAdminOwnerOnChain:$owner, anchorStateRegistry:$asr, disputeGameFactory:$dgf,
    respectedGameType:($respected|tonumber), superPermissionedImpl:$g5, superCannonKonaImpl:$g9, superCannonKonaInitBondWei:$bond9,
    superCannonKonaAbsolutePrestate:$pre}' | tee proofs.json
echo "deployer balance $(balance) wei at end" | tee -a costs.log
