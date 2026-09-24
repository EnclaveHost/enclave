// test/verifier-linux-derivation.test.mjs: the catalog bundle derivation the Linux per-app tier runs
// (enclave-catalog-bundle/1: a wasi:http component the runtime serves; /2: a wasi:cli command serving HTTP on ONE
// declared port), replayed through the isolation owner's PINNED reference (derive_reference.py beside the
// linux-domain-contract pin) on its own vectors, never restated here. Proves: the pinned reference regenerates the
// pinned vectors byte for byte; every accepted vector derives to its recorded AppID and bundle hash, a v2 record is
// another AppID for the same component, and a v1 bundle carries no http field (so pre-v2 bundles keep their bytes);
// every refused vector is refused; the canary's v1 record still validates; and the record shapes a supervisor could
// send over JSON that the owner's list does not name (a string, float, boolean, null or negative port; a v1 record
// carrying http) are refused too.
//   run: node --test test/verifier-linux-derivation.test.mjs   (strict: ENCLAVE_DOMAIN_CONTRACT must point at the pinned contract)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
const contractPath = process.env.ENCLAVE_DOMAIN_CONTRACT || (fs.existsSync(new URL("../isolation/contract/runtime.mjs", import.meta.url)) ? new URL("../isolation/contract/runtime.mjs", import.meta.url).pathname : null);
if (STRICT && !process.env.ENCLAVE_DOMAIN_CONTRACT) throw new Error("strict integration: ENCLAVE_DOMAIN_CONTRACT (the pinned isolation/contract/runtime.mjs) is not set");
const skip = !contractPath && "the isolation owner's runtime contract is not pinned here (ENCLAVE_DOMAIN_CONTRACT) and not in this tree";
const catalogDir = contractPath ? path.join(path.dirname(contractPath), "catalog") : null;
const REF = catalogDir && path.join(catalogDir, "derive_reference.py"), VEC = catalogDir && path.join(catalogDir, "derive_vectors.json");
const V1 = "enclave-catalog-bundle/1", V2 = "enclave-catalog-bundle/2";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const SCRATCH = new URL("../.verifier-integration/", import.meta.url).pathname;   // gitignored, beside the pins (not /tmp)

// one call of the pinned reference on a record and a component: {ok, mapping, bundle} or {ok: false, stderr}
function derive(record, component) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "derive-test-"));
  try {
    const rec = path.join(tmp, "record.json"), comp = path.join(tmp, "component.wasm"), out = path.join(tmp, "out.bundle");
    fs.writeFileSync(rec, JSON.stringify(record)); fs.writeFileSync(comp, component);
    const r = spawnSync("python3", [REF, "bundle", rec, comp, out], { encoding: "utf8" });
    if (r.status !== 0) return { ok: false, status: r.status, stderr: String(r.stderr) };
    return { ok: true, mapping: JSON.parse(r.stdout), bundle: fs.readFileSync(out) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const vectors = skip ? null : JSON.parse(fs.readFileSync(VEC, "utf8"));
const component = skip ? null : Buffer.from(vectors.component_hex, "hex");
const base = () => vectors.ok.find((v) => v.name === "v1");

test("the pinned reference regenerates the pinned vectors byte for byte", { skip }, () => {
  const out = execFileSync("python3", [REF, "vectors"]);
  assert.ok(out.equals(fs.readFileSync(VEC)), "derive_reference.py vectors differs from derive_vectors.json at the pin");
  assert.ok(vectors.ok.length >= 6 && vectors.refused.length >= 11, `vectors: ${vectors.ok.length} accepted, ${vectors.refused.length} refused`);
});

test("every accepted vector derives to its recorded AppID and bundle; v2 is another AppID for the same component", { skip }, () => {
  for (const v of vectors.ok) {
    const r = derive(v.record, component);
    assert.ok(r.ok, `${v.name}: ${r.stderr}`);
    assert.equal(r.mapping.appId, v.mapping.appId, v.name);
    assert.equal(sha256(r.bundle), v.bundleSha256, `${v.name}: bundle hash`);
    assert.equal(r.mapping.appId, sha256(r.bundle), `${v.name}: appId is sha256(bundle)`);
    assert.equal(r.mapping.record.derivation, v.record.derivation, v.name);
    assert.equal(r.mapping.record.http, v.record.derivation === V2 ? v.record.http : undefined, `${v.name}: the mapping's record carries http only under v2`);
  }
  const v1 = base(), v2s = vectors.ok.filter((v) => v.record.derivation === V2);
  assert.ok(v1 && v2s.length >= 2, "the vectors carry the base v1 case and at least two v2 cases");
  for (const v of v2s) assert.notEqual(v.mapping.appId, v1.mapping.appId, `${v.name}: a v2 AppID differs from v1's for the same component and policy`);
  assert.notEqual(v2s[0].mapping.appId, v2s[1].mapping.appId, "two ports are two AppIDs");
  // the world and the port are in the bundle bytes themselves (the AppID's preimage), and a v1 bundle has no http field
  const r2 = derive(v2s[0].record, component), r1 = derive(v1.record, component);
  assert.ok(r2.bundle.includes(Buffer.from(`"http":${v2s[0].record.http}`)) && r2.bundle.includes(Buffer.from('"world":"wasi:cli"')), "the v2 bundle's manifest carries world wasi:cli and the port");
  assert.ok(!r1.bundle.includes(Buffer.from('"http"')) && r1.bundle.includes(Buffer.from('"world":"wasi:http"')), "a v1 bundle carries no http field (pre-v2 bundles keep their bytes)");
});

test("every refused vector is refused by the pinned reference, the v2 port rules among them", { skip }, () => {
  for (const v of vectors.refused) {
    const r = derive(v.record, Buffer.from(v.component_hex, "hex"));
    assert.equal(r.ok, false, `${v.name}: accepted`);
  }
  const names = vectors.refused.map((v) => v.name);
  for (const n of ["v1 naming a port", "v2 naming no port", "v2 port out of range", "v2 port zero", "unknown derivation version"]) assert.ok(names.includes(n), `the pinned vectors refuse: ${n}`);
});

test("the canary's v1 record still validates under the pinned reference (its AppID is the component's, checked live by --derive)", { skip }, () => {
  const rec = JSON.parse(fs.readFileSync(new URL("./fixtures/verifier/linux-canary-2026-09-24/record.json", import.meta.url), "utf8"));
  assert.equal(rec.derivation, V1);
  const r = derive(rec, component);            // the vectors' component: proves the RECORD's shape, not this AppID
  assert.ok(r.ok, r.stderr);
  assert.deepEqual(r.mapping.record, { derivation: rec.derivation, catalog: rec.catalog, cid: rec.cid, policy: rec.policy, runtimeId: rec.runtimeId });
  assert.equal(derive({ ...rec, derivation: V2, http: 8000 }, component).mapping.appId !== r.mapping.appId, true, "the same record as a v2 command is another AppID");
});

test("record shapes a supervisor could send over JSON, beyond the owner's list: refused", { skip }, () => {
  const good = base().record;
  const cases = [
    ["v2 port as a string", { ...good, derivation: V2, http: "8000" }],
    ["v2 port as a float", { ...good, derivation: V2, http: 8000.5 }],
    ["v2 port true", { ...good, derivation: V2, http: true }],
    ["v2 port null", { ...good, derivation: V2, http: null }],
    ["v2 port negative", { ...good, derivation: V2, http: -8000 }],
    ["v2 port 50000", { ...good, derivation: V2, http: 50000 }],
    ["v1 carrying http null", { ...good, http: null }],
    ["v1 carrying http 0", { ...good, http: 0 }],
    ["derivation /3", { ...good, derivation: "enclave-catalog-bundle/3" }],
  ];
  for (const [name, rec] of cases) {
    const r = derive(rec, component);
    assert.equal(r.ok, false, `${name}: accepted`);
    assert.match(r.stderr, /http|derivation/, `${name}: refused for another reason: ${r.stderr.slice(-200)}`);
  }
  assert.equal(derive({ ...good, derivation: V2, http: 49999 }, component).ok, true, "port 49999 (the top of the range) is accepted");
  assert.equal(derive({ ...good, derivation: V2, http: 1 }, component).ok, true, "port 1 (the bottom of the range) is accepted");
});
