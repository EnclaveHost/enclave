// The Pixel 10 streaming device traces (test/fixtures/verifier/pvm-sealed/traces/, SOURCE.md) through this branch's reader,
// offline and without HPKE: every genuine stream opens complete under the page's own context; every relay mutation fails
// with the class the page reported and releases only an authentic prefix of the genuine plaintext; and the owner's reader,
// pinned as pvm-sealed and present under strict integration, agrees on class and prefix for each.
//   run: node --test test/verifier-sealed-traces.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readSealedStream } from "../verifier/sealed-stream.mjs";
import { STRICT_INTEGRATION } from "../verifier/index.mjs";

const D = new URL("./fixtures/verifier/pvm-sealed/traces/", import.meta.url);
const CTX = JSON.parse(fs.readFileSync(new URL("contexts.json", D), "utf8"));
const h = (s) => Buffer.from(s, "hex");
const load = (file) => JSON.parse(fs.readFileSync(new URL(file, D), "utf8"));
// the page's class -> this reader's status/error
const EXPECT = { tamper: ["rejected", "tamper"], truncated: ["incomplete", "truncated"], trailing: ["rejected", "trailing"], refused: ["refused", "refused"], malformed: ["rejected", "malformed"], oversize: ["rejected", "oversize"] };
const mineClass = (r) => r.status === "complete" ? "complete" : r.status === "incomplete" ? "truncated" : r.status === "aborted" ? "aborted" : r.status === "refused" ? "refused" : r.error;

test("every genuine stream opens complete under the page's context; mode-flip is the VM's refusal by construction", async () => {
  assert.equal(Object.keys(CTX).length, 13);
  for (const [file, c] of Object.entries(CTX)) {
    const t = load(file), ctx = { enc: h(c.enc), secret: h(c.exported), nonce: h(c.nonce) };
    const orig = await readSealedStream(ctx, h(t.orig));
    if (c.mode === "mode-flip") { assert.equal(orig.status, "refused", file); assert.match(orig.detail, /cannot open/); continue; }
    assert.equal(orig.status, "complete", `${file}: ${orig.detail || ""}`); assert.ok(orig.bytes > 0); assert.ok(orig.chunks >= 2);
    assert.match(orig.prefix.toString("utf8"), /^HTTP\/1\.1 200/, `${file}: the plaintext is the app's HTTP response`);
  }
});
test("every relay mutation fails with the class the page reported, and releases only an authentic prefix", async () => {
  const seen = [];
  for (const [file, c] of Object.entries(CTX)) {
    const t = load(file), ctx = { enc: h(c.enc), secret: h(c.exported), nonce: h(c.nonce) };
    const sent = await readSealedStream(ctx, h(t.sent));
    const want = c.browser.error;
    if (!want) { assert.equal(sent.status, "complete", `${file}: pass mode`); assert.ok(sent.prefix.equals((await readSealedStream(ctx, h(t.orig))).prefix)); seen.push(`${file}: complete`); continue; }
    const [status, error] = EXPECT[want] || [];
    assert.ok(status, `${file}: unknown page class ${want}`);
    assert.equal(sent.status, status, `${file}: ${sent.status} ${sent.detail || ""}`); assert.equal(sent.error, error, file); assert.equal(sent.complete, false);
    if (c.mode !== "mode-flip") {
      const origPt = (await readSealedStream(ctx, h(t.orig))).prefix;
      assert.ok(origPt.subarray(0, sent.prefix.length).equals(sent.prefix), `${file}: whatever was released is a prefix of the genuine plaintext`);
      assert.ok(sent.prefix.length < origPt.length || c.mode === "stream-trailing", `${file}: a refused stream never released the whole answer${c.mode === "stream-trailing" ? "" : ""}`);
    }
    if (c.browser.chunks !== undefined) assert.equal(sent.chunks, c.browser.chunks, `${file}: chunks opened before the refusal, as on the device`);
    seen.push(`${file}: ${want} after ${sent.chunks} chunk(s)`);
  }
  assert.equal(seen.length, 13);
});
test("the replayed streams are refused under the page's own context: another request's answer never opens", async () => {
  for (const file of ["stream-replay.json", "l2/stream-replay.json"]) {
    const c = CTX[file], t = load(file), ctx = { enc: h(c.enc), secret: h(c.exported), nonce: h(c.nonce) };
    const r = await readSealedStream(ctx, h(t.sent)); assert.equal(r.error, "tamper"); assert.equal(r.bytes, 0);
  }
});

const ownerPath = process.env.ENCLAVE_PVM_SEALED_MODULE || "";
let owner = null; try { if (ownerPath) owner = await import((await import("node:url")).pathToFileURL(ownerPath).href); } catch (e) { if (STRICT_INTEGRATION) throw e; }
if (STRICT_INTEGRATION && !owner) throw new Error("strict integration: ENCLAVE_PVM_SEALED_MODULE (the owner's reader, pinned as pvm-sealed) is missing");
test("differential on the device traces: the owner's reader agrees on class and released prefix for every orig and sent", { skip: !owner && !STRICT_INTEGRATION && "owner reader absent (set ENCLAVE_PVM_SEALED_MODULE via verifier/integration/resolve.mjs --pin pvm-sealed)" }, async () => {
  const theirs = async (ctx, bytes) => { const got = []; const r = await owner.openStream({ enc: new Uint8Array(ctx.enc), secret: new Uint8Array(ctx.secret), nonce: new Uint8Array(ctx.nonce), chunked: true }, [new Uint8Array(bytes)], { onData: (pt) => got.push(Buffer.from(pt)) }); return { cls: r.ok && r.complete ? "complete" : r.error, prefix: Buffer.concat(got) }; };
  const mismatches = [];
  for (const [file, c] of Object.entries(CTX)) {
    const t = load(file), ctx = { enc: h(c.enc), secret: h(c.exported), nonce: h(c.nonce) };
    for (const which of ["orig", "sent"]) {
      const mine = await readSealedStream(ctx, h(t[which])), ref = await theirs(ctx, h(t[which]));
      if (mineClass(mine) !== ref.cls) mismatches.push(`${file} ${which}: class mine=${mineClass(mine)} owner=${ref.cls}`);
      if (!mine.prefix.equals(ref.prefix)) mismatches.push(`${file} ${which}: prefix mine=${mine.prefix.length} owner=${ref.prefix.length}`);
    }
  }
  assert.deepEqual(mismatches, []);
});
