// Provenance of what the app-funded lease tests deploy or etch on their local anvil (test/helpers/lease-gas-world.mjs):
// every contract SOURCE is the repository's own, and the live-ledger/registry/SessionVault sources are byte-for-byte the
// ones contracts/deployments/source-verification-base.json pins for the deployed contracts (sha256 AND git blob, so a
// copy can be matched to the repository history) - or, for a fixture the user-authorized history rewrite changed, its
// recorded published copy whose PROVENANCE.json names that pinned original. The third-party Base code snapshots carry the hash of the code they
// store. No compiled artifact of ours is kept in the repository: the tests build from these sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(REPO, f));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const gitBlob = (b) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
const manifest = JSON.parse(read("contracts/deployments/source-verification-base.json"));

test("the deployed-contract sources the lease tests compile are exactly the pinned build sources", () => {
  for (const [file, build, name] of [
    ["test/fixtures/ledger-rev16d-source/EnclaveDeployments.sol", "ledger-rev16d", "EnclaveDeployments.sol"],
    ["test/fixtures/registry-schema4/EnclaveRegistry.sol", "registry-schema4", "EnclaveRegistry.sol"],
    ["contracts/SessionVault.sol", "legacy-sessions-v2", "SessionVault.sol"]]) {
    const pin = manifest.builds[build]?.sources?.[name];
    assert.ok(pin, `${build} pins ${name}`);
    const bytes = read(file);
    // a fixture rewritten by the user-authorized history rewrite carries a PROVENANCE.json tying it to the pinned original
    // (comment-only change; test/cli-independent.test.mjs proves the executable is the deployed one)
    const provFile = path.join(path.dirname(file), "PROVENANCE.json");
    if (fs.existsSync(path.join(REPO, provFile))) {
      const prov = JSON.parse(read(provFile));
      assert.equal(prov.file, file);
      assert.equal(sha256(bytes), prov.published.sha256, `${file} sha256 (published copy)`);
      assert.equal(gitBlob(bytes), prov.published.gitBlob, `${file} git blob (published copy)`);
      assert.deepEqual([prov.original.sha256, prov.original.gitBlob], [pin.sha256, pin.gitBlob], `${file}: its recorded original is the pinned build source`);
      continue;
    }
    assert.equal(sha256(bytes), pin.sha256, `${file} sha256`);
    assert.equal(gitBlob(bytes), pin.gitBlob, `${file} git blob`);
  }
  assert.equal(manifest.builds["ledger-rev16d"].commit, "4b7419bb0955ffd02a6ce8d75809dac0a18f302f");
  assert.equal(manifest.contracts.deployments.address, "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b");
  assert.equal(manifest.contracts.registry.address, "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac");
});

test("the Foundry project compiles repository sources only, and no compiled output is committed", async () => {
  const world = read("test/lease-gas/forge/sol/World.sol").toString();
  for (const imp of world.matchAll(/from "([^"]+)"/g)) assert.ok(fs.existsSync(path.resolve(REPO, "test/lease-gas/forge/sol", imp[1])), imp[1]);
  for (const d of ["test/lease-gas/forge/out", "test/lease-gas/forge/cache"]) assert.equal(fs.existsSync(path.join(REPO, d)), false, `${d} is never kept`);
  const { SETTINGS, INPUTS } = await import("./helpers/lease-gas-forge.mjs");
  assert.deepEqual([SETTINGS.FOUNDRY_SRC, SETTINGS.FOUNDRY_SOLC_VERSION, SETTINGS.FOUNDRY_VIA_IR, SETTINGS.FOUNDRY_OPTIMIZER_RUNS], ["test/lease-gas/forge/sol", "0.8.35", "true", "1"]);
  for (const f of INPUTS) assert.ok(fs.existsSync(path.join(REPO, f)), `build input ${f}`);
});

test("the Base code snapshots are the pinned canonical contracts and hold the code their hashes name", () => {
  const aa = JSON.parse(read("test/fixtures/base-code/aa-code-base.json")), safe = JSON.parse(read("test/fixtures/base-code/safe-code-base.json"));
  const sponsor = read("windows/node/sponsor.mjs").toString(), relay = read("relay/host-sponsor.mjs").toString();
  for (const src of [sponsor, relay]) {
    assert.ok(src.includes(`"${aa.contracts.entryPoint08.address}"`), "EntryPoint v0.8 is the address the repository pins");
    assert.ok(src.includes(`"${aa.contracts.simple7702Account.address}"`), "Simple7702Account is the address the repository pins");
  }
  for (const snap of [aa, safe]) {
    assert.equal(snap.chainId, 8453); assert.ok(Number.isSafeInteger(snap.block) && snap.block > 0); assert.equal(snap.rpcs.length, 2);
    for (const [name, c] of Object.entries(snap.contracts)) {
      const bytes = Buffer.from(c.code.slice(2), "hex");
      assert.ok(/^0x[0-9a-fA-F]{40}$/.test(c.address), name);
      assert.equal(bytes.length, c.runtimeBytes, `${name} length`);
      assert.equal(keccak256(c.code), c.keccak256, `${name} keccak256 (the chain's EXTCODEHASH)`);
      assert.equal(sha256(bytes), c.sha256, `${name} sha256`);
    }
  }
  assert.equal(safe.version, "1.4.1"); assert.match(safe.proxyCreationCode, /^0x[0-9a-f]+$/);
});
