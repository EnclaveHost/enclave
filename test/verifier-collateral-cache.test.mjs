// The authenticated, freshness-aware collateral cache (verifier/collateral-cache.mjs) in front of the SNP verifier: a cache
// must never make invalid collateral accepted, never make valid collateral unavailable, never hide staleness or
// revocation, and never store what it did not authenticate. Real Genoa fixtures for the cold, warm and offline paths;
// the synthetic AMD-shaped chain (test/helpers/snp-synth.mjs, pinned only by a test policy) for the stale-versus-fresh
// CRL and the revocation paths, since AMD's real CRL cannot be made stale or revoking on demand.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { verifyEvidence, spkiOfCert, httpCollateral } from "../verifier/index.mjs";
import { cachedCollateral, inspectCache } from "../verifier/collateral-cache.mjs";
import { synthChain, synthReport } from "./helpers/snp-synth.mjs";

const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const read = (u) => fs.readFileSync(u), text = (u) => fs.readFileSync(u, "utf8"), sha256 = (b) => createHash("sha256").update(b).digest("hex");
const rad = JSON.parse(text(new URL("genoa-tinfoil/rad.json", F))), report = gunzipSync(Buffer.from(rad.body, "base64"));
const certPem = text(new URL("genoa-tinfoil/tls-cert.pem", F)), { spki } = spkiOfCert(certPem);
const MEAS = report.subarray(0x90, 0xc0).toString("hex"), NOW = "2026-09-24T05:00:00Z";
const REAL = { chain: text(new URL("Genoa-cert_chain.pem", A)), milan: text(new URL("Milan-cert_chain.pem", A)), vcek: read(new URL("genoa-tinfoil/vcek-kds-amd.der", F)), turinVcek: read(new URL("turin-m4a/vcek-kds-amd.der", F)), crl: read(new URL("amd/Genoa-crl.der", F)) };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "collateral-cache-"));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const fresh = (n) => { const d = path.join(tmpRoot, n); fs.mkdirSync(d, { recursive: true }); return d; };

// an upstream whose answers and availability the test controls, counting calls
function upstream(bytes) {
  const calls = { chain: 0, vcek: 0, crl: 0 }, u = { kind: "stub", calls, down: false, serve: { ...bytes } };
  u.chain = async (p) => { calls.chain++; if (u.down) throw new Error("upstream down"); return { pem: u.serve.chain, source: "stub:chain", fetchedAt: "2026-09-24T04:00:00Z" }; };
  u.vcek = async () => { calls.vcek++; if (u.down) throw new Error("upstream down"); return { der: u.serve.vcek, source: "stub:vcek", fetchedAt: "2026-09-24T04:00:00Z" }; };
  u.crl = async () => { calls.crl++; if (u.down) throw new Error("upstream down"); if (u.serve.crl === null) return null; return { der: u.serve.crl, source: "stub:crl", fetchedAt: "2026-09-24T04:00:00Z" }; };
  return u;
}
let FLOOR = null;
const runReal = async (collateral, policy = {}) => { const v = await verifyEvidence(rad, { policy: { snp: { allowedMeasurements: [MEAS], ...(FLOOR ? { minTcb: FLOOR } : {}), ...policy } }, context: { transportKeySpki: spki, certPem, host: "inference.tinfoil.sh", now: NOW }, collateral }); if (!FLOOR && v.claims?.tcb) FLOOR = { Genoa: v.claims.tcb.reported }; return v; };
const plant = (dir, product, name, bytes, { sidecar = true } = {}) => { const f = path.join(dir, product, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); if (sidecar) fs.writeFileSync(`${f}.meta.json`, JSON.stringify({ sha256: sha256(bytes), source: "planted", fetchedAt: "2026-09-24T03:00:00Z" })); else fs.rmSync(`${f}.meta.json`, { force: true }); return f; };

test("cold, then warm, then offline: the first verification fetches and stores only authenticated bytes; the second answers from the cache with no network and the same verdict; the verdict states each piece's source", async () => {
  const dir = fresh("cold-warm"), u = upstream(REAL), c = cachedCollateral({ dir, upstream: u, now: () => new Date(NOW) });
  await runReal(c); const v1 = await runReal(c);   // the first call learns the floor
  assert.equal(v1.status, "verified", v1.reasons.join("\n"));
  assert.deepEqual(Object.fromEntries(Object.entries(v1.claims.collateral).map(([k, x]) => [k, [x.source, x.cached]])), { vcek: ["cache:" + path.join(dir, "Genoa", "vcek", `${v1.claims.chipId}-${report.subarray(0x180, 0x188).toString("hex")}.der`), true], chain: ["cache:" + path.join(dir, "Genoa", "chain.pem"), true], crl: ["cache:" + path.join(dir, "Genoa", "crl.der"), true] });
  assert.deepEqual(u.calls, { chain: 1, vcek: 1, crl: 1 }, "each piece fetched once");
  const entries = inspectCache(dir); assert.equal(entries.length, 3); assert.ok(entries.every((e) => e.sidecarMatches), "every stored entry has a sidecar whose sha256 matches");
  u.down = true; const v2 = await runReal(c);
  assert.equal(v2.status, "verified", v2.reasons.join("\n")); assert.deepEqual(u.calls, { chain: 1, vcek: 1, crl: 1 }, "no network at all with a warm cache");
  assert.equal(v2.claims.collateral.crl.stale, false); assert.equal(v2.claims.collateral.chain.fetchedAt, "2026-09-24T04:00:00Z");
});
test("a poisoned cached chain (another product's genuine chain) is quarantined and never served: refetched when the upstream answers, and the verification fails closed when it does not", async () => {
  const dir = fresh("poison-chain"), u = upstream(REAL), c = cachedCollateral({ dir, upstream: u, now: () => new Date(NOW) });
  await runReal(c); assert.equal(u.calls.chain, 1);
  const f = plant(dir, "Genoa", "chain.pem", Buffer.from(REAL.milan));
  const v = await runReal(c); assert.equal(v.status, "verified", v.reasons.join("\n")); assert.equal(u.calls.chain, 2, "refetched after the quarantine");
  assert.equal(c.stats.quarantined, 1); assert.match(c.events.find((e) => e.kind === "quarantined").why, /not AMD's pinned Genoa root/);
  assert.ok(fs.readdirSync(path.join(dir, "Genoa")).some((n) => /^chain\.pem\.rejected-\d+$/.test(n)), "the poisoned file is set aside, not served"); assert.equal(text(f), REAL.chain, "the slot holds the refetched genuine chain");
  plant(dir, "Genoa", "chain.pem", Buffer.from(REAL.milan)); u.down = true;
  const d = await runReal(c); assert.equal(d.status, "rejected"); assert.equal(d.checks.chain, false); assert.match(d.reasons.join("\n"), /AMD chain unavailable/);
});
test("a poisoned cached VCEK (another product's) is quarantined; a tampered or sidecar-less CRL is quarantined; with the upstream down the CRL policy decides and never accepts", async () => {
  const dir = fresh("poison-vcek-crl"), u = upstream(REAL), c = cachedCollateral({ dir, upstream: u, now: () => new Date(NOW) });
  await runReal(c);
  // the VCEK entry itself (a directory name may contain "vcek" too)
  const vf = inspectCache(dir).find((e) => /\/vcek\/[^/]+\.der$/.test(e.file)).file; fs.writeFileSync(vf, REAL.turinVcek); fs.writeFileSync(`${vf}.meta.json`, JSON.stringify({ sha256: sha256(REAL.turinVcek) }));
  let v = await runReal(c); assert.equal(v.status, "verified"); assert.equal(u.calls.vcek, 2); assert.match(c.events.find((e) => e.kind === "quarantined").why, /issuer CN is SEV-Turin/);
  const tampered = Buffer.from(REAL.crl); tampered[tampered.length - 10] ^= 0xff; plant(dir, "Genoa", "crl.der", tampered);
  v = await runReal(c); assert.equal(v.status, "verified"); assert.equal(u.calls.crl, 2); assert.match(c.events.filter((e) => e.kind === "quarantined").at(-1).why, /CRL signature does not verify/);
  plant(dir, "Genoa", "crl.der", REAL.crl, { sidecar: false }); v = await runReal(c); assert.equal(u.calls.crl, 3); assert.match(c.events.filter((e) => e.kind === "quarantined").at(-1).why, /sidecar missing/);
  plant(dir, "Genoa", "crl.der", tampered); u.down = true;
  const req = await runReal(c, { crl: "required" }); assert.equal(req.status, "rejected"); assert.equal(req.checks.crl, false); assert.match(req.reasons.join("\n"), /required by policy but none was supplied/);
  const lim = await runReal(c, { crl: "stale-ok", crlMaxStaleDays: 30 }); assert.equal(lim.status, "limited"); assert.deepEqual(lim.omissions, ["crl-revocation-unchecked"]); assert.equal(lim.admissionSafe, false);
  assert.equal(inspectCache(dir).some((e) => /crl\.der$/.test(e.file)), false, "nothing unauthenticated remains in the CRL slot");
});
test("a poisoned or garbage upstream answer is refused, not cached, and the verification fails closed", async () => {
  const dir = fresh("poison-upstream"), u = upstream({ ...REAL, chain: REAL.milan }), c = cachedCollateral({ dir, upstream: u, now: () => new Date(NOW) });
  const v = await runReal(c); assert.equal(v.status, "rejected"); assert.match(v.reasons.join("\n"), /(VCEK|AMD chain) unavailable: AMD chain from stub:chain failed authentication: .*pinned Genoa root/);
  assert.equal(inspectCache(dir).length, 0, "nothing written"); assert.equal(c.events.find((e) => e.kind === "upstream-refused") !== undefined, true);
  const u2 = upstream({ ...REAL, vcek: Buffer.from("not a certificate") }), c2 = cachedCollateral({ dir: fresh("garbage-vcek"), upstream: u2, now: () => new Date(NOW) });
  const w = await runReal(c2); assert.equal(w.status, "rejected"); assert.match(w.reasons.join("\n"), /VCEK unavailable: VCEK from stub:vcek failed authentication: VCEK unparseable/);
});
test("KDS rate limiting (HTTP 429) through the real http adapter: a cold cache fails closed, a warm cache never asks", async () => {
  let hits = 0; const fetchImpl = async () => { hits++; return { ok: false, status: 429, body: null }; };
  const kds = httpCollateral({ fetchImpl });
  const cold = cachedCollateral({ dir: fresh("kds-cold"), upstream: kds, now: () => new Date(NOW) });
  const v = await runReal(cold); assert.equal(v.status, "rejected"); assert.match(v.reasons.join("\n"), /HTTP 429/); assert.ok(hits >= 1);
  const dir = fresh("kds-warm"); const warmed = cachedCollateral({ dir, upstream: upstream(REAL), now: () => new Date(NOW) }); await runReal(warmed);
  hits = 0; const warm = cachedCollateral({ dir, upstream: kds, now: () => new Date(NOW) }); const w = await runReal(warm); assert.equal(w.status, "verified", w.reasons.join("\n")); assert.equal(hits, 0);
});
test("an unwritable cache directory is reported, never fatal and never a false hit; a leftover temp file is ignored", async () => {
  const dir = fresh("unwritable"); fs.chmodSync(dir, 0o500);
  const u = upstream(REAL), c = cachedCollateral({ dir, upstream: u, now: () => new Date(NOW) });
  try {
    const v = await runReal(c);
    if (process.getuid && process.getuid() === 0) { assert.ok(true, "root can write anywhere; the write-failure path is not reachable here"); return; }
    assert.equal(v.status, "verified", v.reasons.join("\n")); assert.ok(c.stats.writeFailures >= 1); assert.equal(v.claims.collateral.chain.cached, false);
    const before = u.calls.chain; const again = await runReal(c); assert.equal(again.status, "verified"); assert.ok(u.calls.chain > before, "a second run fetches again: nothing was stored, so nothing is a hit"); assert.equal(again.claims.collateral.chain.cached, false); assert.equal(inspectCache(dir).length, 0, "still nothing stored");
  } finally { fs.chmodSync(dir, 0o700); }
  const dir2 = fresh("tmpfile"); const c2 = cachedCollateral({ dir: dir2, upstream: upstream(REAL), now: () => new Date(NOW) }); await runReal(c2);
  fs.writeFileSync(path.join(dir2, "Genoa", "chain.pem.123-deadbeef.tmp"), "garbage"); const w = await runReal(c2); assert.equal(w.status, "verified"); assert.equal(w.claims.collateral.chain.cached, true);
});

// ---- synthetic chain: a CRL that can be stale, a fresher one under the same ARK, and one that revokes the ASK ----------
const S = synthChain({ crlDays: 1, extraCrlDays: [400], revokeAsk: true, extraVceks: 1 });
const SP = Buffer.from("302a300506032b6570032100" + "11".repeat(32), "hex"), NONCE = Buffer.from("22".repeat(32), "hex");
const synthDoc = { format: "sev-snp-guest-metal-v1", body: synthReport(S, { reportData: Buffer.concat([createHash("sha256").update(Buffer.concat([SP, NONCE])).digest(), Buffer.alloc(32)]) }).toString("base64") };
const SYNTH_FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };
const runSynth = (collateral, policy = {}, now) => verifyEvidence(synthDoc, { policy: { snp: { roots: new Map([["Genoa", S.arkFp]]), allowedMeasurements: ["77".repeat(48)], minTcb: SYNTH_FLOOR, ...policy } }, context: { transportKeySpki: SP, nonce: NONCE, now }, collateral });
const LATER = new Date(Date.now() + 2 * 86400e3);   // two days on: the one-day CRL is stale, the 400-day one is fresh

test("a stale cached CRL is refreshed from the upstream before it is served; the verdict shows a fresh CRL from the upstream", async () => {
  const dir = fresh("stale-fresh"), u = upstream({ chain: S.chainPem, vcek: S.vcekDer, crl: S.crls[400] });
  const c = cachedCollateral({ dir, upstream: u, now: () => LATER, roots: new Map([["Genoa", S.arkFp]]) });
  plant(dir, "Genoa", "crl.der", S.crlDer);
  const v = await runSynth(c, { crl: "required" }, LATER);
  assert.equal(v.status, "verified", v.reasons.join("\n")); assert.equal(v.claims.collateral.crl.source, "stub:crl"); assert.equal(v.claims.collateral.crl.stale, false); assert.equal(u.calls.crl, 1);
  assert.equal(c.events.some((e) => e.kind === "stale"), true, "the stale entry was noticed"); assert.equal(sha256(fs.readFileSync(path.join(dir, "Genoa", "crl.der"))), sha256(S.crls[400]), "the fresh CRL replaced the stale one");
});
test("a stale cached CRL with no upstream answer is served flagged stale, and only the policy can accept it: required rejects, stale-ok within its bound is limited and says so, beyond the bound rejects", async () => {
  const dir = fresh("stale-only"), u = upstream({ chain: S.chainPem, vcek: S.vcekDer, crl: S.crlDer });
  const c = cachedCollateral({ dir, upstream: u, now: () => LATER, roots: new Map([["Genoa", S.arkFp]]) });
  plant(dir, "Genoa", "chain.pem", Buffer.from(S.chainPem)); plant(dir, "Genoa", "crl.der", S.crlDer);
  u.down = true; plant(dir, "Genoa", path.join("vcek", `${S.chip.toString("hex")}-0a00000000001754.der`), S.vcekDer);
  const req = await runSynth(c, { crl: "required" }, LATER); assert.equal(req.status, "rejected"); assert.match(req.reasons.join("\n"), /CRL is stale/); assert.equal(req.claims.collateral.crl.stale, true); assert.equal(req.claims.collateral.crl.cached, true);
  const ok = await runSynth(c, { crl: "stale-ok", crlMaxStaleDays: 5 }, LATER); assert.equal(ok.status, "limited", ok.reasons.join("\n")); assert.deepEqual(ok.omissions, ["crl-stale-accepted"]); assert.equal(ok.admissionSafe, false); assert.equal(ok.claims.collateral.crl.stale, true);
  const beyond = await runSynth(c, { crl: "stale-ok", crlMaxStaleDays: 0 }, LATER); assert.equal(beyond.status, "rejected"); assert.match(beyond.reasons.join("\n"), /CRL is stale/);
  assert.equal(u.calls.crl >= 1, true, "the upstream was tried before serving stale"); assert.equal(c.stats.staleServed >= 3, true);
});
test("an authentic CRL that REVOKES the ASK is served by the cache, never quarantined or replaced: the verifier rejects, and a warm cache cannot hide a revocation", async () => {
  assert.ok(S.crlRevokingAsk, "the synthetic revoking CRL was produced");
  const dir = fresh("revoked"), u = upstream({ chain: S.chainPem, vcek: S.vcekDer, crl: S.crlDer }), NOW_S = new Date();
  const c = cachedCollateral({ dir, upstream: u, now: () => NOW_S, roots: new Map([["Genoa", S.arkFp]]) });
  plant(dir, "Genoa", "chain.pem", Buffer.from(S.chainPem)); plant(dir, "Genoa", "crl.der", S.crlRevokingAsk); plant(dir, "Genoa", path.join("vcek", `${S.chip.toString("hex")}-0a00000000001754.der`), S.vcekDer);
  const v = await runSynth(c, { crl: "required" }, NOW_S);
  assert.equal(v.status, "rejected"); assert.match(v.reasons.join("\n"), /ASK \(serial .*\) is REVOKED/); assert.equal(c.stats.quarantined, 0); assert.equal(u.calls.crl, 0, "a fresh, authentic CRL is served as is: no refetch to find a friendlier one");
  assert.equal(v.claims.collateral.crl.cached, true);
  // the same with the non-revoking CRL upstream and the revoking one cached and within its window: still the cached, revoking one
  u.serve.crl = S.crlDer; const w = await runSynth(c, { crl: "required" }, NOW_S); assert.equal(w.status, "rejected"); assert.equal(u.calls.crl, 0);
});

// ---- the slot binding (a finding of Codex's review, 2026-09-24): an authentic VCEK for another chip or TCB is not this slot's --
test("Codex's reproduction: an authentic VCEK requested under another chip id is refused on the way in, nothing is stored, and the next request still asks the upstream (no availability poisoning)", async () => {
  const dir = fresh("slot-repro"), u = upstream(REAL), c = cachedCollateral({ dir, upstream: u, now: () => new Date(NOW) });
  const chip0 = "00".repeat(64), tcb0 = "00".repeat(8);
  await assert.rejects(c.vcek("Genoa", chip0, tcb0, "unused"), /failed authentication: .*hardware ID does not match|SPL .* does not match/);
  assert.equal(u.calls.vcek, 1); assert.equal(inspectCache(dir).some((e) => /vcek/.test(path.relative(dir, e.file))), false, "nothing stored under the requested slot");
  await assert.rejects(c.vcek("Genoa", chip0, tcb0, "unused")); assert.equal(u.calls.vcek, 2, "the upstream is asked again: the slot was never poisoned");
  assert.equal(c.events.filter((e) => e.kind === "upstream-refused").length, 2);
  await assert.rejects(c.vcek("Genoa", "zz", tcb0, "unused"), /slot key malformed/);
});
test("a planted authentic VCEK for the wrong chip or the wrong TCB in the requested slot is quarantined on read; a healthy upstream then restores the right one and the verdict is verified; with the upstream down the verdict is rejected, never verified", async () => {
  // real Genoa: the report's own slot is poisoned with the same product's certificate under a wrong TCB key, and with the Turin one
  const dir = fresh("slot-planted"), u = upstream(REAL), c = cachedCollateral({ dir, upstream: u, now: () => new Date(NOW) });
  await runReal(c); const slot = inspectCache(dir).find((e) => /\/vcek\/[^/]+\.der$/.test(e.file)).file;
  const wrongTcbSlot = slot.replace(/-([0-9a-f]{16})\.der$/, "-ffffffffffffffff.der");
  fs.copyFileSync(slot, wrongTcbSlot); fs.copyFileSync(`${slot}.meta.json`, `${wrongTcbSlot}.meta.json`);
  await assert.rejects(c.vcek("Genoa", path.basename(slot).slice(0, 128), "ffffffffffffffff", "unused"), /SPL .* does not match/, "the same certificate under another TCB key is refused, not served");
  assert.ok(fs.readdirSync(path.dirname(slot)).some((n) => n.startsWith(path.basename(wrongTcbSlot) + ".rejected-")), "the planted entry was quarantined");
  // synthetic: chip A's report, chip B's authentic VCEK planted in A's slot
  const dirS = fresh("slot-synth"), uS = upstream({ chain: S.chainPem, vcek: S.vcekDer, crl: S.crls[400] }), cS = cachedCollateral({ dir: dirS, upstream: uS, now: () => LATER, roots: new Map([["Genoa", S.arkFp]]) });
  const B = S.otherVceks[0]; assert.notEqual(B.chip.toString("hex"), S.chip.toString("hex"));
  plant(dirS, "Genoa", "chain.pem", Buffer.from(S.chainPem)); plant(dirS, "Genoa", path.join("vcek", `${S.chip.toString("hex")}-0a00000000001754.der`), B.der);
  let v = await runSynth(cS, { crl: "required" }, LATER);
  assert.equal(v.status, "verified", v.reasons.join("\n")); assert.equal(uS.calls.vcek, 1, "recovered from the healthy upstream"); assert.equal(v.claims.collateral.vcek.cached, false);
  assert.match(cS.events.find((e) => e.kind === "quarantined").why, /hardware ID does not match/); assert.equal(v.claims.chipId, S.chip.toString("hex"));
  const again = await runSynth(cS, { crl: "required" }, LATER); assert.equal(again.status, "verified"); assert.equal(again.claims.collateral.vcek.cached, true, "the right certificate now fills the slot"); assert.equal(uS.calls.vcek, 1);
  plant(dirS, "Genoa", path.join("vcek", `${S.chip.toString("hex")}-0a00000000001754.der`), B.der); uS.down = true;
  const down = await runSynth(cS, { crl: "required" }, LATER); assert.equal(down.status, "rejected"); assert.match(down.reasons.join("\n"), /VCEK unavailable|no VCEK/); assert.equal(down.admissionSafe, false);
  // and the upstream itself serving chip B's certificate for chip A's request: refused, not cached, verdict rejected
  const dirU = fresh("slot-upstream"), uU = upstream({ chain: S.chainPem, vcek: B.der, crl: S.crls[400] }), cU = cachedCollateral({ dir: dirU, upstream: uU, now: () => LATER, roots: new Map([["Genoa", S.arkFp]]) });
  const w = await runSynth(cU, { crl: "required" }, LATER); assert.equal(w.status, "rejected"); assert.match(w.reasons.join("\n"), /VCEK unavailable: VCEK from stub:vcek failed authentication: .*hardware ID does not match/);
  assert.equal(inspectCache(dirU).some((e) => /vcek/.test(path.relative(dirU, e.file))), false, "chip B's certificate was not stored under chip A's slot");
});
