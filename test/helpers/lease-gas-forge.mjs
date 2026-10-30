// Foundry build of the app-funded lease test contracts, from the repository's own sources, for the node tests
// (test/helpers/lease-gas-world.mjs) and for the Foundry tests in test/lease-gas/forge/test:
//   node test/helpers/lease-gas-forge.mjs test      (forge test with these settings; output outside the repository)
// The repository root is the Foundry root, so every source the tests import (contracts/, test/fixtures/) is inside it;
// its foundry.toml supplies forge-std (contracts/foundry/lib) and the settings below override the rest, as FOUNDRY_*
// variables (a separate config file's paths are not resolved against the root by forge 1.x, so none is used).
// The settings are those the tests were validated with (work/app-lease-gas): solc 0.8.35, viaIR, runs 1 (rev 16d's
// EIP-170 setting), evm prague (EIP-7702). The live registry itself was built at runs 200 without viaIR: same behaviour,
// different gas; no test asserts registry gas. Build output goes to a temp directory named by a hash of every input.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SETTINGS = Object.freeze({ FOUNDRY_SRC: "test/lease-gas/forge/sol", FOUNDRY_TEST: "test/lease-gas/forge/test", FOUNDRY_SOLC_VERSION: "0.8.35",
  FOUNDRY_OPTIMIZER: "true", FOUNDRY_OPTIMIZER_RUNS: "1", FOUNDRY_VIA_IR: "true", FOUNDRY_EVM_VERSION: "prague", FOUNDRY_OFFLINE: "true", FOUNDRY_FUZZ_RUNS: "256",
  // the reserve allows ONE lease operation per transaction (transient storage): every top-level call of a Foundry test is
  // its own transaction, at the 5 gwei the gas-price cap tests assume (test/lease-gas/forge/test/LeaseExecutor.t.sol)
  FOUNDRY_ISOLATE: "true", FOUNDRY_GAS_PRICE: "5000000000" });
/** Every file the build compiles: World.sol, the Foundry test (MockBook, SessionVault) and every source they import. */
export const INPUTS = ["test/lease-gas/forge/sol/World.sol", "test/lease-gas/forge/sol/MockUSDC.sol", "test/lease-gas/forge/sol/MockFeed.sol",
  "test/lease-gas/forge/sol/SpoofOperator.sol", "test/lease-gas/forge/test/LeaseExecutor.t.sol", "test/fixtures/ledger-rev16d-source/EnclaveDeployments.sol",
  "test/fixtures/registry-schema4/EnclaveRegistry.sol", "contracts/EnclaveLeaseGasReserve.sol", "contracts/EnclaveLeaseExecutor.sol",
  "contracts/EnclaveHostPaymaster.sol", "contracts/SessionVault.sol", "foundry.toml"];
export const haveForge = (() => { try { execFileSync("forge", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const forgeEnv = (dir) => {
  const env = { ...process.env, ...SETTINGS, FOUNDRY_OUT: path.join(dir, "out"), FOUNDRY_CACHE_PATH: path.join(dir, "cache") };
  for (const k of Object.keys(env)) if (k.startsWith("FOUNDRY_") && !(k in SETTINGS) && !["FOUNDRY_OUT", "FOUNDRY_CACHE_PATH"].includes(k)) delete env[k];
  return env;
};

let cached = null;
/** -> the forge `out` directory holding <Source>.sol/<Contract>.json for every contract the tests deploy */
export function leaseGasForgeOut() {
  if (cached) return cached;
  const h = createHash("sha256").update(JSON.stringify(SETTINGS));
  for (const f of INPUTS) h.update(f + "\0").update(fs.readFileSync(path.join(REPO, f))).update("\0");
  const final = path.join(os.tmpdir(), `enclave-lease-gas-forge-${h.digest("hex").slice(0, 20)}`);
  if (!fs.existsSync(path.join(final, "out", ".complete"))) {
    const tmp = fs.mkdtempSync(final + ".building-");
    try {
      execFileSync("forge", ["build", "--root", REPO], { env: forgeEnv(tmp), stdio: ["ignore", "ignore", "pipe"] });
      // a build that compiled nothing (a wrong source path) must fail here, not as missing artifacts later
      for (const want of ["EnclaveDeployments.sol/EnclaveDeployments.json", "EnclaveRegistry.sol/EnclaveRegistry.json", "EnclaveLeaseGasReserve.sol/EnclaveLeaseGasReserve.json",
        "EnclaveLeaseExecutor.sol/EnclaveLeaseExecutor.json", "LeaseExecutor.t.sol/MockBook.json", "SessionVault.sol/SessionVault.json", "MockFeed.sol/MockFeed.json"])
        if (!fs.existsSync(path.join(tmp, "out", want))) throw new Error(`forge build produced no ${want}`);
      fs.writeFileSync(path.join(tmp, "out", ".complete"), INPUTS.join("\n") + "\n");
      try { fs.renameSync(tmp, final); } catch (e) { if (!fs.existsSync(path.join(final, "out", ".complete"))) throw e; }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return (cached = path.join(final, "out"));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "test") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-lease-gas-forge-test-"));
  try {
    const r = spawnSync("forge", ["test", "--root", REPO, ...process.argv.slice(3)], { env: forgeEnv(dir), encoding: "utf8" });
    process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
    const ran = /Ran \d+ test suites?.*?(\d+) tests passed, (\d+) failed/s.exec(r.stdout || "");
    // zero tests is a failure: an empty run must never read as a pass
    if (r.status === 0 && (!ran || Number(ran[1]) === 0)) { console.error("forge test ran no tests"); process.exitCode = 1; } else process.exitCode = r.status ?? 1;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
