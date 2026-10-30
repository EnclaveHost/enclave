import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { pathToFileURL } from "node:url";

const source = process.env.POLICY_MIRROR_TEST_SOURCE
  ? pathToFileURL(process.env.POLICY_MIRROR_TEST_SOURCE)
  : new URL("../network/host-policy-mirrors.mjs", import.meta.url);
const { httpPolicyMirrors, MAX_POLICY_RESPONSE } = await import(source.href);
const base = "https://policy.example";
const digest = "0x" + "ab".repeat(32);
const envelope = { document: '{"version":1}', signature: "0x1234" };
const load = (fetch, options = {}) => httpPolicyMirrors([base], { fetch, ...options })[0](digest);

test("valid public mirror replies retain the document and never send credentials or follow redirects", async () => {
  assert.deepEqual(await load(async (url, options) => {
    assert.equal(url, `${base}/${digest}.json`);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal);
    return new Response(JSON.stringify(envelope));
  }), [envelope]);
});

test("oversized chunked replies are cancelled at the byte limit, before buffering the rest", async () => {
  const chunkSize = 16 * 1024, total = 8 * MAX_POLICY_RESPONSE;
  let delivered = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (delivered === total) return controller.close();
      delivered += chunkSize;
      controller.enqueue(new Uint8Array(chunkSize).fill(32));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  assert.deepEqual(await load(async () => new Response(body)), []);
  assert.equal(cancelled, true);
  assert.ok(delivered <= MAX_POLICY_RESPONSE + chunkSize, `read ${delivered} bytes`);
});

test("declared oversized and unsuccessful replies are cancelled without reading their bodies", async () => {
  for (const init of [
    { headers: { "content-length": String(MAX_POLICY_RESPONSE + 1) } },
    { status: 503 },
  ]) {
    let reads = 0, cancelled = false;
    const body = new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope))); controller.close(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    assert.deepEqual(await load(async () => new Response(body, init)), []);
    assert.equal(reads, 0);
    assert.equal(cancelled, true);
  }
});

test("the cap counts UTF-8 bytes rather than JavaScript characters", async () => {
  const text = JSON.stringify({ document: "é".repeat(MAX_POLICY_RESPONSE / 2), signature: "0x12" });
  assert.ok(text.length < MAX_POLICY_RESPONSE);
  assert.ok(Buffer.byteLength(text) > MAX_POLICY_RESPONSE);
  assert.deepEqual(await load(async () => new Response(text)), []);
});

test("split UTF-8 is decoded correctly and malformed UTF-8 is refused", async () => {
  const expected = { document: "é🔐", signature: "0x12" };
  const bytes = new TextEncoder().encode(JSON.stringify(expected));
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, ++offset));
    },
  });
  assert.deepEqual(await load(async () => new Response(body)), [expected]);
  const invalid = Buffer.concat([Buffer.from('{"document":"'), Buffer.from([0xff]), Buffer.from('","signature":"0x12"}')]);
  await assert.rejects(load(async () => new Response(invalid)), /encoded data|encoding|UTF-8/i);
});

test("the deadline interrupts a real response that sends headers then withholds the body", { timeout: 3000 }, async (t) => {
  let started;
  const headersSent = new Promise(resolve => { started = resolve; });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"document":"');
    started();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const pending = load((_url, options) => fetch(`http://127.0.0.1:${server.address().port}`, options), { timeoutMs: 250 });
  const result = assert.rejects(pending, /abort|timeout/i);
  await headersSent;
  await result;
});
