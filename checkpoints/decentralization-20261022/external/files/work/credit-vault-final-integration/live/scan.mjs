// READ-ONLY Base scan (no transaction, no key): the live lease-gas reserve, every ledger record's owner classified against
// BOTH credit-vault factories, and the reserve's Deposited/Configured history. Two RPC providers must agree on every value.
import { createPublicClient, http, keccak256, parseAbi, getAddress } from "viem";
import { base } from "viem/chains";
const RPCS = ["https://gateway.tenderly.co/public/base", "https://base-rpc.polkachu.com"];
const C = RPCS.map((u) => createPublicClient({ chain: base, transport: http(u, { retryCount: 3, retryDelay: 800 }) }));
const DEP = JSON.parse(await (await import("node:fs")).promises.readFile(new URL("../../lease-relay-activation/deployment.json", import.meta.url)));
const FACT = [{ f: "0x848a8a89c3452ce7dc14764114a8c5886b6f0c08", impl: "0xaf81a59492409ab717afce6e72a425bdb2fac507", label: "older (2026-07-21)" },
  { f: "0xa891e4396e3eb11f364554043bc18e86da834e91", impl: "0xeca6644333d3a069001203ce5416914a4d830beb", label: "current (d36100ae)" }];
const rt = (i) => `0x363d3d373d3d3d363d73${i.slice(2)}5af43d82803e903d91602b57fd5bf3`;
const head = await C[0].getBlockNumber(); const block = head - 5n;
const both = async (fn) => { const [a, b] = await Promise.all(C.map(fn)); const ja = JSON.stringify(a, (_k, v) => typeof v === "bigint" ? v.toString() : v);
  if (ja !== JSON.stringify(b, (_k, v) => typeof v === "bigint" ? v.toString() : v)) throw new Error("RPC disagreement"); return a; };
const R = parseAbi(["function owner() view returns (address)", "function paused() view returns (bool)", "function executor() view returns (address)",
  "function ledger() view returns (address)", "function registry() view returns (address)", "function l1Oracle() view returns (address)",
  "function limits() view returns (uint64,uint32,uint32,uint32,uint32,uint16)", "function delegationCodeHash() view returns (bytes32)"]);
const out = { block: block.toString(), rpcs: RPCS, reserve: DEP.reserve };
const code = await both((c) => c.getCode({ address: DEP.reserve, blockNumber: block }));
out.reserveCodeHash = keccak256(code); out.reserveCodeHashMatchesRecord = out.reserveCodeHash === DEP.reserveCodeHash;
out.reserveRuntimeBytes = (code.length - 2) / 2;
for (const fn of ["owner", "paused", "executor", "ledger", "registry", "l1Oracle", "limits", "delegationCodeHash"])
  out[fn] = await both((c) => c.readContract({ address: DEP.reserve, abi: R, functionName: fn, blockNumber: block }));
out.reserveBalanceWei = (await both((c) => c.getBalance({ address: DEP.reserve, blockNumber: block }))).toString();
// the reserve's history: Deposited / Configured (deployment block by bisection on getCode)
let lo = 50_000_000n, hi = block;
while (hi - lo > 1n) { const m = (lo + hi) / 2n; const cd = await C[0].getCode({ address: DEP.reserve, blockNumber: m }); if (cd && cd !== "0x") hi = m; else lo = m; }
out.reserveDeployBlock = hi.toString();
const EV = parseAbi(["event Deposited(bytes32 indexed id, address indexed owner, address indexed from, uint256 amountWei)",
  "event Configured(bytes32 indexed id, address indexed owner, (bool,uint8,bool,uint8,uint64,uint64,uint32,uint32,uint32,uint32,uint64) policy)",
  "event Withdrawn(bytes32 indexed id, address indexed owner, address to, uint256 amountWei)"]);
const logs = [];
for (let b = hi; b <= block; b += 999n) {
  const to = b + 998n > block ? block : b + 998n;
  logs.push(...await both((c) => c.getLogs({ address: DEP.reserve, events: EV, fromBlock: b, toBlock: to }).then((l) => l.map((x) => ({ e: x.eventName, id: x.args.id, owner: x.args.owner, amt: x.args.amountWei?.toString(), tx: x.transactionHash })))));
}
const owners = [...new Set(logs.map((l) => l.owner.toLowerCase()))];
const kindOf = async (a) => { const cd = (await both((c) => c.getCode({ address: a, blockNumber: block }))) || "0x";
  if (cd === "0x") return "eoa"; const f = FACT.find((x) => cd.toLowerCase() === rt(x.impl)); return f ? "credit-vault " + f.label : /^0xef0100/i.test(cd) ? "eoa-7702" : "contract " + keccak256(cd).slice(0, 12); };
out.reserveEvents = { deposited: logs.filter((l) => l.e === "Deposited").length, configured: logs.filter((l) => l.e === "Configured").length, withdrawn: logs.filter((l) => l.e === "Withdrawn").length,
  enrolledIds: [...new Set(logs.filter((l) => l.e === "Configured").map((l) => l.id))].length };
out.reserveOwners = {}; for (const o of owners) out.reserveOwners[o] = await kindOf(o);
// every ledger record's owner, classified
const L = parseAbi(["function count() view returns (uint256)", "function idAt(uint256) view returns (bytes32)", "function deploymentsSchema() view returns (uint256)"]);
const LG = parseAbi(["function get(bytes32) view returns ((bytes32 id,address owner,string appRef,string ports,string configCid,uint16 gpuMilli,uint16 cpuMilli,uint32 appPort,bool isPublic,bool active,uint64 createdAt,uint256 rate,uint256 balance6,uint256 spent6,bytes32 runner,address runnerOperator,uint64 leaseUntil))"]);
const n = await both((c) => c.readContract({ address: DEP.ledger, abi: L, functionName: "count", blockNumber: block }));
out.ledger = { address: DEP.ledger, schema: (await both((c) => c.readContract({ address: DEP.ledger, abi: L, functionName: "deploymentsSchema", blockNumber: block }))).toString(), count: n.toString() };
const kinds = {}, vaultRecords = [], ownerCache = {};
for (let i = 0n; i < n; i++) {
  const id = await both((c) => c.readContract({ address: DEP.ledger, abi: L, functionName: "idAt", args: [i], blockNumber: block }));
  const d = await both((c) => c.readContract({ address: DEP.ledger, abi: LG, functionName: "get", args: [id], blockNumber: block }));
  const o = d.owner.toLowerCase(); const k = ownerCache[o] ||= await kindOf(o);
  kinds[k.split(" ")[0]] = (kinds[k.split(" ")[0]] || 0) + 1;
  if (k.startsWith("credit-vault")) vaultRecords.push({ id, owner: o, kind: k, active: d.active, balance6: d.balance6.toString(), leaseUntil: d.leaseUntil.toString(), appRef: d.appRef,
    reserveEvents: logs.filter((l) => l.id === id).map((l) => l.e) });
}
out.ledgerOwnerKinds = kinds; out.creditVaultOwnedRecords = vaultRecords;
console.log(JSON.stringify(out, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
