#!/usr/bin/env node
// kona-custom-configs.mjs - turn an op-deployer rollup config into the
// KONA_CUSTOM_CONFIGS_DIR inputs (chainList.json, configs.json, depsets.json)
// that kona-registry merges at build time, so a reproducible kona-client
// prestate embeds the Enclave L2's RollupConfig.
//
// The permissionless game (SUPER_CANNON_KONA on Sepolia's current OPCM) only
// verifies if every honest challenger runs the same kona-client binary, and
// that binary's hash is the absolute prestate committed on L1. So these files
// are deployment inputs: commit them beside the prestate hash they produced.
//
// Usage:
//   node l2/kona-custom-configs.mjs --rollup rollup.json --out DIR \
//        [--name "Enclave L2 Devnet"] [--slug enclave-devnet] [--group sepolia] \
//        [--proxy-admin-owner 0x...]
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const die = (m) => { console.error(`kona-custom-configs: ${m}`); process.exit(1); };
if (!args.rollup || !args.out) die("--rollup and --out are required");

const rollup = JSON.parse(fs.readFileSync(args.rollup, "utf8"));
const name = args.name || "Enclave L2 Devnet";
const slug = args.slug || "enclave-devnet";
const group = args.group || (rollup.l1_chain_id === 11155111 ? "sepolia" : rollup.l1_chain_id === 1 ? "mainnet" : die("unknown L1; pass --group"));
const chainId = rollup.l2_chain_id;
if (!Number.isSafeInteger(chainId)) die("rollup.l2_chain_id missing");

// Every fork op-deployer activates at genesis for a fresh chain. kona reads
// the same names; anything absent stays inactive, which would derive a
// different chain - so refuse an unknown fork instead of silently dropping it.
const FORKS = ["canyon", "delta", "ecotone", "fjord", "granite", "holocene",
               "pectra_blob_schedule", "isthmus", "jovian", "karst"];
const hardforks = {};
for (const [k, v] of Object.entries(rollup)) {
  const m = /^(.*)_time$/.exec(k);
  if (!m || k === "block_time" || m[1] === "regolith") continue;
  if (!FORKS.includes(m[1])) die(`unknown fork ${k}; extend FORKS after checking kona's schema`);
  hardforks[k] = v;
}

const sc = rollup.genesis.system_config;
const chain = {
  Name: name, PublicRPC: "", SequencerRPC: "", Explorer: "",
  GovernedByOptimism: false, SuperchainTime: null, DataAvailabilityType: "eth-da",
  l2_chain_id: chainId,
  batch_inbox_address: rollup.batch_inbox_address,
  block_time: rollup.block_time,
  seq_window_size: rollup.seq_window_size,
  max_sequencer_drift: rollup.max_sequencer_drift,
  GasPayingToken: null,
  hardfork_configuration: hardforks,
  optimism: rollup.chain_op_config,
  alt_da: null,
  genesis: {
    l1: rollup.genesis.l1, l2: rollup.genesis.l2, l2_time: rollup.genesis.l2_time,
    system_config: {
      batcherAddr: sc.batcherAddr, overhead: sc.overhead, scalar: sc.scalar, gasLimit: sc.gasLimit,
      baseFeeScalar: null, blobBaseFeeScalar: null, eip1559Denominator: null, eip1559Elasticity: null,
      operatorFeeScalar: null, operatorFeeConstant: null,
      minBaseFee: sc.minBaseFee ?? null, daFootprintGasScalar: sc.daFootprintGasScalar ?? null,
    },
  },
  Roles: {
    SystemConfigOwner: null, ProxyAdminOwner: args["proxy-admin-owner"] || null, Guardian: null,
    Challenger: null, Proposer: null, UnsafeBlockSigner: null, BatchSubmitter: sc.batcherAddr,
  },
  Addresses: {
    OptimismPortalProxy: rollup.deposit_contract_address,
    SystemConfigProxy: rollup.l1_system_config_address,
  },
};

const chainList = [{
  name, identifier: `${group}/${slug}`, chainId, rpc: [], explorers: [],
  superchainLevel: 0, governedByOptimism: false, dataAvailabilityType: "eth-da",
  parent: { type: "L2", chain: group }, faultProofs: { status: "permissionless" },
}];
// The superchain bucket groups by L1; kona-registry appends our chain to the
// existing bucket. Its own hardfork block is the L1 group's, not ours.
const configs = { superchains: [{ name: group, config: { name: group[0].toUpperCase() + group.slice(1),
  l1: { chain_id: rollup.l1_chain_id, public_rpc: "", explorer: "" },
  hardforks: {}, superchain_config_addr: null, op_contracts_manager_proxy_addr: null },
  chains: [chain] }] };
// A self-only dependency set: the super-root game proves a cluster of one.
const depsets = [{ dependencies: { [chainId]: {} }, overrideMessageExpiryWindow: null }];

fs.mkdirSync(args.out, { recursive: true });
for (const [f, v] of [["chainList.json", chainList], ["configs.json", configs], ["depsets.json", depsets]])
  fs.writeFileSync(path.join(args.out, f), JSON.stringify(v, null, 2) + "\n");
console.log(`wrote ${args.out}/{chainList,configs,depsets}.json for chain ${chainId} (${group}/${slug})`);
