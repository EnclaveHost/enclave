// r3: the relay selector against the ACTUAL committed KVM reader API (34a3c0d6d4c5, composed into the private 64156dcd + r2-patch
// copy as committed blobs). Not one of the 23 tests: a composition check that exits 0 only if every check holds. It starts nothing:
// KVM's own startDerivedReader refuses on an unqualified native pin before touching disk, which proves the selector's argument
// plumbing reaches the committed API. It is NOT a mainnet, witness or SNP proof.
// Usage: node api-composition-check.mjs <composed repo root> <private tmp dir>
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [R, TMP] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(path.join(R, p)).href);
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); };

const life = await imp("network/derived-reader/lifecycle.mjs");
const jm = await imp("network/deployment-lifecycle-journal.mjs");
const prov = await imp("network/derived-reader/provider.mjs");
const nat = await imp("network/derived-reader/native.mjs");
const sel = await imp("relay/derived-writer-authority.mjs");

await check("lifecycle exports startDerivedLifecycleReader", () => assert.equal(typeof life.startDerivedLifecycleReader, "function"));
await check("lifecycle journal has the bridge's readAnchor/acceptAnchor", () => {
  const j = jm.openLifecycleJournal(path.join(TMP, "anchor-journal.json"));
  assert.equal(typeof j.readAnchor, "function"); assert.equal(typeof j.acceptAnchor, "function"); assert.equal(j.readAnchor(8453), null);
});
await check("provider exports createDerivedProvider/startDerivedReader with readDerivedLogs (R3)", () => {
  assert.equal(typeof prov.createDerivedProvider, "function"); assert.equal(typeof prov.startDerivedReader, "function");
  assert.match(fs.readFileSync(path.join(R, "network/derived-reader/provider.mjs"), "utf8"), /async readDerivedLogs\(query = \{\}\)/);
});
await check("committed v3 build pin is root's native v3 binary 49f4d7e3", () =>
  assert.ok(nat.DERIVATION_V3_BUILDS["49f4d7e3e70e48f7374b0e12b3d300978062cce19cbd75552065f918173a76fa"]));
await check("relay selector -> committed startDerivedLifecycleReader: refused by KVM on an unqualified native pin, nothing created", async () => {
  const cfg = path.join(TMP, "reader.json"), state = path.join(TMP, "state");
  fs.writeFileSync(cfg, JSON.stringify({ stateDir: state, native: { resultVersion: 3, sha256: "00".repeat(32) }, maxAnchorAgeSec: 1800 }));
  const env = { ENCLAVE_WRITER_AUTHORITY_SOURCE: "derived", ENCLAVE_DERIVED_READER_CONFIG: cfg, ENCLAVE_DERIVED_ANCHOR_JOURNAL: path.join(TMP, "anchor-journal.json"),
    ENCLAVE_CHAIN_VERIFIER: "http://127.0.0.1:9", ADDRESS_BOOK_ADDRESS: "0x" + "77".repeat(20) };
  const stub = { getBlockNumber: async () => 0n, request: async () => [], readContract: async () => null };
  await assert.rejects(sel.derivedWriterAuthorityFromEnv(env, { relayChain: { client: stub },
    loadRuntime: async () => ({ startDerivedLifecycleReader: life.startDerivedLifecycleReader, openLifecycleJournal: jm.openLifecycleJournal }),
    readFile: (p, e) => fs.promises.readFile(p, e) }), /no qualified native derivation build configured/);
  assert.ok(!fs.existsSync(state), "no reader state was created");
});
await check("the writer's 120 s ceiling is independent of the reader config's 1800 s bridge bound", () => {
  assert.equal(sel.MAX_ANCHOR_AGE_SEC, 120);
  assert.throws(() => sel.createDerivedWriterAuthority({ capability: { snapshot() {}, readDerivedLogs() {} },
    fresh: { getBlockNumber() {}, request() {}, readContract() {} }, addressBook: "0x" + "77".repeat(20), maxAnchorAgeSec: 1800 }), /1\.\.120/);
});
console.log(JSON.stringify({ ok: true, checks: checks.length, names: checks }));
