// READ-ONLY: every distinct owner of a live ledger record, classified by main's own network/lease-gas-owner.mjs ownerKind()
// (QuorumChain over two providers, the pinned + legacy SessionVault factories the CLI uses), so we see exactly which owners
// the lease-gas client would classify as an unknown "contract" (deposit allowed, no reviewed owner path).
import { parseAbi } from "viem";
const M = "../../enclave/";
const O = await import(M + "network/lease-gas-owner.mjs");
const { QuorumChain } = await import(M + "cli/independent.mjs");
const pins = JSON.parse(await (await import("node:fs")).promises.readFile(new URL(M + "contracts/deployments/contract-pins-production-base.json", import.meta.url)));
const chain = new QuorumChain({ rpcs: ["https://gateway.tenderly.co/public/base", "https://base-rpc.polkachu.com"], quorum: 2, confirmations: 3, chainId: 8453, maxBlockAgeMs: 600000 });
const ledger = "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B";
const L = parseAbi(["function count() view returns (uint256)", "function idAt(uint256) view returns (bytes32)", "function ownerOfId(bytes32) view returns (address)"]);
const G = parseAbi(["function get(bytes32) view returns ((bytes32 id,address owner,string appRef,string ports,string configCid,uint16 gpuMilli,uint16 cpuMilli,uint32 appPort,bool isPublic,bool active,uint64 createdAt,uint256 rate,uint256 balance6,uint256 spent6,bytes32 runner,address runnerOperator,uint64 leaseUntil))"]);
const sv = pins.sessionVaultFactory || pins.contracts?.sessionVaultFactory?.address || pins.pins?.sessionVaultFactory;
const factories = [...(sv ? [{ address: sv, name: "pinned SessionVault factory" }] : []), O.LEGACY_SESSION_VAULT_FACTORY];
const n = await chain.read(ledger, L, "count");
const byOwner = {};
for (let i = 0n; i < n; i++) {
  const id = await chain.read(ledger, L, "idAt", [i]);
  const d = await chain.read(ledger, G, "get", [id]);
  (byOwner[d.owner.toLowerCase()] ||= []).push({ id, active: d.active, leaseUntil: String(d.leaseUntil) });
}
const out = { factories, owners: [] };
for (const [o, recs] of Object.entries(byOwner)) {
  const k = await O.ownerKind(chain, o, { vaultFactories: factories });
  if (k.kind === "eoa") { out.owners.push({ owner: o, kind: "eoa", records: recs.length }); continue; }
  out.owners.push({ owner: o, kind: k.kind, detail: k.label || k.factoryName || k.codeHash || k.delegate || (k.threshold ? `safe ${k.threshold}/${k.owners.length}` : ""), records: recs.length, active: recs.filter((r) => r.active).length });
}
const tally = {}; for (const x of out.owners) tally[x.kind] = (tally[x.kind] || 0) + x.records;
out.recordsByKind = tally;
console.log(JSON.stringify(out, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
