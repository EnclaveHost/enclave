// Regenerates tree/test/fixtures/ledger-rev16d from the AUTHORITATIVE rev-16d source with the manifest-pinned solc-js
// (contracts/deployments/source-verification-base.json: soljson sha256 checked, unit "EnclaveDeployments.sol", runs 1,
// viaIR) - the exact live build, CBOR metadata included - and proves it: the runtime patched with the live library link
// and immutables hashes to the live code hash. Records which immutable id is which. Read-only outside the fixture dir.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const T = "/home/steven/Documents/Codex/2026-10-18/wo/work/storage-front-binding/tree";
const { keccak256 } = createRequire(path.join(T, "package.json"))("viem");
const { loadCompiler } = await import(path.join(T, "scripts/network/verify-deployed-sources.mjs"));
const manifest = JSON.parse(fs.readFileSync(path.join(T, "contracts/deployments/source-verification-base.json"), "utf8"));
const build = manifest.builds["ledger-rev16d"], UNIT = "EnclaveDeployments.sol";
const SRC = "/home/steven/Documents/Codex/2026-10-18/wo/work/storage-front-binding/base/EnclaveDeployments.rev16d.sol";
const content = fs.readFileSync(SRC, "utf8");
const sha = createHash("sha256").update(content).digest("hex");
if (sha !== build.sources[UNIT].sha256) throw Error("not the authoritative source");
const solc = loadCompiler(manifest);
const sel = ["abi", "evm.bytecode.object", "evm.bytecode.linkReferences", "evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "evm.deployedBytecode.immutableReferences"];
const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { [UNIT]: { content } },
  settings: { ...build.settings, outputSelection: { [UNIT]: { EnclaveDeployments: sel, EnclaveLedgerBandwidth: sel } } } }), { import: (p) => ({ error: "no imports: " + p }) }));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) throw Error(errors.map((e) => e.formattedMessage).join("\n"));
const L = manifest.contracts.deployments, LIB = manifest.contracts.ledgerBandwidthLibrary;
function patch(dep, imm, links) {
  let o = dep.object;
  for (const [id, refs] of Object.entries(dep.immutableReferences || {})) for (const { start, length } of refs) o = o.slice(0, start * 2) + imm[id].slice(2).slice(-length * 2) + o.slice((start + length) * 2);
  for (const libs of Object.values(dep.linkReferences || {})) for (const refs of Object.values(libs)) for (const { start, length } of refs) o = o.slice(0, start * 2) + links.slice(2) + o.slice((start + length) * 2);
  return o;
}
const dep = out.contracts[UNIT].EnclaveDeployments.evm.deployedBytecode;
const ids = Object.keys(dep.immutableReferences).sort((a, b) => Number(a) - Number(b));
const names = ["EnclaveDeployments.usdc", "EnclaveDeployments.registry"];
let order = null;
for (const p of [[0, 1], [1, 0]]) {
  const imm = Object.fromEntries(ids.map((id, i) => [id, L.immutables[names[p[i]]]]));
  if (keccak256("0x" + patch(dep, imm, L.links[`${UNIT}:EnclaveLedgerBandwidth`])) === L.codeHash) order = Object.fromEntries(ids.map((id, i) => [id, names[p[i]].split(".")[1]]));
}
if (!order) throw Error("the compiled runtime does not reproduce the live code hash");
const libDep = out.contracts[UNIT].EnclaveLedgerBandwidth.evm.deployedBytecode;
const libImm = Object.fromEntries(Object.keys(libDep.immutableReferences || {}).map((id) => [id, LIB.immutables.library_deploy_address]));
if (keccak256("0x" + patch(libDep, libImm, "0x")) !== LIB.codeHash) throw Error("the library does not reproduce its live code hash");
const FIX = path.join(T, "test/fixtures/ledger-rev16d");
for (const n of ["EnclaveDeployments", "EnclaveLedgerBandwidth"]) {
  const c = out.contracts[UNIT][n];
  fs.writeFileSync(path.join(FIX, n + ".json"), JSON.stringify({ abi: c.abi,
    bytecode: { object: "0x" + c.evm.bytecode.object, linkReferences: c.evm.bytecode.linkReferences },
    deployedBytecode: { object: "0x" + c.evm.deployedBytecode.object, linkReferences: c.evm.deployedBytecode.linkReferences, immutableReferences: c.evm.deployedBytecode.immutableReferences },
    ...(n === "EnclaveDeployments" ? { immutableNames: order } : {}) }) + "\n");
}
console.log(JSON.stringify({ sourceSha256: sha, order, ledgerCodeHash: L.codeHash, libraryCodeHash: LIB.codeHash, match: true }));
