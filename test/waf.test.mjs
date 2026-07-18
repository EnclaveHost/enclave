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
