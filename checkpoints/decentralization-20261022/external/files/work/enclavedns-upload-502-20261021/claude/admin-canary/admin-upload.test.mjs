// Fake-network tests of admin-upload.mjs. The REAL pinned artifact, trust object, frozenWasm and verifyCar are used;
// only fetch is replaced. No network, no real credential (a temp file with a fake key).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, loadArtifact, CanaryRefusal } from "./admin-upload.mjs";

const KEY = "fake-admin-key-" + "x".repeat(24);
const { t, bytes, dag } = await loadArtifact();
const { carHeaderOf } = await import(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../site-host-live-publish/handoff/site-upload.mjs"));
const varint = (n) => { const o = []; do { let b = n & 127; n = Math.floor(n / 128); if (n) b |= 128; o.push(b); } while (n); return Buffer.from(o); };
function carOf(skip = 0) {
  const h = carHeaderOf(t.expectedCid); const parts = [varint(h.length), h];
  [...dag.blocks].slice(skip).forEach(([c, b]) => { parts.push(varint(c.length + b.length), Buffer.from(c), Buffer.from(b)); });
  return Buffer.concat(parts);
}
function rig({ mode = 0o600, upload = null, handoff = null } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "admin-pin-"));
  const cred = path.join(d, "cred.env"); fs.writeFileSync(cred, `S3_ENDPOINT=https://s3.example\nAPI_KEY=${KEY}\n`); fs.chmodSync(cred, mode);
  const jdir = path.join(d, "journals"); fs.mkdirSync(jdir);
  if (handoff) for (const [k, v] of Object.entries(handoff)) fs.writeFileSync(path.join(jdir, `${k}.json`), JSON.stringify(v));
  const opts = { credentialFile: cred, journalDir: jdir, attempts: path.join(d, "attempts.jsonl"), readbackEveryMs: 1, readbackForMs: 50, probeTimeoutMs: 1000, uploadTimeoutMs: 1000 };
  const calls = [], lines = [];
  return { d, opts, calls, lines, out: (s) => lines.push(s), sleep: async () => {} };
}
const fake = (r, handlers) => async (url, init = {}) => {
  r.calls.push({ url, method: init.method, headers: init.headers || {}, redirect: init.redirect });
  for (const [m, h] of handlers) if (m(url, init)) return h(url, init);
  return new Response("", { status: 404 });
};
const isProbe = (u) => u.endsWith("?format=raw"), isCar = (u) => u.includes("format=car"), isFile = (u) => u === `https://ipfs.enclave.host/ipfs/${t.expectedCid}`;
const isPost = (u, i) => i.method === "POST";
const jlines = (r) => fs.existsSync(r.opts.attempts) ? fs.readFileSync(r.opts.attempts, "utf8") : "";
const noSecret = (r) => { assert.ok(!r.lines.join("\n").includes(KEY), "key in output"); assert.ok(!jlines(r).includes(KEY), "key in journal"); for (const c of r.calls) assert.ok(!c.url.includes(KEY), "key in a URL"); };
const approveOf = async (r) => (await main([], { opts: r.opts, out: () => {}, fetchFn: async () => { throw Error("no network in dry run"); } })).planSha256;

test("dry run: verifies the artifact, never opens the credential, never touches the network", async () => {
  const r = rig({ mode: 0o000 });   // unreadable: any read would throw
  const res = await main([], { opts: r.opts, out: r.out, fetchFn: async () => { throw Error("network used"); } });
  assert.equal(res.dryRun, true); assert.match(res.planSha256, /^[0-9a-f]{64}$/);
  const rep = JSON.parse(r.lines[0]); assert.equal(rep.artifactVerified, true); assert.equal(rep.plan.cid, t.expectedCid); assert.equal(rep.credential.mode, "0");
  assert.equal(bytes.length, 2588705);
});

test("execute needs the exact plan approval, an idle handoff and a 0600 credential", async () => {
  const r = rig();
  await assert.rejects(main(["--execute", "--approve", "0".repeat(64)], { opts: r.opts, out: r.out, fetchFn: fake(r, []) }), CanaryRefusal);
  for (const busy of [{ upload: { status: "awaiting-signature" } }, { upload: { status: "uploading" } }, { publish: { status: "sent" } }, { upgrade: { status: "pending" } }]) {
    const b = rig({ handoff: busy });
    await assert.rejects(main(["--execute", "--approve", await approveOf(b)], { opts: b.opts, out: b.out, fetchFn: fake(b, []) }), /not idle/);
    assert.equal(b.calls.length, 0);
  }
  const m = rig({ mode: 0o644 });
  await assert.rejects(main(["--execute", "--approve", await approveOf(m)], { opts: m.opts, out: m.out, fetchFn: fake(m, []) }), /mode 600/);
  assert.equal(m.calls.length, 0);
});

test("success: one POST with the key only in X-Api-Key, then the full DAG and the file bytes are verified", async () => {
  const r = rig({ handoff: { upload: { status: "ready", lastError: "upload: HTTP 502" } } });
  let indexed = false;
  const f = fake(r, [[(u, i) => isPost(u, i), () => { indexed = true; return new Response('{"ok":true}', { status: 200 }); }],
    [isProbe, () => new Response(indexed ? "x" : "", { status: indexed ? 200 : 404 })], [isCar, () => new Response(carOf(), { status: 200 })], [isFile, () => new Response(bytes, { status: 200 })]]);
  const res = await main(["--execute", "--approve", await approveOf(r)], { opts: r.opts, out: r.out, fetchFn: f, sleep: r.sleep });
  assert.equal(res.result, "accepted"); assert.equal(res.readback.verified, true); assert.equal(res.readback.blocks, [...dag.blocks].length);
  const posts = r.calls.filter((c) => c.method === "POST"); assert.equal(posts.length, 1);
  assert.equal(posts[0].url, `https://7ae476a3.app.enclave.host/api/upload?path=pins/${t.expectedCid}`);
  assert.equal(posts[0].headers["x-api-key"], KEY); assert.ok(r.calls.every((c) => c.redirect === "error"));
  const ev = jlines(r).trim().split("\n").map((l) => JSON.parse(l).event); assert.deepEqual(ev, ["attempt", "outcome", "readback"]);
  noSecret(r);
  await assert.rejects(main(["--execute", "--approve", await approveOf(r)], { opts: r.opts, out: r.out, fetchFn: f }), /no retries/);
});

test("403 bad key and the adapter's S3 500 are classified, never relayed; no retry", async () => {
  for (const [status, body, want] of [[403, '{"error":"bad key"}', { badKey: true, s3Status: null }],
                                       [502, '{"error":"pin failed: S3 answered 500: <Error><Code>InternalError</Code><Message>secret-ish detail</Message></Error>"}', { badKey: false, s3Status: 500 }]]) {
    const r = rig();
    const res = await main(["--execute", "--approve", await approveOf(r)], { opts: r.opts, out: r.out, fetchFn: fake(r, [[isPost, () => new Response(body, { status })]]) });
    assert.equal(res.result, "failed"); assert.equal(res.status, status); assert.equal(res.badKey, want.badKey); assert.equal(res.s3Status, want.s3Status);
    assert.ok(!jlines(r).includes("detail") && !r.lines.join("").includes("detail"), "remote text relayed"); noSecret(r);
    assert.equal(r.calls.filter((c) => c.method === "POST").length, 1);
  }
});

test("a timeout is an UNKNOWN outcome that blocks any further attempt", async () => {
  const r = rig();
  const res = await main(["--execute", "--approve", await approveOf(r)], { opts: r.opts, out: r.out,
    fetchFn: fake(r, [[isPost, () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }]]) });
  assert.equal(res.result, "unknown"); assert.match(res.kind, /UNKNOWN/);
  await assert.rejects(main(["--execute", "--approve", await approveOf(r)], { opts: r.opts, out: r.out, fetchFn: fake(r, []) }), /no retries/);
  noSecret(r);
});

test("already present: no upload, only the readback; a failed probe refuses instead of uploading blind", async () => {
  const r = rig();
  const res = await main(["--execute", "--approve", await approveOf(r)], { opts: r.opts, out: r.out, sleep: r.sleep,
    fetchFn: fake(r, [[isProbe, () => new Response("x", { status: 200 })], [isCar, () => new Response(carOf(), { status: 200 })], [isFile, () => new Response(bytes, { status: 200 })]]) });
  assert.equal(res.alreadyPresent, true); assert.equal(res.readback.verified, true); assert.equal(r.calls.filter((c) => c.method === "POST").length, 0);
  const p = rig();
  await assert.rejects(main(["--execute", "--approve", await approveOf(p)], { opts: p.opts, out: p.out, fetchFn: fake(p, [[isProbe, () => { throw new Error("down"); }]]) }), /not uploading blind/);
  assert.equal(p.calls.filter((c) => c.method === "POST").length, 0);
});

test("a CAR missing a block (or a wrong file) is NOT verified", async () => {
  const r = rig();
  const res = await main(["--execute", "--approve", await approveOf(r)], { opts: r.opts, out: r.out, sleep: r.sleep,
    fetchFn: fake(r, [[isProbe, () => new Response("x", { status: 200 })], [isCar, () => new Response(carOf(1), { status: 200 })], [isFile, () => new Response(bytes, { status: 200 })]]) });
  assert.equal(res.readback.verified, false); assert.match(res.readback.reason, /lacks 1/);
  const w = rig();
  const bad = Buffer.from(bytes); bad[100] ^= 1;
  const res2 = await main(["--execute", "--approve", await approveOf(w)], { opts: w.opts, out: w.out, sleep: w.sleep,
    fetchFn: fake(w, [[isProbe, () => new Response("x", { status: 200 })], [isCar, () => new Response(carOf(), { status: 200 })], [isFile, () => new Response(bad, { status: 200 })]]) });
  assert.equal(res2.readback.verified, false); assert.match(res2.readback.reason, /differ/);
});
