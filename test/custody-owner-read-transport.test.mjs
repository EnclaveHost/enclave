import test from "node:test";
import assert from "node:assert/strict";
import { custodianPost } from "../custody/v2/owner-secrets.mjs";

const url = "https://custodian.example/v2/custody/owner-read";
const encoded = (s) => new TextEncoder().encode(s);

test("custodian transport cancels an oversized stream before downloading its tail", async () => {
  let produced = 0, cancelled = false;
  const body = new ReadableStream({
    pull(c) { produced++; c.enqueue(encoded(" ".repeat(4096))); if (produced === 8) c.close(); },
    cancel() { cancelled = true; },
  });
  const post = custodianPost({ maxBytes: 64, fetchImpl: async () => new Response(body) });
  await assert.rejects(post(url, {}), /answer too large/);
  assert.equal(cancelled, true);
  assert.ok(produced < 8, "the untrusted tail must not be downloaded");
});

test("declared excessive content length cancels the body before decoding", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const post = custodianPost({ maxBytes: 64, fetchImpl: async () => new Response(body, { headers: { "content-length": "10000" } }) });
  await assert.rejects(post(url, {}), /answer too large/);
  assert.equal(cancelled, true);
});

test("limits count UTF-8 bytes and preserve characters split across chunks", async () => {
  const bytes = encoded('{"value":"🌍"}');
  const make = () => new Response(new ReadableStream({
    start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); },
  }));
  assert.deepEqual(await custodianPost({ maxBytes: bytes.length, fetchImpl: async () => make() })(url, {}), { value: "🌍" });
  await assert.rejects(custodianPost({ maxBytes: bytes.length - 1, fetchImpl: async () => make() })(url, {}), /answer too large/);
});

test("bounded refusals retain their HTTP meaning and transport policy", async () => {
  let request;
  const post = custodianPost({ fetchImpl: async (_url, opts) => {
    request = opts;
    return new Response('{"error":"paused","message":"Owner paused releases"}', { status: 403 });
  } });
  await assert.rejects(post(url, {}), /paused: Owner paused releases/);
  assert.equal(request.redirect, "error");
  assert.equal(request.method, "POST");
  assert.ok(request.signal instanceof AbortSignal);
  await assert.rejects(post("http://custodian.example/v2/custody/owner-read", {}), /endpoints are https/);
});
