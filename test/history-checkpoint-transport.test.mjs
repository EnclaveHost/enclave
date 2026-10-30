// Attested history checkpoints, the owner's side (work/history-checkpoint-transport-interface.txt):
//   - the package's optional "checkpoints" member (mirror URLs): the SDK and the browser build the SAME bytes, refuse a
//     credential or a non-committable URL in it, and say what a mirror is and is not; the guest's verdicts on the shared
//     history vectors are in Go (TestOwnerHistoryAgreesWithJavaScriptVectors) and in history-owner-tools.test.mjs;
//   - the shared checkpoint vectors (isolation/m2/bootstrap/testdata/checkpoint-vectors.json, a SYNTHETIC AMD-shaped chain;
//     Go: TestCheckpointVectorsAgreeWithJavaScript): the owner's verifier (verifier/history-checkpoint.mjs) reaches the
//     guest's verdict on every one; the browser's check (site/js/core/history-checkpoint.js) refuses every structural,
//     binding and scope refusal and says it did not judge the evidence; the real AMD pins refuse the synthetic root;
//   - collateral: an envelope as the producer serves it (no certificates, no CRL) is completed from a collateral source and
//     verifies; a stale CRL is refused and verifies once refreshed.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as SDK from "../sdk/bootstrap/package.mjs";
import { parseCheckpoint, verifyCheckpoint, completeCollateral, checkpointReportData, CHECKPOINT_PATH } from "../verifier/history-checkpoint.mjs";
import { memoryCollateral } from "../verifier/collateral.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cv = JSON.parse(fs.readFileSync(path.join(REPO, "isolation/m2/bootstrap/testdata/checkpoint-vectors.json"), "utf8"));
const scope = { chainId: cv.chainId, ledger: cv.ledger, deployment: cv.deployment };
const roots = new Map([["Genoa", cv.arkSha256]]);
const now = new Date(cv.now);
const P = "https://base-rpc.polkachu.com", T = "https://gateway.tenderly.co/public/base";
let SP, CP;
before(async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem(){}, removeItem(){} };
  globalThis.sessionStorage ??= globalThis.localStorage;
  globalThis.location ??= { hostname: "localhost" };
  SP = await import(pathToFileURL(path.join(REPO, "site/js/core/startup-package.js")).href);
  CP = await import(pathToFileURL(path.join(REPO, "site/js/core/history-checkpoint.js")).href);
});

test("checkpoint mirrors: the SDK and the browser build the same member, refuse credentials, and say what a mirror is", async () => {
  const mirrors = "https://owner.example.net/cp\nhttps://mirror.example.org/checkpoints/d1.json";
  const sdk = SDK.historyFromList(`${T},${P}`, { checkpoints: mirrors.split("\n").reverse() });
  const site = SP.historyFromForm({ rpcsText: `${T}\n${P}`, checkpointsText: mirrors });
  assert.deepEqual(sdk, { rpcs: [P, T], checkpoints: ["https://mirror.example.org/checkpoints/d1.json", "https://owner.example.net/cp"] });
  assert.deepEqual(site, sdk);
  assert.deepEqual(Object.keys(sdk), ["rpcs", "checkpoints"], "the mirrors follow the sources");
  // mirrors alone are a valid member; without sources the owner is told what the tail needs
  const only = SDK.historyFromList("", { checkpoints: "https://owner.example.net/cp" });
  assert.deepEqual(only, { checkpoints: ["https://owner.example.net/cp"] });
  assert.deepEqual(SP.historyFromForm({ rpcsText: "", checkpointsText: "https://owner.example.net/cp" }), only);
  for (const w of [SDK.historyWarnings(only), SP.historyWarnings(only)]){
    assert.ok(w.some((x) => /SEV-SNP direct guests of the SAME measured build|same measured build/i.test(x)), "the scope: SNP only, same build");
    assert.ok(w.some((x) => /without history sources/i.test(x)));
  }
  // an older member's warnings are unchanged (no mirrors, nothing new said)
  assert.deepEqual(SDK.historyWarnings({ rpcs: [P, T] }), []);
  assert.deepEqual(SP.historyWarnings({ rpcs: [P, T] }), []);
  // none of these is ever committed: the package is published
  for (const [bad, why] of [["https://u:p@mirror.example.org/cp", /credentials/], ["https://mirror.example.org/cp?sig=abc", /query/],
    ["http://mirror.example.org/cp", /https/], ["https://mirror.example.org:8443/cp", /no port/], ["https://192.0.2.1/cp", /lowercase DNS name/],
    ["https://mirror.example.org/v1/Ab3dE5gH7jK9mN1pQ3sT", /provider key/]]){
    assert.throws(() => SDK.historyFromList(P, { checkpoints: bad }), why, bad);
    assert.throws(() => SP.historyFromForm({ rpcsText: P, checkpointsText: bad }), why, bad);
  }
  assert.deepEqual(SDK.historyFromList(P, { checkpoints: "https://mirror.example.org/v1/Ab3dE5gH7jK9mN1pQ3sT", pathIsPublic: true }).checkpoints, ["https://mirror.example.org/v1/Ab3dE5gH7jK9mN1pQ3sT"]);
  assert.throws(() => SDK.historyFromList(P, { checkpoints: "https://a.example/c,https://b.example/c,https://c.example/c,https://d.example/c,https://e.example/c" }), /1 to 4 checkpoint mirrors/);
  // the same bytes from either builder, appended last, and an older package's exact bytes without them
  const base = { version: 1, chainId: 8453, ledger: "0x" + "ab".repeat(20), deployment: "0x" + "0d".repeat(32), owner: "0x" + "11".repeat(20), appRef: "catalog://0x" + "5a".repeat(32) + "/3",
    appId: "a1".repeat(32), runtimeId: "b2".repeat(32), configText: "{}", secretsMode: "public" };
  const a = SDK.preparePackage({ ...base, history: sdk });
  const b = await SP.preparePackage({ chainId: base.chainId, ledger: base.ledger, deployment: base.deployment, owner: base.owner, appRef: base.appRef },
    { appId: base.appId, runtimeId: base.runtimeId, configText: "{}", history: site });
  assert.equal(Buffer.from(b.bytes).toString(), a.bytes.toString());
  assert.equal(Object.keys(JSON.parse(a.bytes)).at(-1), "history");
});

test("the owner's verifier reaches the guest's verdict on every shared checkpoint vector; the real AMD pins refuse the synthetic root", async () => {
  assert.ok(cv.cases.length >= 15);
  for (const c of cv.cases){
    const v = await verifyCheckpoint(Buffer.from(c.envelope), { ...scope, measurement: cv.measurement, now, roots });
    assert.equal(v.status === "verified", c.valid, `${c.name}: ${v.reasons.at(-1)}`);
    if (!c.valid) assert.match(v.reasons.at(-1), new RegExp(c.why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), c.name);
  }
  const real = await verifyCheckpoint(Buffer.from(cv.cases[0].envelope), { ...scope, measurement: cv.measurement, now });
  assert.equal(real.status, "rejected");
  assert.match(real.reasons.at(-1), /not AMD's pinned Genoa root/);
  // without an expected measurement nothing about the AMD evidence is claimed
  const blind = await verifyCheckpoint(Buffer.from(cv.cases[0].envelope), { ...scope, now, roots });
  assert.equal(blind.status, "unverified");
  assert.match(blind.reasons.at(-1), /NOT VERIFIED/);
  // the binding is exactly the guest's: sha256(domain || statement) || 32 zero bytes
  const cp = parseCheckpoint(Buffer.from(cv.cases[0].envelope), scope);
  assert.equal(Buffer.from(cp.report).subarray(0x50, 0x90).toString("hex"), checkpointReportData(cp.statementText).toString("hex"));
  assert.equal(CHECKPOINT_PATH, "/.well-known/enclave-history-checkpoint");
});

test("the browser's check refuses every structural, binding and scope refusal and never claims the evidence", async () => {
  const structural = /canonical|another chain, ledger or deployment|binding|host data|unknown member|not an unambiguous JSON object/;
  for (const c of cv.cases){
    let r = null, e = null;
    try { r = await CP.checkCheckpoint(c.envelope, scope); } catch (x){ e = x; }
    const verifier = await verifyCheckpoint(Buffer.from(c.envelope), { ...scope, now });   // no measurement: structure only
    if (!c.valid && structural.test(c.why)){
      assert.ok(e, `${c.name} passed the browser's check`);
      assert.match(e.message, new RegExp(c.why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), c.name);
      assert.equal(verifier.status, "rejected", c.name);
    } else {
      assert.ok(r, `${c.name}: ${e && e.message}`);
      assert.equal(r.notJudged, CP.NOT_JUDGED_HERE);
      assert.equal(verifier.status, "unverified", c.name);
      assert.equal(r.lo, 120); assert.equal(r.hi, 5000);
    }
  }
  assert.equal(CP.defaultFront(cv.deployment), "https://0de90100.app.enclave.host");
  // fetching: https only, the checkpoint path added, a 404 explained, redirects refused
  const seen = [];
  const fake = async (url, opts) => { seen.push([url, opts.redirect]); return { ok: false, status: 404, headers: new Map(), text: async () => "" }; };
  await assert.rejects(CP.fetchCheckpoint("https://0de90100.app.enclave.host", { fetchImpl: fake }), /no checkpoint yet/);
  assert.deepEqual(seen, [["https://0de90100.app.enclave.host/.well-known/enclave-history-checkpoint", "error"]]);
  await assert.rejects(CP.fetchCheckpoint("http://0de90100.app.enclave.host"), /https/);
});

test("collateral: the producer's bare envelope is completed and verifies; a stale CRL verifies only once refreshed; the statement's bytes never change", async () => {
  const kds = memoryCollateral({ chains: { Genoa: cv.kds.chain }, vceks: { Genoa: Buffer.from(cv.kds.vcek, "base64") }, crls: { Genoa: Buffer.from(cv.kds.crl, "base64") } });
  const opts = { ...scope, measurement: cv.measurement, now, roots };
  const bare = cv.cases.find((c) => c.bare), stale = cv.cases.find((c) => c.refresh);
  assert.equal((await verifyCheckpoint(Buffer.from(bare.envelope), opts)).status, "rejected");
  const done = await completeCollateral(Buffer.from(bare.envelope), scope, kds);
  assert.deepEqual(Object.keys(done.sources).sort(), ["chain", "crl", "vcek"]);
  assert.equal((await verifyCheckpoint(done.bytes, opts)).status, "verified");
  assert.equal(parseCheckpoint(done.bytes, scope).statementText, parseCheckpoint(Buffer.from(bare.envelope), scope).statementText);
  assert.match((await verifyCheckpoint(Buffer.from(stale.envelope), opts)).reasons.at(-1), /CRL is stale/);
  const kept = await completeCollateral(Buffer.from(stale.envelope), scope, kds);          // a CRL present is kept unless refreshing
  assert.match((await verifyCheckpoint(kept.bytes, opts)).reasons.at(-1), /CRL is stale/);
  const refreshed = await completeCollateral(Buffer.from(stale.envelope), scope, kds, { refreshCrl: true });
  assert.deepEqual(Object.keys(refreshed.sources), ["crl"]);
  assert.equal((await verifyCheckpoint(refreshed.bytes, opts)).status, "verified");
  // a collateral source cannot make a wrong checkpoint right: completion refuses another deployment's before fetching
  const other = cv.cases.find((c) => /another deployment's genuine/.test(c.name));
  let asked = 0;
  const counting = { vcek: async () => { asked++; }, chain: async () => { asked++; }, crl: async () => { asked++; } };
  await assert.rejects(completeCollateral(Buffer.from(other.envelope), scope, counting), /another chain, ledger or deployment/);
  assert.equal(asked, 0);
  // a substituted chain from the "collateral source" fails at the pinned root
  const wrongRoot = memoryCollateral({ chains: { Genoa: cv.kds.chain.split(/(?=-----BEGIN)/)[0] + cv.kds.chain.split(/(?=-----BEGIN)/)[0] }, vceks: { Genoa: Buffer.from(cv.kds.vcek, "base64") }, crls: { Genoa: Buffer.from(cv.kds.crl, "base64") } });
  const swapped = await completeCollateral(Buffer.from(bare.envelope), scope, wrongRoot);
  assert.equal((await verifyCheckpoint(swapped.bytes, opts)).status, "rejected");
});
