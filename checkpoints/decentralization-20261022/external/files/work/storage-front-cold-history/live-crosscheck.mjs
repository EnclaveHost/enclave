// Read-only: for each LIVE fact the Go guest reader produced (job-live2.log), the INDEPENDENT relay implementation
// (relay/lease-generation.mjs) over a different source set computes the same deployment's fact, and the claim's age is
// reported (blocks and days before the head). Exit 1 on any disagreement or missing fact.
import fs from "node:fs";
import { createLeaseGenerationReader, memoryStore } from "./tree/relay/lease-generation.mjs";
const lines = fs.readFileSync(process.argv[2], "utf8").split("\n").filter((l) => /^LIVE 0x[0-9a-f]{64} with-history code=ok/.test(l));
if (!lines.length) { console.log("CROSSCHECK: no live fact to check"); process.exit(1); }
const R = createLeaseGenerationReader({ rpcs: ["https://gateway.tenderly.co/public/base", "https://base-rpc.polkachu.com", "https://base-rpc.publicnode.com"],
  ledger: "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b", store: memoryStore() });
let bad = 0;
for (const l of lines) {
  const id = l.split(" ")[1], goFact = JSON.parse(l.match(/fact=(\{.*?\}) err=/)[1]);
  let js = null, err = null;
  for (let i = 0; i < 60 && !js; i++) { try { js = await R.writerAuthority(id); } catch (e) { err = e; if (!e.retry) break; await new Promise((ok) => setTimeout(ok, 5000)); } }
  if (!js) { console.log(`CROSSCHECK ${id} js-reader failed: ${err?.code} ${err?.message?.slice(0, 200)}`); bad++; continue; }
  const same = JSON.stringify(js.fact) === JSON.stringify(goFact);
  const ageBlocks = js.block.number - js.fact.claimBlock;
  console.log(`CROSSCHECK ${id} ${same ? "AGREE" : "DISAGREE"} claimBlock=${js.fact.claimBlock} agreedBlock=${js.block.number} ageBlocks=${ageBlocks} ageDays=${(ageBlocks * 2 / 86400).toFixed(2)} go=${JSON.stringify(goFact)} js=${js.factJson}`);
  if (!same) bad++;
}
process.exit(bad ? 1 : 0);
