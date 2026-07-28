// Deployment-options envelope + WAF path rules (supervisor.js) — the pure
// half: what the claim gate accepts in create()'s configCid field, and which
// app-relative URLs the path rules block. Driven through the WAF_SELFTEST
// seam, same contract as SWEEP_SELFTEST/REACH_SELFTEST.
//
// Why strictness matters: the envelope is fail-closed BY DESIGN. A runner
// that silently ignored an unknown option would serve traffic the owner
// believes is filtered — so unknown namespaces, unknown waf keys and bad
// types must all REFUSE, and a plain CID must keep the retirement refusal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function selftest(c) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", WAF_SELFTEST: JSON.stringify(c),
           SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "",
           CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}
const parse = async (...raws) => (await selftest({ parse: raws })).parse;

test("empty and missing envelopes mean no options", async () => {
  const [a, b, c] = await parse("", "   ", null);
  assert.deepEqual(a, { ok: {} });
  assert.deepEqual(b, { ok: {} });
  assert.deepEqual(c, { ok: {} });
});

test("a CID (non-JSON) keeps the configCid-retired refusal", async () => {
  const [r] = await parse("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
  assert.match(r.err, /configCid is retired/);
});

test("valid waf options parse, burst defaults to ~4s of rps", async () => {
  const [full, minimal] = await parse(
    JSON.stringify({ waf: { rps: 5, burst: 20, maxConcurrent: 8, maxBodyMb: 10, methods: ["get", "POST"], pathBlock: ["/Admin"], blockScanners: true, uaBlock: ["curl"] } }),
    JSON.stringify({ waf: { rps: 10 } }));
  assert.deepEqual(full.ok.waf, { rps: 5, burst: 20, maxConcurrent: 8, maxBodyMb: 10,
    methods: ["GET", "POST"], pathBlock: ["/admin"], blockScanners: true, uaBlock: ["curl"] });
  assert.equal(minimal.ok.waf.burst, 40);
});

test("unknown namespaces and unknown waf keys refuse (never ignored)", async () => {
  const [ns, key, noop, burstAlone] = await parse(
    JSON.stringify({ firewall: {} }),
    JSON.stringify({ waf: { rps: 5, geoBlock: ["XX"] } }),
    JSON.stringify({ waf: { blockScanners: false } }),
    JSON.stringify({ waf: { burst: 50 } }));
  assert.match(ns.err, /unknown option namespace "firewall"/);
  assert.match(key.err, /unknown waf option "geoBlock"/);
  assert.match(noop.err, /waf enables nothing/);
  assert.match(burstAlone.err, /waf\.burst needs waf\.rps/);
});

test("config namespace: a per-deployment app-config override parses", async () => {
  const [plain, withVols, empty, combo] = await parse(
    JSON.stringify({ config: { api_key: "k" } }),
    JSON.stringify({ config: { model: "/models/qwen", volumes: ["qwen3-4b"] } }),
    JSON.stringify({ config: {} }),                     // explicitly empty config
    JSON.stringify({ config: { a: 1 }, waf: { rps: 5 } }));
  assert.deepEqual(plain.ok, { config: { api_key: "k" } });
  assert.deepEqual(withVols.ok.config, { model: "/models/qwen", volumes: ["qwen3-4b"] });
  assert.deepEqual(empty.ok, { config: {} });
  assert.deepEqual(combo.ok, { config: { a: 1 }, waf: { rps: 5, burst: 20 } });
});

test("config namespace: non-objects and the reserved _media key refuse", async () => {
  const [arr, str, nul, media] = await parse(
    JSON.stringify({ config: ["a"] }),
    JSON.stringify({ config: "ipfs://bafy…" }),
    JSON.stringify({ config: null }),
    JSON.stringify({ config: { _media: { thumbnail: "bafy…" } } }));
  assert.match(arr.err, /config must be a JSON object/);
  assert.match(str.err, /config must be a JSON object/);
  assert.match(nul.err, /config must be a JSON object/);
  assert.match(media.err, /config\._media is reserved/);
});

test("the envelope's total size cap covers a config override too", async () => {
  const [big] = await parse(JSON.stringify({ config: { blob: "x".repeat(5000) } }));
  assert.match(big.err, /options exceed 4096 bytes/);
});

test("bad types and out-of-range values refuse", async () => {
  const [arr, badRps, badUa, badPath] = await parse(
    JSON.stringify([1, 2]),
    JSON.stringify({ waf: { rps: "fast" } }),
    JSON.stringify({ waf: { rps: 1, uaBlock: ["ab"] } }),   // 2-char needle matches everything
    JSON.stringify({ waf: { rps: 1, pathBlock: ["admin"] } }));
  assert.match(arr.err, /must be a JSON object/);
  assert.match(badRps.err, /waf\.rps must be/);
  assert.match(badUa.err, /waf\.uaBlock entry/);
  assert.match(badPath.err, /waf\.pathBlock entry/);
});

test("path rules: decoded + lowercased, prefix-anchored; query never matches", async () => {
  const scan = { blockScanners: true };
  const { paths } = await selftest({ paths: [
    { waf: scan, url: "/.env" },
    { waf: scan, url: "/%2eenv" },                       // percent-dodge
    { waf: scan, url: "/WP-Admin/setup.php" },
    { waf: scan, url: "/app/.env" },                     // not root-anchored -> allowed
    { waf: scan, url: "/ok?x=/.env" },                   // query only -> allowed
    { waf: { pathBlock: ["/internal"] }, url: "/internal/metrics" },
    { waf: { pathBlock: ["/internal"] }, url: "/api" },
  ] });
  assert.deepEqual(paths, [true, true, true, false, false, true, false]);
});

// ---- who the WAF counts against ---------------------------------------------
// The per-IP rate limit and concurrency cap are things a DEPLOYER buys and
// points at attackers, so the bucket key must not be a value the attacker picks.
// X-Forwarded-For is written by the client and APPENDED to by each proxy: the
// first entry is whatever the sender typed, the last is what the hop in front
// actually saw. api-relay forwards headers verbatim and Caddy appends its peer,
// so on the relay path the last entry IS the client.
async function clientIp(...cases) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", CLIENT_IP_SELFTEST: JSON.stringify(cases),
           SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "",
           CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test("the WAF buckets on the proxy-appended address, not the caller's claim", async () => {
  const [forged, plain, none, stamped, spaces] = await clientIp(
    // a client that typed its own X-Forwarded-For; Caddy appended the truth
    { headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.9" }, remoteAddress: "10.0.0.1" },
    // the ordinary case: one hop, one entry
    { headers: { "x-forwarded-for": "203.0.113.9" }, remoteAddress: "10.0.0.1" },
    // no header at all: the socket peer is all there is
    { headers: {}, remoteAddress: "203.0.113.9" },
    // the /x/:id/https bridge stamps the IP it saw onto the socket; inner
    // requests have no socket address of their own, so the stamp wins outright
    { headers: { "x-forwarded-for": "1.2.3.4" }, remoteAddress: "10.0.0.1", stamped: "198.51.100.7" },
    { headers: { "x-forwarded-for": "  1.2.3.4 ,  203.0.113.9  " }, remoteAddress: "10.0.0.1" },
  );
  assert.equal(forged, "203.0.113.9", "a forged first hop must not become the key");
  assert.equal(plain, "203.0.113.9");
  assert.equal(none, "203.0.113.9");
  assert.equal(stamped, "198.51.100.7");
  assert.equal(spaces, "203.0.113.9");
});

/* ---- the `gpu` namespace: a card requirement that can be softened ---------
   `gpu.optional` says the deployment PREFERS a GPU enclave but would rather
   run on cores than queue. It is only an option when a GPU share was actually
   bought — with no slice there is no requirement to soften, and accepting it
   silently would leave an owner believing their CPU-only deployment is
   chasing hardware it can never be given. So: refused, not ignored. */
test("gpu.optional is accepted only on a deployment that bought GPU share", async () => {
  const env = JSON.stringify({ gpu: { optional: true } });
  const [withSlice] = await parse({ raw: env, gpuMilli: 200 });
  assert.deepEqual(withSlice, { ok: { gpuOptional: true } });

  const [noSlice] = await parse({ raw: env, gpuMilli: 0 });
  assert.match(noSlice.err, /applies only to a deployment that bought GPU share/);
  assert.match(noSlice.err, /0% GPU/);

  // explicitly false is always fine — it is the default, and says GPU-only
  const [off] = await parse({ raw: JSON.stringify({ gpu: { optional: false } }), gpuMilli: 0 });
  assert.deepEqual(off, { ok: { gpuOptional: false } });
});

test("the gpu namespace is shape-checked like every other option", async () => {
  const [notObj] = await parse(JSON.stringify({ gpu: true }));
  assert.match(notObj.err, /gpu must be a JSON object/);
  const [badKey] = await parse(JSON.stringify({ gpu: { preferred: true } }));
  assert.match(badKey.err, /unknown gpu option "preferred"/);
  const [badType] = await parse(JSON.stringify({ gpu: { optional: "yes" } }));
  assert.match(badType.err, /must be true or false/);
  // and it composes with the namespaces that already existed
  const [both] = await parse({ raw: JSON.stringify({ gpu: { optional: true }, config: { a: 1 } }), gpuMilli: 50 });
  assert.deepEqual(both.ok.gpuOptional, true);
  assert.deepEqual(both.ok.config, { a: 1 });
});

test("an unknown namespace still names what this runner knows, now including gpu", async () => {
  const [r] = await parse(JSON.stringify({ nope: {} }));
  assert.match(r.err, /this runner knows: waf, config, gpu/);
});
