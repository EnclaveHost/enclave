// Offline build of the test fixtures (no network): the REAL EnclaveLeaseExecutor source (history-checkpoint-transport
// tree, sha256 dc605ffa…; its deployed runtime embeds other immutables, so tests compare behaviour, not the production
// hash) and the reserve stub. solc 0.8.35 (soljson sha256 fa4345d6…), optimizer 200.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const EXEC = "/home/steven/Documents/Codex/2026-10-18/wo/work/history-checkpoint-transport/tree/contracts/EnclaveLeaseExecutor.sol";
const src = fs.readFileSync(EXEC);
if (sha(src) !== "dc605ffa6e2e2252760f417cd9f4f0a75a2f26399e0a837163da2108dda10033") throw Error("executor source differs from the reviewed one");
if (sha(fs.readFileSync(require.resolve("solc/soljson.js"))) !== "fa4345d648d9a09c6601ffc978e78e9f5267b54e6d91e8f8c473f44c0c16323b") throw Error("soljson differs");
const solc = require("solc");
function build(name, file, content) {
  const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { [file]: { content } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts[file][name];
  return { abi: c.abi, creation: "0x" + c.evm.bytecode.object };
}
const ex = build("EnclaveLeaseExecutor", "EnclaveLeaseExecutor.sol", src.toString("utf8"));
const st = build("ReserveStub", "ReserveStub.sol", fs.readFileSync(new URL("./ReserveStub.sol", import.meta.url), "utf8"));
fs.writeFileSync(new URL("./fixtures/executor-build.json", import.meta.url), JSON.stringify({ sourceSha256: sha(src), solc: solc.version(), ...ex }) + "\n");
fs.writeFileSync(new URL("./fixtures/reserve-stub.json", import.meta.url), JSON.stringify(st) + "\n");
console.log(JSON.stringify({ solc: solc.version(), executorAbi: ex.abi.length, stubAbi: st.abi.length }));
