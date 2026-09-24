// The device's streaming traces, re-checked offline (SEALED-STREAMING.md; results/pvm-cpu-streaming): for every stream a
// malicious relay mutated on the Pixel run, the relay saved the VM's genuine stream (orig) and what it sent the page
// (sent), and the page saved its opening context (enc, the exported value, the evidence nonce). Here, with no device and
// no HPKE: the genuine stream opens COMPLETE under that context, and the mutated one fails with exactly the class the page
// reported in the browser. Skips until the results exist.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openStream } from "../shielded/anchor/avf/web/pvm-sealed.js";

const R = process.env.PVM_STREAM_RESULTS || new URL("../shielded/anchor/avf/results/pvm-cpu-streaming/", import.meta.url).pathname;
const have = fs.existsSync(path.join(R, "traces"));
const h = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const open = (ctx, bytes) => openStream(ctx, (async function* () { yield bytes; })());

test("device traces: each genuine stream opens complete offline, each mutation fails as the page said", { skip: !have && "no device results yet" }, async () => {
  const pages = fs.readFileSync(path.join(R, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byLabel = new Map(pages.map((p) => [p.label, p]));
  const files = [...fs.readdirSync(path.join(R, "traces")).filter((f) => f.endsWith(".json")).map((f) => ["", f]),
                 ...(fs.existsSync(path.join(R, "traces", "l2")) ? fs.readdirSync(path.join(R, "traces", "l2")).map((f) => ["l2", f]) : [])];
  assert.ok(files.length >= 11, `traces: ${files.length}`);
  let checked = 0;
  for (const [sub, f] of files) {
    const t = JSON.parse(fs.readFileSync(path.join(R, "traces", sub, f), "utf8"));
    const label = sub === "l2" ? "reconnect-old-stream" : `evil-${t.mode}`;
    const page = byLabel.get(label);
    assert.ok(page && page.trace, `${label}: the page's opening context`);
    const ctx = { enc: h(page.trace.enc), secret: h(page.trace.exported), nonce: h(page.trace.nonce), chunked: true };
    const orig = await open(ctx, h(t.orig)), sent = await open(ctx, h(t.sent));
    if (t.mode === "mode-flip") {   // the relay turned the request's mode: the VM could not open it, so there is no stream at all
      assert.equal(h(t.orig)[0], 1, `${label}: the VM answered with its (unauthenticated) refusal`);
      assert.match(Buffer.from(h(t.orig).subarray(1)).toString(), /cannot open/);
      assert.equal(sent.error, "refused"); assert.equal(page.error, "refused");
    } else if (t.mode === "stream-replay") {
      assert.equal(orig.ok, true, `${label}: the VM's own answer to THIS request opens complete (the relay withheld it)`);
      assert.equal(sent.error, "tamper", `${label}: another request's stream`);
    } else {
      assert.equal(orig.complete, true, `${label}: the VM's genuine stream opens complete offline`);
      if (t.mode === "stream-pass") assert.equal(sent.complete, true);
      else assert.equal(sent.error, page.error, `${label}: offline ${sent.error} vs in the browser ${page.error}`);
    }
    assert.equal(sent.complete === true, page.complete === true, `${label}: completeness agrees`);
    checked++;
  }
  assert.ok(checked >= 12);
});
