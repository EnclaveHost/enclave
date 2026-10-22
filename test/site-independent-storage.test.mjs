// Independent dashboard uploads and owner-committed startup, browser modules against the CLI's own implementations:
// the same CIDs as sdk/storage/unixfs.mjs, the same startup bytes/envelope as sdk/bootstrap/package.mjs and
// cli/enclave.mjs cmdBootstrap, and storage-plan publication that counts only exact-byte readback.
//   run: node --test test/site-independent-storage.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifactIdentity, rawCid, CHUNK_BYTES } from "../site/js/core/unixfs.js";
import { artifactIdentity as cliIdentity } from "../sdk/storage/unixfs.mjs";
import * as cliPkg from "../sdk/bootstrap/package.mjs";
const { packageCID, preparePackage: cliPrepare, verifyPackage: cliVerify, parseUniqueJSON } = cliPkg;
import { publishToPlan, verifyOnPlan, publishPackageToPlan } from "../site/js/core/storage-plan.js";
import { uploadMessage } from "../site/js/core/upload-auth.js";
import { preparePackage, verifyPackage, activationEnvelope, committedIntent, readCommitted, PREPARE_ONLY_ENVELOPE } from "../site/js/core/startup-package.js";

test("browser CIDs equal the CLI importer at chunk and tree boundaries", async () => {
  const sizes = [0, 1, 1000, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * CHUNK_BYTES + 7, 174 * CHUNK_BYTES, 175 * CHUNK_BYTES + 3];
  for (const n of sizes){
    const bytes = new Uint8Array(n); for (let i = 0; i < n; i++) bytes[i] = (i * 2654435761) >>> 24;
    assert.deepEqual(await artifactIdentity(bytes), cliIdentity(bytes), "size " + n);
  }
  const h = createHash("sha256").update("package").digest("hex");
  assert.equal(rawCid(h), packageCID(h));
});

/* Fake adapters for the storage plan: each verifies the wallet signature exactly as the adapter does (route,
   audience, sha256, size, expiry), answers a CID, and serves ranges back - or misbehaves as told. */
const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const signer = { address: owner.address.toLowerCase(), signMessage: ({ message }) => owner.signMessage({ message }) };
const plan3 = {
  version: 1, minimumCopies: 2, replicas: ["a", "b", "c"].map((x, i) => ({
    upload: `https://store-${x}.example/add-json`, audience: "0x" + String(i + 1).padStart(2, "0").repeat(32), gateway: `https://store-${x}.example/ipfs` })),
};
function adapters(behavior = {}){
  const held = new Map(), seen = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), host = u.hostname.split(".")[0].replace("store-", ""), how = behavior[host] || "ok";
    seen.push([init.method || "GET", u.hostname, u.pathname]);
    if (how === "down") throw new TypeError("fetch failed");
    if (init.method === "POST"){
      if (how === "refuse") return new Response('{"error":"full"}', { status: 507 });
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      const h = init.headers, i = ["a", "b", "c"].indexOf(host);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const msg = uploadMessage({ audience: plan3.replicas[i].audience, path: u.pathname, address: h["x-upload-address"], hash: h["x-upload-sha256"],
        size: bytes.length, expiry: Number(h["x-upload-expiry"]) });
      const who = (await recoverMessageAddress({ message: msg, signature: h["x-upload-signature"] })).toLowerCase();
      if (who !== h["x-upload-address"] || h["x-upload-sha256"] !== sha) return new Response('{"error":"bad signature"}', { status: 401 });
      const id = u.pathname === "/add-json" && bytes.length <= CHUNK_BYTES ? cliIdentity(bytes) : cliIdentity(bytes);
      held.set(host + id.cid, how === "corrupt" ? bytes.map((b, k) => (k === 0 ? b ^ 1 : b)) : bytes);
      return Response.json({ cid: how === "wrongcid" ? "bafkwrong" : id.cid });
    }
    const cid = u.pathname.split("/").pop(), bytes = held.get(host + cid);
    if (!bytes) return new Response("missing", { status: 404 });
    const m = /bytes=(\d+)-(\d+)/.exec((init.headers || {}).range || "");
    if (!m) return new Response(bytes, { status: 200 });
    const s = Number(m[1]), e = Math.min(Number(m[2]), bytes.length - 1);
    return new Response(bytes.slice(s, e + 1), { status: 206, headers: { "content-range": `bytes ${s}-${e}/${bytes.length}` } });
  };
  return { fetchImpl, seen, held };
}

test("a verified copy needs the local CID AND every byte read back; two of three is enough, one is not", async () => {
  const bytes = new Uint8Array(5 * 1024 * 1024 + 11).map((_, i) => i % 251);
  const ok = adapters({ c: "refuse" });
  const r = await publishToPlan(bytes, "wasm", plan3, signer, { fetchImpl: ok.fetchImpl });
  assert.equal(r.verifiedCopies, 2); assert.equal(r.cid, cliIdentity(bytes).cid);
  assert.equal(r.failures[0].upload, plan3.replicas[2].upload);
  assert.equal(r.independentOperatorsVerified, false, "distinct names never claim distinct operators");
  assert.ok(ok.seen.every(([m, , p]) => m !== "POST" || p === "/add-wasm"), "wasm goes to /add-wasm on each adapter");
  assert.ok(!ok.seen.some(([, h]) => /enclave\.host/.test(h)), "no Enclave service is contacted");
  for (const bad of [{ b: "corrupt", c: "refuse" }, { b: "wrongcid", c: "down" }]){
    const x = adapters(bad);
    await assert.rejects(publishToPlan(bytes, "wasm", plan3, signer, { fetchImpl: x.fetchImpl }),
      (e) => /1 of 2 required copies/.test(e.message) && e.report.verifiedCopies === 1);
  }
  // re-verification without uploading or signing
  const v = await verifyOnPlan(bytes, plan3, { fetchImpl: ok.fetchImpl });
  assert.equal(v.verifiedCopies, 2);
});

test("a declined signature uploads nothing anywhere", async () => {
  const x = adapters();
  let n = 0;
  const declining = { address: signer.address, signMessage: async (a) => { if (++n === 2) throw Object.assign(new Error("User rejected"), { code: 4001 }); return signer.signMessage(a); } };
  await assert.rejects(publishToPlan(new Uint8Array([1, 2, 3]), "json", plan3, declining, { fetchImpl: x.fetchImpl }), /rejected/);
  assert.equal(x.seen.length, 0);
});

const scope = { chainId: 8453, ledger: "0x" + "22".repeat(20), deployment: "0x" + "ab".repeat(32), owner: "0x" + "77".repeat(20), appRef: "catalog://0x" + "cd".repeat(32) + "/0" };
const ids = { appId: "a1".repeat(32), runtimeId: "b2".repeat(32) };

test("startup packages are byte-identical to the CLI's and pass its verifier", async () => {
  for (const custody of [null, { v: 2, chainId: 8453, vault: "0x" + "99".repeat(20), policy: "0x" + "88".repeat(32) }]){
    const mine = await preparePackage(scope, { ...ids, configText: '{"model":"x"}', custody });
    const cli = cliPrepare({ version: 1, ...scope, ...ids, configText: '{"model":"x"}', secretsMode: custody ? "custody-v2" : "public", ...(custody ? { custody } : {}) });
    assert.equal(Buffer.from(mine.bytes).toString(), cli.bytes.toString());
    assert.equal(mine.sha256, cli.sha256); assert.equal(mine.cid, cli.cid);
    assert.ok(cliVerify(Buffer.from(mine.bytes), mine.intent, scope));
  }
  const pkg = await preparePackage(scope, { ...ids, configText: "{}" });
  const tampered = pkg.bytes.slice(); tampered[tampered.length - 3] ^= 1;
  await assert.rejects(verifyPackage(tampered, pkg.intent, scope), /hash mismatch/);
  await assert.rejects(verifyPackage(pkg.bytes, pkg.intent, { ...scope, owner: "0x" + "78".repeat(20) }), /owner mismatch/);
  await assert.rejects(preparePackage(scope, { ...ids, appId: "00".repeat(32), configText: "{}" }), /App ID/);
  await assert.rejects(preparePackage(scope, { ...ids, configText: "[1" }), /JSON|Unexpected|position/);
});

test("activation replaces legacy config, keeps other options and requires the direct SNP runtime - as the CLI does", () => {
  const intent = { version: 1, sha256: "c3".repeat(32) };
  const current = JSON.stringify({ waf: { rps: 5 }, config: { a: 1 }, configCid: "bafy", isolation: { tee: "x" }, network: { routes: 1 } });
  // the CLI's own transformation (cli/enclave.mjs cmdBootstrap activate)
  const cur = parseUniqueJSON(current); delete cur.config; delete cur.configCid;
  cur.guestBootstrap = intent; cur.isolation = { ...(cur.isolation || {}), require: "snp-guest-per-app" };
  assert.equal(activationEnvelope(current, intent), JSON.stringify(cur));
  assert.equal(activationEnvelope("", intent), JSON.stringify({ guestBootstrap: intent, isolation: { require: "snp-guest-per-app" } }));
  assert.throws(() => activationEnvelope(JSON.stringify({ waf: { pad: "x".repeat(4100) } }), intent), /4096/);
  assert.deepEqual(committedIntent(activationEnvelope(current, intent)), intent);
  assert.deepEqual(committedIntent(JSON.stringify(PREPARE_ONLY_ENVELOPE)), { disabled: true });
  assert.equal(committedIntent('{"waf":{}}'), null);
});

test("startup publication counts only exact readback, and the committed bytes are re-read by raw CID", async () => {
  const pkg = await preparePackage(scope, { ...ids, configText: "{}" });
  const x = adapters({ a: "corrupt" });
  const rep = await publishPackageToPlan(pkg.bytes, plan3, signer, { fetchImpl: x.fetchImpl });
  assert.equal(rep.verifiedCopies, 2); assert.equal(rep.cid, pkg.cid);
  assert.ok(x.seen.filter(([m]) => m === "POST").every(([, , p]) => p === "/add-json"));
  const back = await readCommitted(pkg.intent, scope, plan3.replicas.map((r) => r.gateway), { fetchImpl: x.fetchImpl });
  assert.deepEqual(back.verified, [plan3.replicas[1].gateway, plan3.replicas[2].gateway]);
  assert.deepEqual(back.failed, [plan3.replicas[0].gateway], "the corrupted copy is not counted");
  assert.equal(back.manifest.appId, ids.appId);
});

// Owner-committed names are another workstream's schema (sdk/bootstrap/package.mjs validateNames). The browser only
// reads them back and carries them over unchanged; this pins that its copy of the check agrees with the SDK's.
test("committed custom names are accepted, preserved byte-for-byte and checked like the SDK does", { skip: typeof cliPkg.validateNames !== "function" && "the SDK has no owner names yet" }, async () => {
  const names = { hosts: ["app.example.org", "www.example.org"], acme: { directory: "https://acme.example/dir", challenge: "https://dns.example/v1", zone: "acme.example.net" } };
  const mine = await preparePackage(scope, { ...ids, configText: "{}", names });
  const cli = cliPrepare({ version: 1, ...scope, ...ids, configText: "{}", secretsMode: "public", names });
  assert.equal(Buffer.from(mine.bytes).toString(), cli.bytes.toString());
  assert.deepEqual((await verifyPackage(mine.bytes, mine.intent, scope)).manifest.names, names);
  const { validateNames } = await import("../site/js/core/startup-package.js");
  for (const bad of [{ hosts: [] }, { hosts: ["b.example.org", "a.example.org"] }, { hosts: ["x.enclave.host"] }, { hosts: ["a.example.org"], extra: 1 },
    { hosts: ["a.example.org"], acme: { directory: "http://acme.example", challenge: "https://c.example", zone: "z.example" } },
    { hosts: ["a.example.org"], acme: { directory: "https://acme.example", challenge: "https://c.example", zone: "z.example", eab: { kid: "K", hmac: "H" } } }]){
    let sdkErr = null, mineErr = null;
    try { cliPkg.validateNames(bad, "public"); } catch (e){ sdkErr = e.message; }
    try { validateNames(bad, "public"); } catch (e){ mineErr = e.message; }
    assert.ok(sdkErr && mineErr, JSON.stringify(bad) + " is refused by both");
  }
});
