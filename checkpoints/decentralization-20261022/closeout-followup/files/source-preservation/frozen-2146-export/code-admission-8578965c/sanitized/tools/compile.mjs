// compile.mjs <out.json>: the ORIGINAL vault source (orig-9d43, git blob 7a385bbc = 9d43e63e8 = ff13ebe08) with the deployed
// settings (solc 0.8.35, viaIR, runs 200), plus two read-surface stand-ins (book.addr, registry.get schema-4 head words).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const solc = createRequire(path.join(HERE, "node_modules", "solc", "package.json"))("./index.js");
const STANDINS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract StandinBook { mapping(bytes32 => address) private a; function addr(bytes32 k) external view returns (address) { return a[k]; }
  function set(bytes32 k, address v) external { a[k] = v; } }
contract StandinRegistry {
  struct E { string endpoint; string repo; bytes32 measurement; address operator; uint64 registeredAt; uint64 lastSeen; bool active;
             uint16 cpu; uint16 gpu; address proofKey; address payoutWallet; }
  mapping(bytes32 => E) private e;
  function set(bytes32 id, address op, bool act, address payout) external { E storage x = e[id]; x.endpoint = "https://host.test"; x.operator = op; x.active = act; x.payoutWallet = payout; }
  function get(bytes32 id) external view returns (E memory) { return e[id]; } }
`;
const run = (sources, settings) => {
  const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
    settings: { ...settings, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  const errs = (out.errors || []).filter((x) => x.severity === "error"); if (errs.length) throw new Error(errs.map((x) => x.formattedMessage).join("\n"));
  return out;
};
const pick = (o, f, n) => ({ abi: o.contracts[f][n].abi, bytecode: "0x" + o.contracts[f][n].evm.bytecode.object });
const v = run({ "EnclaveSecretVaultV2.sol": fs.readFileSync(path.join(HERE, "orig-9d43/contracts/EnclaveSecretVaultV2.sol"), "utf8") }, { viaIR: true, optimizer: { enabled: true, runs: 200 } });
const s = run({ "Standins.sol": STANDINS }, { optimizer: { enabled: true, runs: 200 } });
fs.writeFileSync(process.argv[2], JSON.stringify({ compiler: solc.version(), vault: pick(v, "EnclaveSecretVaultV2.sol"; "EnclaveSecretVaultV2"),
  book: pick(s, "Standins.sol", "StandinBook"), registry: pick(s, "Standins.sol", "StandinRegistry") }));
console.log("compiled", solc.version());
