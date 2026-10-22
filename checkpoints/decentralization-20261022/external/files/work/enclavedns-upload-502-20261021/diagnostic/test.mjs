// node test.mjs [path-to-module]   (default ./upload-diagnostic.mjs). Local only; fake fetch functions, no network.
// Run with a second module path (root's live wallet-handoff/upload-diagnostic.mjs, API (fetchFn, url, emit)) to apply
// the same safety checks to it: one request, untouched response, exact scope, no secret in the record, bounded.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2] ? path.resolve(process.argv[2]) : new URL("./upload-diagnostic.mjs", import.meta.url).pathname;
const mod = await import(pathToFileURL(target).href);
const rootApi = mod.diagnosticFetch.length === 3;   // root's: (fetchFn, uploadUrl, emit), fixed 4096 B / 3000 ms
const READ_MS = rootApi ? 3000 : 200;
const wrap = (fetchFn, emit) => rootApi ? mod.diagnosticFetch(fetchFn, ADD, emit) : mod.diagnosticFetch(fetchFn, { addUrl: ADD, emit, readMs: READ_MS });

const ADD = "https://ipfs.enclave.host/add-wasm", TOKEN_URL = "https://api.enclave.host/v1/apps/upload-token";
const CANARY = "CANARY_7f3a_SIGNATURE_TOKEN_x-upload-token_0xdeadbeef";
const init = () => ({ method: "POST", duplex: "half", body: "BODY-" + CANARY, redirect: "error",
  headers: { "x-upload-token": CANARY, "x-upload-address": "0x" + "ab".repeat(20), "x-upload-expiry": "1" } });
const adapter = (error, status = 502) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", server: "s3-ipfs-adapter/0.5.5" } });
const results = [];
const check = async (name, fn) => { try { await fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name + ": " + String(e?.message).slice(0, 300)]); } };
const leakFree = (records) => { const s = JSON.stringify(records); for (const bad of [CANARY, "ipfs.enclave.host", "pin failed", "0xabab", "x-upload", "BODY-"]) assert(!s.includes(bad), `record holds ${bad}`); };

async function once(res, url = ADD, i = init()) {
  const records = []; let calls = 0, gotUrl, gotInit;
  const f = wrap(async (u, o) => { calls++; gotUrl = u; gotInit = o; return res; }, (d) => records.push(d));
  const out = await f(url, i);
  assert.equal(calls, 1, "exactly one request"); assert.equal(gotUrl, url); assert.equal(gotInit, i, "init passed through as the same object");
  assert.equal(out, res, "the original Response object is returned");
  return records;
}

// ---- classification + secret canary in the remote text
const cases = [
  ["pin failed: S3 answered 503: writer quorum not reached " + CANARY, { cat: "writer-quorum", s3: 503 }],
  ["pin failed: S3 answered 409: object is fenced " + CANARY, { cat: "fenced", s3: 409 }],
  ["pin failed: S3 answered 402: out of funds " + CANARY, { cat: "out-of-funds", s3: 402 }],
  ["pin failed: S3 answered 403: <Code>AccessDenied</Code> " + CANARY, { cat: "access-denied", s3: 403 }],
  ["pin failed: S3 HEAD answered 500", { cat: "other", s3: 500, op: "head" }],
  ["pin failed: read timeout", { cat: "timeout" }],
  ["pin failed: request deadline exceeded", { cat: "timeout" }],
  ["pin failed: connect 10.0.0.9:9000: Connection refused (os error 111)", { cat: "refused" }],
  ["pin failed: connect 10.0.0.9:9000: No route to host", { cat: "connect" }],
  ["pin failed: tls setup: bad config " + CANARY, { cat: ["badTLS", "bad-tls"] }],
  ["pin failed: resuming at byte 5: S3 answered 416: " + CANARY, { cat: "range", s3: 416 }],
  ["pin failed: something new " + CANARY, { cat: "other" }],
];
for (const [msg, w] of cases) await check(`classify ${w.cat} ${w.s3 ?? ""}`, async () => {
  const res = adapter(msg); const r = await once(res);
  assert.equal(r.length, 1); const d = r[0];
  assert.equal(d.status, 502); assert.equal(d.pinFailed, true);
  assert([w.cat].flat().includes(d.category), `category ${d.category}`);
  if (w.s3) assert.equal(d.s3Status, w.s3);
  if (!rootApi) { assert.equal(d.server, "adapter"); assert.equal(d.body, "JSON"); if (w.op) assert.equal(d.s3Op, w.op); }
  leakFree(r);
  assert.equal(await res.text(), JSON.stringify({ error: msg }), "the original body is intact");
});
await check("Caddy empty 502", async () => {
  const res = new Response(null, { status: 502, headers: { server: "Caddy" } }); const [d] = await once(res);
  assert.equal(d.status, 502); assert.equal(d.body, "empty"); assert.equal(d.server, "caddy"); assert.equal(d.pinFailed, false);
});
await check("non-JSON body with canary", async () => {
  const res = new Response("<html>" + CANARY + "</html>", { status: 503 }); const r = await once(res);
  assert.equal(r[0].body, rootApi ? "non-json" : "nonJSON"); assert.equal(r[0].pinFailed, false); leakFree(r);
  assert.equal(await res.text(), "<html>" + CANARY + "</html>");
});
await check("JSON that is not the adapter's error shape", async () => {
  const res = new Response(JSON.stringify({ error: "pin failed: x", extra: CANARY }), { status: 502 }); const r = await once(res);
  leakFree(r); if (!rootApi) { assert.equal(r[0].server, "other"); assert.equal(r[0].pinFailed, false); }
});

// ---- scope: nothing else is inspected; responses pass through untouched
for (const [name, url, method, status] of [["token POST 502", TOKEN_URL, "POST", 502], ["upload GET 502", ADD, "GET", 502],
  ["upload POST 200", ADD, "POST", 200], ["upload POST 399", ADD, "POST", 399], ["upload URL + query", ADD + "?x=1", "POST", 502],
  ["upload URL + slash", ADD + "/", "POST", 502], ["CAR GET 404", "https://ipfs.enclave.host/ipfs/bafy?format=car", "GET", 404]])
  await check(`no inspection: ${name}`, async () => {
    const res = new Response("unchanged " + CANARY, { status }); const r = await once(res, url, { ...init(), method });
    assert.equal(r.length, 0); assert.equal(res.bodyUsed, false); assert.equal(await res.text(), "unchanged " + CANARY);
  });
await check("a fetch error propagates as the same error, no retry, no record", async () => {
  const err = new TypeError("fetch failed"); let calls = 0; const records = [];
  const f = wrap(async () => { calls++; throw err; }, (d) => records.push(d));
  await assert.rejects(f(ADD, init()), (e) => e === err); assert.equal(calls, 1); assert.equal(records.length, 0);
});

// ---- bounds and failures inside the diagnostic never break the upload flow
await check("oversize (streamed, no content-length): original fully readable", async () => {
  const big = new Uint8Array(1 << 20).fill(65);
  const res = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 16; i++) c.enqueue(big.subarray(i << 16, (i + 1) << 16)); c.close(); } }), { status: 502 });
  const r = await once(res); assert.equal(r.length, 1); assert.equal(r[0].readState, "oversize");
  if (!rootApi) assert.equal(r[0].body, "unread");
  assert.equal((await res.arrayBuffer()).byteLength, 1 << 20);
});
if (!rootApi) await check("oversize by content-length: clone not even read", async () => {
  const res = new Response("x".repeat(5000), { status: 502, headers: { "content-length": "5000" } });
  const [d] = await once(res); assert.equal(d.readState, "oversize"); assert.equal((await res.text()).length, 5000);
});
await check("stalled body: bounded in time, original returned", async () => {
  let ctl; const res = new Response(new ReadableStream({ start(c) { ctl = c; c.enqueue(new TextEncoder().encode('{"error":"pin f')); } }), { status: 502 });
  const t0 = Date.now(); const r = await once(res); const ms = Date.now() - t0;
  assert(ms < READ_MS + 1000, `took ${ms} ms`); assert.equal(r.length, 1);
  assert(["timeout", "unavailable"].includes(r[0].readState), `readState ${r[0].readState}`);
  if (!rootApi) assert.equal(r[0].body, "unread");
  ctl.enqueue(new TextEncoder().encode('ailed: x"}')); ctl.close();
  assert.equal(await res.text(), '{"error":"pin failed: x"}', "the original still yields every byte");
});
await check("erroring body: record says error, original returned", async () => {
  const res = new Response(new ReadableStream({ pull(c) { c.error(new Error(CANARY)); } }), { status: 502 });
  const r = await once(res); assert.equal(r.length, 1); leakFree(r);
});
if (!rootApi) await check("clone() throws: original returned, record says clone-failed", async () => {
  const res = new Response("x", { status: 502 }); const fake = { status: 502, headers: res.headers, clone() { throw new Error(CANARY); } };
  const r = await once(fake); assert.equal(r[0].readState, "clone-failed"); leakFree(r);
});
await check("emit throws: original returned", async () => {
  const res = adapter("pin failed: read timeout"); let calls = 0;
  const f = wrap(async () => { calls++; return res; }, () => { throw new Error("emit broke"); });
  assert.equal(await f(ADD, init()), res); assert.equal(calls, 1);
});
if (!rootApi) await check("record holds only the fixed fields", async () => {
  const [d] = await once(adapter("pin failed: S3 answered 503: " + CANARY));
  assert.deepEqual(Object.keys(d).sort(), ["body", "bodyBytes", "category", "pinFailed", "readState", "s3Op", "s3Status", "server", "serverHeader", "status"]);
  for (const [k, v] of Object.entries(d)) assert(v === null || typeof v === "number" || typeof v === "boolean" || /^[A-Za-z-]{1,16}$/.test(v), `${k}=${v}`);
});

for (const [s, n] of results) console.log(s, n);
const fails = results.filter(([s]) => s === "FAIL").length;
console.log(`${path.basename(path.dirname(target))}/${path.basename(target)}: ${results.length - fails}/${results.length} PASS`);
process.exit(fails ? 1 : 0);
