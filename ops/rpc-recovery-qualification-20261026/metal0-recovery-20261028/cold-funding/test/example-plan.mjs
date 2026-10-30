// Writes evidence/plan-shape-SYNTHETIC.json: the plan's exact shape with PRODUCTION pins and SYNTHETIC facts (C9 nonce
// 23760 and balance from root's receipt evidence; sponsor nonce 0 is a placeholder; fees and L1 bound are stand-ins).
// It is NOT a plan to sign: only bin/prepare.mjs at a fresh agreed block produces one.
import fs from "node:fs";
import { PRODUCTION as P, buildPlan, designatorOf } from "../lib/maintenance.mjs";
const TS = 1792800000;
const facts = { block: "SYNTHETIC", blockHash: "SYNTHETIC", blockTimestamp: TS, rpcs: ["SYNTHETIC"], operatorCode: designatorOf(P.executor), sponsorCode: "0x",
  executorCodeHash: P.executorCodeHash, reserveCodeHash: P.reserveCodeHash, reserveExecutor: P.executor, reserveDelegationCodeHash: P.delegationCodeHash,
  operatorNonce: { atBlock: 23760, latest: 23760, pending: 23760 }, sponsorNonce: { atBlock: 0, latest: 0, pending: 0 },
  operatorBalance: "145368427115", sponsorBalance: "61650000000000", storage: { note: "SYNTHETIC: read at the agreed block" }, executorViews: { note: "SYNTHETIC" },
  plainTransferReverts: true, codelessTransferSimulation: "SYNTHETIC", baseFeePerGas: 5_000_000n, maxPriorityFeePerGas: 1_000_000n };
const quiesce = { providedBy: "root", providedAt: TS - 60, signersStopped: ["SYNTHETIC: root lists every stopped C9 signer"], lastSponsoredLeaseDeadline: TS - 900, leases: [] };
const { plan } = await buildPlan({ cfg: P, facts, quiesce, oracle: { isIsthmus: async () => true, l1UpperBound: async () => 50_000_000_000n, operatorFee: async () => 0n } });
fs.writeFileSync(new URL("../evidence/plan-shape-SYNTHETIC.json", import.meta.url), JSON.stringify({ SYNTHETIC: "shape only; not for signing", ...plan }, null, 1) + "\n");
console.log(JSON.stringify({ fees: plan.fees.totalBoundWei, authDigests: plan.authorizationsToSign.map((a) => a.digest) }));
