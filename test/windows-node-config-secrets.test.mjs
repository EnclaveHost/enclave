// $NAME in an app config resolves from that deployment's secrets, exactly as the platform runner
// does it (wasm/wasm_manager.py _subst_secrets). Mirrored on purpose: a box that reads these
// differently from the rest of the fleet configures an app here and leaves it unconfigured there,
// with nothing having said no. The published apps depend on it - risc-box's catalog config is
// `"endpoint": "$S3_ENDPOINT"` and four more like it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Host } from "../windows/node/host.mjs";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-cfg-"));
const host = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                        appsEnabled: true, cpuPricePerSec6: 12, log: () => {} });
const D = { id: "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" };
const resolve = async (config, secrets) => {
  if (secrets) host.secrets.set(D.id.toLowerCase(), secrets); else host.secrets.delete(D.id.toLowerCase());
  return await host.appConfigResolved(D, { config });
};

test("a bare $NAME and a braced ${NAME} both resolve", async () => {
  const out = await resolve(JSON.stringify({ endpoint: "$S3_ENDPOINT", key: "${S3_KEY}" }),
                            { S3_ENDPOINT: "https://r2.example", S3_KEY: "AKIA123" });
  assert.deepEqual(JSON.parse(out), { endpoint: "https://r2.example", key: "AKIA123" });
});

test("only real secrets substitute; every other dollar sign is left alone", async () => {
  const out = await resolve(JSON.stringify({ a: "$KNOWN", b: "$UNKNOWN", c: "cost: $5", d: "100%$" }),
                            { KNOWN: "yes" });
  assert.deepEqual(JSON.parse(out), { a: "yes", b: "$UNKNOWN", c: "cost: $5", d: "100%$" },
    "a config may legitimately contain dollar signs, and an unknown name is not an error");
});

test("$$ is a literal dollar, even in front of a real secret name", async () => {
  const out = await resolve(JSON.stringify({ a: "$$KNOWN", b: "$$" }), { KNOWN: "yes" });
  assert.deepEqual(JSON.parse(out), { a: "$KNOWN", b: "$" });
});

test("a secret with quotes or backslashes is re-serialised, never spliced into raw JSON", async () => {
  const nasty = 'he said "hi" \\ and \n stopped';
  const out = await resolve(JSON.stringify({ v: "$NASTY" }), { NASTY: nasty });
  assert.deepEqual(JSON.parse(out), { v: nasty }, "it must still parse, and be exactly the value");
});

test("it walks nested objects and arrays, and leaves non-strings alone", async () => {
  const out = await resolve(JSON.stringify({
    credentials: { accessKeyId: "$ID", secretAccessKey: "$SECRET" },
    hosts: ["$ID", "literal"], ramMiB: 21764, realtime: true, nothing: null,
  }), { ID: "abc", SECRET: "shh" });
  assert.deepEqual(JSON.parse(out), {
    credentials: { accessKeyId: "abc", secretAccessKey: "shh" },
    hosts: ["abc", "literal"], ramMiB: 21764, realtime: true, nothing: null,
  });
});

test("KEYS are not substituted, only values", async () => {
  const out = await resolve(JSON.stringify({ "$ID": "v" }), { ID: "abc" });
  assert.deepEqual(JSON.parse(out), { "$ID": "v" },
    "a secret name appearing as a key is a config's own business");
});

test("no secrets, or a config that is not JSON, passes through untouched", async () => {
  assert.equal(await resolve('{"a":"$X"}', null), '{"a":"$X"}');
  assert.equal(await resolve("not json at all $X", { X: "y" }), "not json at all $X",
    "the app owns its own format; this box is not the place to discover it is not JSON");
  assert.equal(await resolve("", { X: "y" }), "");
});

test("the real shape: risc-box's catalog config", async () => {
  const cfg = JSON.stringify({
    title: "Alpine desktop", api_key: "$RISCBOX_API_KEY", endpoint: "$S3_ENDPOINT",
    region: "auto", bucket: "machines",
    credentials: { accessKeyId: "$S3_ACCESS_KEY_ID", secretAccessKey: "$S3_SECRET_ACCESS_KEY" },
  });
  const out = JSON.parse(await resolve(cfg, {
    RISCBOX_API_KEY: "Q1rzXXXX", S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "sec",
  }));
  assert.equal(out.api_key, "Q1rzXXXX");
  assert.equal(out.endpoint, "https://acct.r2.cloudflarestorage.com");
  assert.deepEqual(out.credentials, { accessKeyId: "id", secretAccessKey: "sec" });
  assert.equal(out.bucket, "machines", "everything else is carried through unchanged");
});
