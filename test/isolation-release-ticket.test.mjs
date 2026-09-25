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
  const L = { listed: "listed" }, U = { listed: "unlisted" };
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
  // a list the relay could not answer is never read as unlisted: the claim waits (enclave-99's M1)
  const unknown = await run({ ISOLATION_BACKEND: TIER, ISOLATION_RELEASE: "1", ISOLATION_SELFTEST: JSON.stringify({ verdicts: [
    dep(guestd(true), { listed: "unknown" }), dep({ ...guestd(true), supports: { ...guestd(true).supports, legacyImage: true } }, { listed: "unknown" }) ] }) });
  for (const v of unknown.verdicts) assert.match(v, /could not be read/);
  // what the release does not change: GPU, private, waf and volumes are still refused
  const still = await run({ ISOLATION_BACKEND: TIER, ISOLATION_RELEASE: "1", ISOLATION_SELFTEST: JSON.stringify({ verdicts: [
    dep(guestd(true), { gpuMilli: 250, ...L }), dep(guestd(true), { isPublic: false, ...L }), dep(guestd(true), { waf: { rate: 5 }, ...L }),
    dep(guestd(true), { volumes: ["m"], ...L }) ] }) });
  for (const v of still.verdicts) assert.ok(v, "refused");
});

test("a deployment that is not a release guest runs on a -release box only if its guestd has the legacy image", async () => {
  const legacy = (has) => ({ ...guestd(true), supports: { ...guestd(true).supports, legacyImage: has } });
  const r = await run({ ISOLATION_BACKEND: TIER, ISOLATION_RELEASE: "1", ISOLATION_SELFTEST: JSON.stringify({ verdicts: [
    dep(legacy(true), { listed: "unlisted" }),   // unlisted, no config: the legacy image, unchanged
    dep(legacy(false), { listed: "unlisted" }),  // unlisted and no legacy image: this box's front would not start it
    dep(legacy(false), { listed: "listed" }),    // listed: a release guest, no legacy image needed
    dep(guestd(false), { listed: "unlisted" }),  // a guestd without -release: the old path, unchanged
  ] }) });
  assert.deepEqual([r.verdicts[0], r.verdicts[2], r.verdicts[3]], [null, null, null]);
  assert.match(r.verdicts[1], /no legacy image/);
  // without the box's opt-in nothing is a release guest, so a -release guestd needs its legacy image for everyone
  const off = await run({ ISOLATION_BACKEND: TIER, ISOLATION_SELFTEST: JSON.stringify({ verdicts: [dep(legacy(false), { listed: "listed" })] }) });
  assert.match(off.verdicts[0], /no legacy image/);
});

// a relay that answers release-status the way 99's does (security/attested-release 1ed256cc): the id LOWERCASED
async function statusRelay(answers) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const id = u.searchParams.get("id");
    res.setHeader("content-type", "application/json");
    const a = u.pathname === "/v1/secrets/release-status" ? answers(id) : { code: 404, body: {} };
    res.statusCode = a.code || 200;
    res.end(JSON.stringify(a.body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const hexId = (b) => "0x" + b.repeat(32);

test("the relay's list has THREE answers, and only a clear one is listed or unlisted", async () => {
  const listedIds = new Set([hexId("ab"), hexId("11")]);
  const relay = await statusRelay((id) => {
    if (id !== id.toLowerCase()) return { code: 422, body: { error: "bad_id" } };   // the real relay lowercases; a client must send lowercase to match
    switch (id) {
      case hexId("33"): return { code: 503, body: { error: "release_off" } };
      case hexId("34"): return { code: 503, body: { error: "busy" } };
      case hexId("35"): return { code: 429, body: { error: "rate_limited" } };
      case hexId("44"): return { body: { id: hexId("11"), listed: true } };          // another id's answer
      case hexId("55"): return { body: { id, listed: "yes" } };
      default: return { body: { id, listed: listedIds.has(id) } };
    }
  });
  try {
    const ids = [hexId("AB").replace("0X", "0x"), hexId("22"), hexId("33"), hexId("34"), hexId("35"), hexId("44"), hexId("55")];
    const r = await run({ SECRETS_API: relay.url, ISOLATION_BACKEND: TIER, RELEASE_SELFTEST: JSON.stringify({ listed: ids }) });
    assert.deepEqual(r.listed, ["listed", "unlisted", "unlisted", "unknown", "unknown", "unknown", "unknown"],
      "mixed-case listed / listed:false / release_off / another 503 / 429 / another id's answer / not a boolean");
    const down = await run({ SECRETS_API: "http://127.0.0.1:9", ISOLATION_BACKEND: TIER, RELEASE_SELFTEST: JSON.stringify({ listed: [hexId("11")] }) });
    assert.deepEqual(down.listed, ["unknown"], "an unreachable relay is unknown, never unlisted");
  } finally { relay.close(); }
});

test("the spawn's decision: a listed deployment is a release guest, an unknown list THROWS, never the legacy image", async () => {
  const relay = await statusRelay((id) => id === hexId("35") ? { code: 429, body: {} } : { body: { id, listed: id === hexId("11") } });
  const on = guestd(true), withLegacy = { ...guestd(true), supports: { ...guestd(true).supports, legacyImage: true } };
  try {
    const cases = [
      { h: on, id: hexId("11"), staged: true, config: '{"k":"$K"}' },   // listed, with config and secrets: a release guest
      { h: withLegacy, id: hexId("22"), staged: false },                  // unlisted, nothing to deliver: the legacy image
      { h: withLegacy, id: hexId("22"), staged: false, config: '{"a":1}' },  // unlisted with config: refused
      { h: withLegacy, id: hexId("22"), staged: null },                   // unlisted, secrets unknown: refused
      { h: withLegacy, id: hexId("35"), staged: false },                  // the relay could not answer: throws, retried
      { h: guestd(false), id: hexId("11"), staged: false },               // guestd without -release: the old path
    ];
    const r = await run({ SECRETS_API: relay.url, ISOLATION_BACKEND: TIER, ISOLATION_RELEASE: "1", RELEASE_SELFTEST: JSON.stringify({ spawn: cases }) });
    assert.deepEqual(r.spawn[0], { released: true });
    assert.deepEqual(r.spawn[1], { released: false });
    assert.match(r.spawn[2].error, /config or secrets .*not listed/);
    assert.match(r.spawn[3].error, /config or secrets/);
    assert.match(r.spawn[4].error, /could not be read .*rather than launching it on the legacy image/);
    assert.deepEqual(r.spawn[5], { released: false });
    // without the box's opt-in nothing is a release guest, and the list is not even asked
    const off = await run({ SECRETS_API: "http://127.0.0.1:9", ISOLATION_BACKEND: TIER, RELEASE_SELFTEST: JSON.stringify({ spawn: [cases[1]] }) });
    assert.deepEqual(off.spawn[0], { released: false });
  } finally { relay.close(); }
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
      if (!/^https?:\/\//.test(String(b.endpoint || ""))) {   // the real relay: 422 bad_endpoint
        res.statusCode = 422; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "bad_endpoint" })); seen.push({ bad: true }); return;
      }
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
  RELEASE_SELFTEST: JSON.stringify({ id: ID, vmId: "gd01020304", endpoint: "https://iso0.example", ...c }), ...env });
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
    assert.equal(s.endpoint, "https://iso0.example");
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

test("guestd refusing the ticket (already pending, or taken) counts as handed: one fetch, however short the retry", async () => {
  const relay = await fakeRelay();
  try {
    const r = await pump(relay, { script: [awaiting, awaiting, awaiting, awaiting, { status: "running" }], post: 409, retryMs: 1 });
    assert.equal(r.result, "running");
    assert.equal(relay.seen.length, 1, "a 409 means guestd holds or gave out a ticket: no second fetch");
    assert.ok(r.logs.some((l) => /did not take the release ticket .*HTTP 409/.test(l)));
  } finally { relay.close(); }
});

// enclave-99's L2 on 58a2a8f8: only the relay's deliberate secrets_disabled (or a 404) means "none staged"; any other
// 503 - a relay restarting - is UNKNOWN, never none (an unknown read as none would start a deployment without them)
test("depHasSecrets: only a clean answer is yes or no", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      const id = JSON.parse(body || "{}").id;
      res.setHeader("content-type", "application/json");
      const a = { [hexId("a1")]: [503, { error: "secrets_disabled" }], [hexId("b2")]: [503, { error: "busy" }],
                  [hexId("c3")]: [200, { exists: true }], [hexId("d4")]: [404, {}], [hexId("e5")]: [500, {}],
                  [hexId("f6")]: [200, { exists: false }], [hexId("a7")]: [200, { exists: "yes" }] }[id] || [500, {}];
      res.statusCode = a[0]; res.end(JSON.stringify(a[1]));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const ids = ["a1", "b2", "c3", "d4", "e5", "f6", "a7"].map(hexId);
    const r = await run({ SECRETS_API: `http://127.0.0.1:${server.address().port}`, ISOLATION_BACKEND: TIER, RELEASE_SELFTEST: JSON.stringify({ staged: ids }) });
    assert.deepEqual(r.staged, [false, null, true, null, null, false, null],
      "secrets_disabled / another 503 / exists / 404 (an old or mis-routed relay) / 500 / exists:false / a non-boolean");
  } finally { server.close(); }
});

// enclave-99's L1 on 58a2a8f8: the SPAWN SITE uses the decision (not only the decision function): the real
// spawnContainer, against a scripted guestd and the fake relay, posts release:true and pumps a ticket only for a listed
// deployment, and throws - posting nothing - when the list cannot be read
test("the spawn site: release:true and a ticket pump only for a listed deployment; an unknown list posts nothing", async () => {
  const relay = await statusRelay((id) => id === hexId("35") ? { code: 429, body: {} } : { body: { id, listed: id === hexId("11") } });
  const health = { backend: TIER, pool: POOL, catalog: { runtimeId: "cd".repeat(32), derivations: ["enclave-catalog-bundle/1"] },
    supports: { gpu: false, secrets: false, egress: false, config: false, ports: false, release: true, legacyImage: true } };
  const spec = (id) => ({ deploymentId: id, image: { reference: "ipfs://bafylabcomponent" }, catalogRef: "catalog://0x" + "ab".repeat(32) + "/0",
    versionMemMb: 128, ports: [], config: "", configCid: "", secrets: null, secretsStaged: false, cpuShare: 0.05, gpuShare: 0, appPort: 8080, hosts: [] });
  const site = (id) => run({ SECRETS_API: relay.url, ISOLATION_BACKEND: TIER, ISOLATION_RELEASE: "1", PROVISION_BACKEND: "vm",
    RELEASE_SELFTEST: JSON.stringify({ spawnSite: { health, spec: spec(id) } }) });
  try {
    const listed = await site(hexId("11"));
    assert.equal(listed.error, null);
    assert.equal(listed.posted.length, 1);
    assert.equal(listed.posted[0].release, true, "a listed deployment is created as a release guest");
    assert.deepEqual(listed.pumped, ["gd0a0b0c0d"], "and its ticket is pumped");
    const unlisted = await site(hexId("22"));
    assert.equal(unlisted.error, null);
    assert.equal(unlisted.posted[0].release, undefined, "an unlisted deployment is not a release guest (the legacy image)");
    assert.deepEqual(unlisted.pumped, []);
    const unknown = await site(hexId("35"));
    assert.match(String(unknown.error), /could not be read/);
    assert.deepEqual(unknown.posted, [], "an unknown list creates nothing");
  } finally { relay.close(); }
});
