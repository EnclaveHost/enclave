// Read-only: each deployment's on-chain record and rate cap, resolved through the address book as production does.
process.env.ADDRESS_BOOK_ADDRESS ||= "0xab214342d5A490150A4A977063A2f88E21F80907";
process.env.BASE_RPC ||= "https://base-rpc.publicnode.com";
const WT = "/home/steven/Projects/enclave-poolacct";
const ab = await import(WT + "/addressbook.js");
await ab.initAddressBook({ log() {}, warn() {}, error() {}, info() {} });
const { createPublicClient, http } = await import(WT + "/node_modules/viem/_esm/index.js");
const fs = await import("node:fs");
const abiRaw = JSON.parse(fs.readFileSync(WT + "/contracts/EnclaveDeployments.abi.json", "utf8"));
const abi = Array.isArray(abiRaw) ? abiRaw : abiRaw.abi;
const pub = createPublicClient({ transport: http(process.env.BASE_RPC) });
const out = { deployments: ab.DEPLOYMENTS_ADDRESS, block: String(await pub.getBlockNumber()), records: {} };
for (const id of process.argv.slice(2)) {
  const g = await pub.readContract({ address: ab.DEPLOYMENTS_ADDRESS, abi, functionName: "get", args: [id] });
  const cap = await pub.readContract({ address: ab.DEPLOYMENTS_ADDRESS, abi, functionName: "capOf", args: [id] });
  out.records[id] = Object.fromEntries(Object.entries({ ...g, capMaxRate6: cap }).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v]));
}
console.log(JSON.stringify(out, null, 1));
