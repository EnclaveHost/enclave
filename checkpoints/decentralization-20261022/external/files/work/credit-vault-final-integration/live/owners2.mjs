// READ-ONLY: distinct live ledger owners that carry code, classified (credit-vault clone of either factory, SessionVault of
// the pinned/legacy factory by its own isVault(), Safe, EIP-7702, other) - two providers must agree.
import { createPublicClient, http, keccak256, parseAbi } from "viem";
import { base } from "viem/chains";
const C = ["https://gateway.tenderly.co/public/base", "https://base-rpc.polkachu.com"].map((u) => createPublicClient({ chain: base, transport: http(u, { retryCount: 6, retryDelay: 1500 }), batch: false }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const both = async (fn) => { const a = await fn(C[0]); await sleep(150); const b = await fn(C[1]); const s = (x) => JSON.stringify(x, (_k, v) => typeof v === "bigint" ? v.toString() : v); if (s(a) !== s(b)) throw new Error("disagree"); return a; };
const block = (await C[0].getBlockNumber()) - 5n;
const ledger = "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B";
const L = parseAbi(["function count() view returns (uint256)", "function idAt(uint256) view returns (bytes32)"]);
const G = parseAbi(["function get(bytes32) view returns ((bytes32 id,address owner,string appRef,string ports,string configCid,uint16 gpuMilli,uint16 cpuMilli,uint32 appPort,bool isPublic,bool active,uint64 createdAt,uint256 rate,uint256 balance6,uint256 spent6,bytes32 runner,address runnerOperator,uint64 leaseUntil))"]);
const SV = [{ a: "0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c", n: "legacy SessionVault factory" }, { a: "0xec9277a32f98ad3108747fe3da78c35e1bee097b", n: "pinned SessionVault factory" }];
const CV = { "0xaf81a59492409ab717afce6e72a425bdb2fac507": "credit-vault older (2026-07-21)", "0xeca6644333d3a069001203ce5416914a4d830beb": "credit-vault current (d36100ae)" };
const n = await both((c) => c.readContract({ address: ledger, abi: L, functionName: "count", blockNumber: block }));
const owners = {};
for (let i = 0n; i < n; i++) {
  const id = await both((c) => c.readContract({ address: ledger, abi: L, functionName: "idAt", args: [i], blockNumber: block }));
  const d = await both((c) => c.readContract({ address: ledger, abi: G, functionName: "get", args: [id], blockNumber: block }));
  (owners[d.owner.toLowerCase()] ||= []).push(d.active);
}
const out = { block: block.toString(), records: Number(n), owners: [] };
for (const [o, act] of Object.entries(owners)) {
  const code = (await both((c) => c.getCode({ address: o, blockNumber: block }))) || "0x";
  if (code === "0x") { out.owners.push({ o, kind: "eoa", records: act.length }); continue; }
  let kind;
  if (/^0xef0100/i.test(code)) kind = "eoa-7702 → " + code.slice(8, 48);
  else { const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code); if (m && CV["0x" + m[1].toLowerCase()]) kind = CV["0x" + m[1].toLowerCase()]; }
  if (!kind) for (const f of SV) { try { if (await both((c) => c.readContract({ address: f.a, abi: parseAbi(["function isVault(address) view returns (bool)"]), functionName: "isVault", args: [o], blockNumber: block }))) { kind = "session-vault (" + f.n + ")"; break; } } catch {} }
  if (!kind) { try { const t = await both((c) => c.readContract({ address: o, abi: parseAbi(["function getThreshold() view returns (uint256)"]), functionName: "getThreshold", blockNumber: block })); kind = "safe (threshold " + t + ")"; } catch {} }
  out.owners.push({ o, kind: kind || "contract " + keccak256(code).slice(0, 14) + " (" + (code.length - 2) / 2 + " B)", records: act.length, active: act.filter(Boolean).length });
}
const t = {}; for (const x of out.owners) { const k = x.kind.split(" (")[0].split(" →")[0]; t[k] = (t[k] || 0) + x.records; } out.recordsByKind = t;
console.log(JSON.stringify(out, null, 2));
