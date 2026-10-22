// The production facts this cutover is about (all public), and the ABI slices it reads. The ABIs are copied from
// work/enclave/cli/enclave.mjs (DEPLOYMENT_TUPLE for deploymentsSchema >= 2; catalog VERSION_TUPLE / _V3).
export const PRODUCTION = {
  deployment: "0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a",
  publisherUrl: "https://d9798e4c.app.enclave.host",
  name: "k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52",
  // the canonical CREATE2 deployer (Arachnid "deterministic-deployment-proxy"), present on Base: deploy(salt ++ initcode)
  create2Deployer: "0x4e59b44847b379578588920ca78fbf26c0b4956c",
  create2DeployerCodeHash: "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989",
};

const DEPLOYMENT_TUPLE = [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" },
  { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "configCid", type: "string" },
  { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
  { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" },
  { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" },
  { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" },
  { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
  { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
];
const VERSION_TUPLE = [
  { name: "cid", type: "string" }, { name: "version", type: "string" },
  { name: "vramMb", type: "uint32" }, { name: "gpuGflops", type: "uint32" },
  { name: "memMb", type: "uint32" }, { name: "cpuGflops", type: "uint32" },
  { name: "createdAt", type: "uint64" }, { name: "verified", type: "bool" },
  { name: "yanked", type: "bool" }, { name: "ports", type: "string" },
  { name: "approval", type: "uint8" },
];
const view = (name, inputs, outputs) => ({ type: "function", name, stateMutability: "view", inputs, outputs });
const catalogBase = (vt) => [
  view("catalogSchema", [], [{ type: "uint256" }]),
  view("numVersions", [{ name: "appId", type: "bytes32" }], [{ type: "uint256" }]),
  view("getVersionsPage", [{ name: "appId", type: "bytes32" }, { name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    [{ type: "tuple[]", components: vt }]),
  view("versionConfigCid", [{ name: "appId", type: "bytes32" }, { name: "index", type: "uint256" }], [{ type: "string" }]),
];
export const ABI = {
  ledger: [
    view("deploymentsSchema", [], [{ type: "uint256" }]),
    view("get", [{ name: "id", type: "bytes32" }], [{ type: "tuple", components: DEPLOYMENT_TUPLE }]),
    { type: "function", name: "setConfig", stateMutability: "nonpayable",
      inputs: [{ name: "id", type: "bytes32" }, { name: "configCid", type: "string" }], outputs: [] },
  ],
  catalog: catalogBase(VERSION_TUPLE),
  catalogV3: catalogBase([...VERSION_TUPLE, { name: "config", type: "string" }]),
};
