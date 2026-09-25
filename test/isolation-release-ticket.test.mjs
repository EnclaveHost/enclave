// The attested release, this box's half (supervisor.js isolationReleaseOn, fetchReleaseTicket, releaseTicketPump;
// docs/security/attested-release.md). What must hold:
//   - config and staged secrets are claimable on the per-app tier ONLY when both ends say so: guestd runs with -release
//     (supports.release) AND the operator opted in (ISOLATION_RELEASE=1); either alone changes nothing;
//   - a ticket is fetched only once guestd reports the guest awaiting one, signed by THIS endpoint's registry operator
//     key over exactly "enclave-secrets-release-ticket:<id>:<endpoint>:<ts>", and handed to guestd for that guest;
//   - a relay refusal is retried while the guest waits; a guest that is no longer starting ends the pump;
//   - a ticket that is not base64 of 32 bytes is never handed on, and no ticket ever reaches a log line.
// The operator key here is generated per run (viem generatePrivateKey): a throwaway, never a real key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");
const TIER = "snp-guest-per-app";
const QUIET = { INSTANCE_SELFTEST: "", POOL_SELFTEST: "", SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "",
  CFG_EDIT_SELFTEST: "", ISOLATION_SELFTEST: "", GUEST_POOL_SELFTEST: "", GUESTD_TRANSPORT_SELFTEST: "", RELEASE_SELFTEST: "",
  ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "",
  DNS_API: "", ISOLATION_RELEASE: "", REGISTRY_PRIVATE_KEY: "",
  // never start an MPS control daemon on the machine running the tests (supervisor.js initMps, on a box with a GPU)
  ENABLE_MPS: "0" };

async function run(env) {
  let stdout;
  try {
    ({ stdout } = await pexec(process.execPath, [SUPERVISOR], { env: { ...process.env, SECRET: "test-secret", ...QUIET, ...env } }));
  } catch (e) {
    throw new Error(`supervisor exited ${e.code}: ${String(e.stderr || "").split("\n").filter(Boolean).slice(-4).join(" | ")}`);
  }
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

// ---- the claim gate ----

const POOL = { budget: { memMiB: 32768, cpuPct: 800 }, allocated: { memMiB: 0, cpuPct: 0 }, free: { memMiB: 32768, cpuPct: 800 },
  guests: 0, overcommitted: false, perGuest: { floorMiB: 1024, runtimeMiB: 384, unitOverheadMiB: 768 } };
const guestd = (release) => ({ backend: TIER, pool: POOL,
  supports: { gpu: false, secrets: false, egress: false, config: false, ports: false, ...(release === undefined ? {} : { release }) } });
const dep = (manager, extra) => ({ require: TIER, manager, gpuMilli: 0, config: "", appConfigCid: "", hasSecrets: false,
  firewall: [], volumes: [], isPublic: true, waf: null, policy: { cpuPercent: 100, memMiB: 128, vcpus: 1 }, ...extra });
const withConfig = { config: '{"api_key":"$MCP_ADAPTER_API_KEY"}' };
const withSecrets = { hasSecrets: true };
const unknownSecrets = { hasSecrets: null };

test("config and secrets are claimable only for a RELEASE GUEST: guestd -release, the operator's opt-in AND the relay's list", async () => {
  const L = { listed: true }, U = { listed: false };
  const cases = [
    [guestd(true), { ...withConfig, ...L }], [guestd(true), { ...withSecrets, ...L }], [guestd(true), { ...unknownSecrets, ...L }],
    [guestd(true), { appConfigCid: "bafyx", ...L }],
    [guestd(true), { ...withConfig, ...U }], [guestd(true), { ...withSecrets, ...U }],    // unlisted: the owner did not opt in
    [guestd(false), { ...withConfig, ...L }], [guestd(undefined), { ...withSecrets, ...L }],
  ];
  const verdicts = (c) => c.map(([m, x]) => dep(m, x));
  const on = await run({ ISOLATION_BACKEND: TIER, ISOLATION_RELEASE: "1", ISOLATION_SELFTEST: JSON.stringify({ verdicts: verdicts(cases) }) });
  const off = await run({ ISOLATION_BACKEND: TIER, ISOLATION_SELFTEST: JSON.stringify({ verdicts: verdicts(cases) }) });
  assert.deepEqual(on.verdicts.slice(0, 4), [null, null, null, null], "a listed deployment on an opted-in box: config, secrets, an unknown secret state and a configCid are claimable");
  assert.match(on.verdicts[4], /carries app config/, "UNLISTED: refused, whatever this box's opt-in says (enclave-63)");
  assert.match(on.verdicts[5], /staged secrets/);
  assert.match(on.verdicts[6], /carries app config/, "a guestd without -release: refused");
  assert.match(on.verdicts[7], /staged secrets/);
  for (const v of off.verdicts) assert.ok(v, "no opt-in: every one refused");
  // what the release does not change: GPU, private, waf and volumes are still refused
  const still = await run({ ISOLATION_BACKEND: TIER, ISOLATION_RELEASE: "1", ISOLATION_SELFTEST: JSON.stringify({ verdicts: [
    dep(guestd(true), { gpuMilli: 250, ...L }), dep(guestd(true), { isPublic: false, ...L }), dep(guestd(true), { waf: { rate: 5 }, ...L }),
    dep(guestd(true), { volumes: ["m"], ...L }) ] }) });
  for (const v of still.verdicts) assert.ok(v, "refused");
});

test("a deployment that is not a release guest runs on a -release box only if its guestd has the legacy image", async () => {
  const legacy = (has) => ({ ...guestd(true), supports: { ...guestd(true).supports, legacyImage: has } });
  const r = await run({ ISOLATION_BACKEND: TIER, ISOLATION_RELEASE: "1", ISOLATION_SELFTEST: JSON.stringify({ verdicts: [
    dep(legacy(true), { listed: false }),      // unlisted, no config: the legacy image, unchanged
    dep(legacy(false), { listed: false }),     // unlisted and no legacy image: this box's front would not start it
    dep(legacy(false), { listed: true }),      // listed: a release guest, no legacy image needed
    dep(guestd(false), { listed: false }),     // a guestd without -release: the old path, unchanged
  ] }) });
  assert.deepEqual([r.verdicts[0], r.verdicts[2], r.verdicts[3]], [null, null, null]);
  assert.match(r.verdicts[1], /no legacy image/);
  // without the box's opt-in nothing is a release guest, so a -release guestd needs its legacy image for everyone
  const off = await run({ ISOLATION_BACKEND: TIER, ISOLATION_SELFTEST: JSON.stringify({ verdicts: [dep(legacy(false), { listed: true })] }) });
  assert.match(off.verdicts[0], /no legacy image/);
});

test("the relay's list is read as {id, listed: true} and nothing else", async () => {
  const listedIds = new Set(["0x" + "11".repeat(32)]);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const id = u.searchParams.get("id");
    res.setHeader("content-type", "application/json");
    if (u.pathname !== "/v1/secrets/release-status") { res.statusCode = 404; res.end("{}"); return; }
    if (id === "0x" + "33".repeat(32)) { res.statusCode = 503; res.end(JSON.stringify({ error: "release_unconfigured" })); return; }
    if (id === "0x" + "44".repeat(32)) { res.end(JSON.stringify({ id: "0x" + "11".repeat(32), listed: true })); return; } // another id's answer
    if (id === "0x" + "55".repeat(32)) { res.end(JSON.stringify({ id, listed: "yes" })); return; }
    res.end(JSON.stringify({ id, listed: listedIds.has(id) }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const ids = ["11", "22", "33", "44", "55"].map((b) => "0x" + b.repeat(32));
    const r = await run({ SECRETS_API: `http://127.0.0.1:${server.address().port}`, ISOLATION_BACKEND: TIER,
      RELEASE_SELFTEST: JSON.stringify({ listed: [ids[0].toUpperCase().replace("0X", "0x"), ...ids.slice(1)] }) });
    assert.deepEqual(r.listed, [true, false, false, false, false], "listed / unlisted / relay 503 / another id's answer / not a boolean");
    const down = await run({ SECRETS_API: "http://127.0.0.1:9", ISOLATION_BACKEND: TIER, RELEASE_SELFTEST: JSON.stringify({ listed: [ids[0]] }) });
    assert.deepEqual(down.listed, [false], "an unreachable relay lists nothing");
  } finally { server.close(); }
});

// ---- the ticket pump, against a scripted guestd and a fake relay ----

async function fakeRelay(opts = {}) {
  const seen = [];
  let refuse = opts.refuseFirst || 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const b = JSON.parse(body || "{}");
      const msg = `enclave-secrets-release-ticket:${b.id}:${b.endpoint}:${b.ts}`;
      let signer = null;
      try { signer = await recoverMessageAddress({ message: msg, signature: b.opSig }); } catch { signer = null; }
      seen.push({ path: req.url, id: b.id, endpoint: b.endpoint, ts: b.ts, signer, fresh: Math.abs(Date.now() / 1000 - b.ts) < 60 });
      res.setHeader("content-type", "application/json");
      if (refuse > 0) { refuse--; res.statusCode = 503; res.end(JSON.stringify({ error: "release_unconfigured", message: "not for a log" })); return; }
      const ticket = opts.ticket ?? randomBytes(32).toString("base64");
      seen[seen.length - 1].ticket = ticket;
      res.end(JSON.stringify({ ticket, expiresAt: Math.floor(Date.now() / 1000) + 120 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

const ID = "0x" + "a6".repeat(32);
const key = generatePrivateKey();
const operator = privateKeyToAccount(key).address;
const pump = (relay, c, env = {}) => run({ SECRETS_API: relay.url, REGISTRY_PRIVATE_KEY: key, ISOLATION_BACKEND: TIER,
  RELEASE_SELFTEST: JSON.stringify({ id: ID, vmId: "gd01020304", endpoint: "iso0.example:443", ...c }), ...env });
const starting = { status: "starting" }, awaiting = { status: "starting", awaitingTicket: true };

test("the ticket is fetched only once the guest awaits it, signed by this endpoint's operator, and handed to guestd", async () => {
  const relay = await fakeRelay();
  try {
    const r = await pump(relay, { script: [starting, starting, awaiting, awaiting, { status: "running" }] });
    assert.equal(r.result, "running");
    assert.equal(relay.seen.length, 1, "one ticket, fetched once the guest waited");
    const s = relay.seen[0];
    assert.equal(s.path, "/v1/secrets/release-ticket");
    assert.equal(s.id, ID);
    assert.equal(s.endpoint, "iso0.example:443");
    assert.equal(s.signer, operator, "signed over exactly the contract's text, by the operator key");
    assert.ok(s.fresh);
    // handed after the THIRD answer, the first that said awaitingTicket: never while the guest was merely starting
    assert.deepEqual(r.posts, [{ path: "/vms/gd01020304/ticket", ticketBytes: 32, afterGet: 3 }]);
    assert.ok(r.logs.some((l) => /release ticket handed to guest gd01020304/.test(l)));
    assert.ok(!r.logs.join("\n").includes(s.ticket), "a ticket never reaches a log line");
  } finally { relay.close(); }
});

test("a relay refusal is retried while the guest waits, and logged by status and code only", async () => {
  const relay = await fakeRelay({ refuseFirst: 2 });
  try {
    const r = await pump(relay, { script: [awaiting, awaiting, awaiting, awaiting, awaiting, awaiting, { status: "running" }] });
    assert.equal(r.result, "running");
    assert.equal(relay.seen.length, 3);
    assert.equal(r.posts.length, 1);
    assert.ok(r.logs.some((l) => /HTTP 503 release_unconfigured/.test(l)));
    assert.ok(!r.logs.join("\n").includes("not for a log"), "the relay's message stays out of the log");
  } finally { relay.close(); }
});

test("a guest that is no longer starting ends the pump, and no ticket is fetched for it", async () => {
  const relay = await fakeRelay();
  try {
    for (const [script, want] of [[[starting, starting, { status: "failed" }], "failed"], [[starting, { code: 404 }], "gone"],
                                  [[{ status: "running" }], "running"]]) {
      const r = await pump(relay, { script });
      assert.equal(r.result, want);
      assert.equal(r.posts.length, 0);
    }
    assert.equal(relay.seen.length, 0);
  } finally { relay.close(); }
});

test("a malformed ticket is never handed on, and without an operator key nothing is asked", async () => {
  const bad = await fakeRelay({ ticket: randomBytes(16).toString("base64") });
  try {
    const r = await pump(bad, { script: [awaiting], deadlineMs: 300 });
    assert.equal(r.result, "timeout");
    assert.equal(r.posts.length, 0, "a 16-byte ticket was handed to guestd");
    assert.ok(r.logs.some((l) => /not base64 of 32 bytes/.test(l)));
  } finally { bad.close(); }
  const relay = await fakeRelay();
  try {
    const r = await pump(relay, { script: [awaiting], deadlineMs: 300 }, { REGISTRY_PRIVATE_KEY: "" });
    assert.equal(relay.seen.length, 0);
    assert.equal(r.posts.length, 0);
    assert.ok(r.logs.some((l) => /no operator key/.test(l)));
  } finally { relay.close(); }
});

test("guestd refusing the ticket (already pending) is logged, and the pump does not loop on the relay", async () => {
  const relay = await fakeRelay();
  try {
    const r = await pump(relay, { script: [awaiting, awaiting, { status: "running" }], post: 409, retryMs: 100000 });
    assert.equal(r.result, "running");
    assert.equal(relay.seen.length, 1, "one fetch, then the retry waits out retryMs");
    assert.ok(r.logs.some((l) => /did not take the release ticket .*HTTP 409/.test(l)));
  } finally { relay.close(); }
});
