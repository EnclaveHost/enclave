// READ-ONLY, public RPC (two providers): the vault-specific pins for the EnclaveDNS 0.1.5 handoff. No key, nothing sent.
import { createHash } from "node:crypto";
import { createPublicClient, http, parseAbi, keccak256 } from "../../../enclave/node_modules/viem/_esm/index.js";
import { CATALOG_ABI, LEDGER_ABI } from "../../../site-host-live-publish/handoff/site-trust.mjs";
const V = "0xB794C4DD0e1C5E6B72281799F282BfdE7654345D", L = "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B", C = "0x18419CA2b502D423A8de6269AEeE171a378626e3";
const ID = "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c", APP = "0x85f28c21b1545a05aee6661faf4b149b5dd18377fce59ad290e9f19857baab06";
const VA = parseAbi(["function owner() view returns (address)", "function factory() view returns (address)", "function held(bytes32) view returns (uint8, bytes32, bytes32)"]);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const out = {};
for (const url of ["https://base-rpc.publicnode.com", "https://mainnet.base.org"]) {
  const c = createPublicClient({ transport: http(url, { timeout: 15000 }) });
  const bn = (await c.getBlockNumber()) - 3n;
  const code = await c.getCode({ address: V, blockNumber: bn });
  const r = (address, abi, functionName, args = []) => c.readContract({ address, abi, functionName, args, blockNumber: bn });
  const [owner, factory, held, dep, n, v4] = await Promise.all([r(V, VA, "owner"), r(V, VA, "factory"), r(V, VA, "held", [ID]), r(L, LEDGER_ABI, "get", [ID]),
    r(C, CATALOG_ABI, "numVersions", [APP]), r(C, CATALOG_ABI, "getVersion", [APP, 4n])]);
  out[new URL(url).hostname] = { block: String(bn), vaultCodeHash: keccak256(code), vaultCodeBytes: (code.length - 2) / 2, owner, factory, held: held.map(String),
    depOwner: dep.owner, appRef: dep.appRef, configCid: dep.configCid, configCidSha256: sha(dep.configCid), numVersions: String(n), v4ConfigSha256: sha(v4.config), v4Cid: v4.cid };
}
console.log(JSON.stringify(out, null, 1));
