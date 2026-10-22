// Writes tree/test/fixtures/credit-vault-reserve-proposal.json from forge/out: the PROPOSED parallel reserve
// (proposal/EnclaveLeaseGasReserveSig.sol) and the UNCHANGED EnclaveLeaseExecutor (main dc605ffa) creation bytecode + ABI, for
// the node/browser client tests on anvil. PROPOSAL ONLY: not a production artifact, never deployed by anyone from here.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
const D = path.dirname(new URL(import.meta.url).pathname);
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(D, f))).digest("hex");
const art = (dir, name) => { const j = JSON.parse(fs.readFileSync(path.join(D, "forge/out", dir, name + ".json"), "utf8")); return { bytecode: j.bytecode.object, abi: j.abi }; };
const out = { _note: "PROPOSAL ONLY (work/credit-vault-final-integration, unapproved). Built by the isolated forge project (solc 0.8.35, viaIR, runs 1, prague) from proposal/EnclaveLeaseGasReserveSig.sol and main's contracts/EnclaveLeaseExecutor.sol (unchanged).",
  reserve: { source: "proposal/EnclaveLeaseGasReserveSig.sol", sourceSha256: sha("proposal/EnclaveLeaseGasReserveSig.sol"), ...art("EnclaveLeaseGasReserveSig.sol", "EnclaveLeaseGasReserveSig") },
  executor: { source: "contracts/EnclaveLeaseExecutor.sol (main, unchanged)", sourceSha256: sha("forge/src/main/EnclaveLeaseExecutor.sol"), ...art("EnclaveLeaseExecutor.sol", "EnclaveLeaseExecutor") } };
if (out.reserve.sourceSha256 !== sha("forge/src/proposal/EnclaveLeaseGasReserveSig.sol")) throw new Error("forge copy of the proposal differs from proposal/");
fs.writeFileSync(path.join(D, "tree/test/fixtures/credit-vault-reserve-proposal.json"), JSON.stringify(out) + "\n");
console.log("reserve", out.reserve.sourceSha256.slice(0, 12), (out.reserve.bytecode.length - 2) / 2, "B initcode; executor", out.executor.sourceSha256.slice(0, 12));
