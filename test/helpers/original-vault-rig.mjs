// The original-vault rig: the deployed EnclaveSecretVaultV2 source (contracts/EnclaveSecretVaultV2.sol, git blob 7a385bbc,
// full runtime match with 0xE48699B8…), the deployed schema-4 EnclaveRegistry source (test/fixtures, sha256 e81f5d51…, the
// source-verification manifest's registry-schema4 build), EnclaveHostOwnership and EnclaveAddressBook as in this tree, and
// two minimal stand-ins: a ledger the test writes rows into, and a SessionVault factory/vault pair exposing exactly what the
// vault calls (isVault, owner) and - like contracts/SessionVault.sol - no isValidSignature.
// Compilation runs in a CHILD process (`node original-vault-rig.mjs <out>`) so solc's peak memory is released before anvil
// starts; the result is cached by source digest.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const RIG_MOCKS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract RigLedger {
  struct Deployment { bytes32 id; address owner; string appRef; string ports; string configCid; uint16 gpuMilli; uint16 cpuMilli; uint32 appPort;
    bool isPublic; bool active; uint64 createdAt; uint256 rate; uint256 balance6; uint256 spent6; bytes32 runner; address runnerOperator; uint64 leaseUntil; }
  mapping(bytes32 => Deployment) private d;
  function set(bytes32 id, address owner, bytes32 runner, address runnerOperator, uint64 leaseUntil) external {
    Deployment storage x = d[id]; x.id = id; x.owner = owner; x.runner = runner; x.runnerOperator = runnerOperator; x.leaseUntil = leaseUntil; x.active = true; }
  function get(bytes32 id) external view returns (Deployment memory) { return d[id]; }
}
contract RigSessionVault { address public owner; constructor(address o) { owner = o; } }
contract RigSessionFactory {
  mapping(address => bool) public isVault;
  event VaultCreated(address vault, address owner);
  function create(address owner_) external returns (address v) { v = address(new RigSessionVault(owner_)); isVault[v] = true; emit VaultCreated(v, owner_); }
}
`;
const SOURCES = () => ({
  vault: fs.readFileSync(path.join(ROOT, "contracts/EnclaveSecretVaultV2.sol"), "utf8"),
  registry: fs.readFileSync(path.join(ROOT, "test/fixtures/EnclaveRegistry.schema4.sol"), "utf8"),
  ownership: fs.readFileSync(path.join(ROOT, "contracts/EnclaveHostOwnership.sol"), "utf8"),
  book: fs.readFileSync(path.join(ROOT, "contracts/EnclaveAddressBook.sol"), "utf8"),
  mocks: RIG_MOCKS,
});
const digestOf = (s) => createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 16);
export const sourceDigests = () => Object.fromEntries(Object.entries(SOURCES()).map(([k, v]) => [k, createHash("sha256").update(v).digest("hex")]));

function compileNow() {
  const solc = createRequire(path.join(ROOT, "package.json"))("solc");
  const s = SOURCES();
  const run = (sources, settings) => {
    const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
      settings: { ...settings, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
    const errs = (out.errors || []).filter((e) => e.severity === "error");
    if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
    return out;
  };
  const pick = (out, f, n) => ({ abi: out.contracts[f][n].abi, bytecode: "0x" + out.contracts[f][n].evm.bytecode.object });
  // the deployed settings: the vault viaIR runs 200; the registry runs 200 (no viaIR); the rest as the registry
  const v = run({ "EnclaveSecretVaultV2.sol": s.vault }, { viaIR: true, optimizer: { enabled: true, runs: 200 } });
  const o = run({ "EnclaveRegistry.sol": s.registry, "EnclaveHostOwnership.sol": s.ownership, "EnclaveAddressBook.sol": s.book, "Rig.sol": s.mocks },
                { optimizer: { enabled: true, runs: 200 } });
  return { compiler: solc.version(), digests: sourceDigests(),
           vault: pick(v, "EnclaveSecretVaultV2.sol", "EnclaveSecretVaultV2"), registry: pick(o, "EnclaveRegistry.sol", "EnclaveRegistry"),
           ownership: pick(o, "EnclaveHostOwnership.sol", "EnclaveHostOwnership"), book: pick(o, "EnclaveAddressBook.sol", "EnclaveAddressBook"),
           ledger: pick(o, "Rig.sol", "RigLedger"), sessionFactory: pick(o, "Rig.sol", "RigSessionFactory"), sessionVault: pick(o, "Rig.sol", "RigSessionVault") };
}

export function originalVaultRig() {
  const cache = path.join(process.env.TMPDIR || os.tmpdir(), `enclave-original-vault-rig-${digestOf(SOURCES())}.json`);
  if (!fs.existsSync(cache)) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), cache], { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) throw new Error(`rig compile failed (${r.status ?? r.signal})`);
  }
  return JSON.parse(fs.readFileSync(cache, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  const r = compileNow();
  fs.writeFileSync(process.argv[2] + ".tmp", JSON.stringify(r));
  fs.renameSync(process.argv[2] + ".tmp", process.argv[2]);
}
