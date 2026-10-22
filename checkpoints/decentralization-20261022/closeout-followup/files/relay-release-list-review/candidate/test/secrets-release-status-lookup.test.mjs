// GET /v1/secrets/release-status for a deployment listed only by its APP VERSION (SECRETS_RELEASE_APP_REFS): the relay reads
// THAT deployment's row by id through the agreeing catalog RPCs (ctx.confirmRow), bounded below the supervisor's 5-s status
// read, and answers 503 release_status_unavailable (never listed:false) when the row cannot be read or is not exactly this
// deployment's. 2026-10-22: the status waited on the full-ledger scan (ctx.ledgerRows, one metered BASE_RPC); a public read
// of an unlisted id timed out at 15 s (a direct one took 652 ms), and the supervisor journal showed "the relay's release list
// could not be read" refusals for some unlisted deployments (not all of the queued apps: others are unaffordable).
// Part 1 drives the REAL relay handler (relay/secrets.js handleSecrets -> releaseStatus) with a stand-in relay context; part
// 2 runs the REAL supervisor's releaseListedFor (RELEASE_SELFTEST {"listed"}) against that handler over loopback HTTP, with
// the ledger scan slower than the supervisor waits, as live. Synthetic ids and a synthetic signing seed only; nothing here is a credential.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "release-status-lookup-"));
const hexId = (b) => "0x" + b.repeat(32);
const LISTED = hexId("11"), BYREF = hexId("22"), OTHER = hexId("33"), GONE = hexId("44"), FAILS = hexId("55"), SLOW = hexId("66"), SPLIT = hexId("77");
// a miswired or regressed context: no row, ANOTHER deployment's row (of the listed version), a row whose appRef is not a string
const NULLROW = hexId("88"), WRONGID = hexId("99"), BADREF = hexId("aa");
const REF = "catalog://0x" + "5a".repeat(32) + "/0", REF2 = "catalog://0x" + "5a".repeat(32) + "/1";
Object.assign(process.env, { SECRETS_KEY: "ab".repeat(32), AUTH_DATA_DIR: DIR, SECRETS_ATTESTED_RELEASE: "1",
  SECRETS_RELEASE_DEPLOYMENTS: LISTED, SECRETS_RELEASE_APP_REFS: REF, SECRETS_RELEASE_BURST: "1000",
  SECRETS_RELEASE_MIN_TCB: JSON.stringify({ Turin: { fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 } }), SECRETS_RELEASE_VMPL: "0",
  SECRETS_RELEASE_SIGNING_KEY: "5a".repeat(32), SECRETS_RELEASE_STATUS_ROW_MS: "300" });
const { initSecrets, handleSecrets } = await import("../relay/secrets.js");
const R = await import("../relay/secrets-release.mjs");
await initSecrets();
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// the relay context: the providers release needs (missingFor) as inert stand-ins; the two ledger reads are instrumented
const calls = { confirm: [], scan: 0 };
const rows = { [BYREF]: REF, [OTHER]: REF2, [SPLIT]: REF };
// the full-ledger scan, SLOW as from the rate-limited egress: it answers (the rows it holds) only after 8 s, longer than the
// supervisor's 5-s status read; the installed relay waited on it for every id not listed by SECRETS_RELEASE_DEPLOYMENTS
const SCAN_MS = 8_000;
const scan = () => new Promise((ok) => setTimeout(() => ok(Object.entries(rows).map(([id, appRef]) => ({ id, appRef }))), SCAN_MS));
const ctx = {
  json: (res, code, body) => { res.code = code; res.body = body; },
  clientIp: () => "203.0.113.9",
  ledgerRows: () => { calls.scan++; return scan(); }, ledgerExpire: () => {},
  confirmRow: async (id) => {
    calls.confirm.push(id);
    if (id === FAILS) throw new Error("only one RPC answered (need 2)");
    if (id === SPLIT) throw Object.assign(new Error("the RPCs disagree about the deployment's record"), { code: "disagree" });
    if (id === SLOW) return new Promise(() => {});
    if (id === NULLROW) return null;
    if (id === WRONGID) return { id: BYREF, appRef: REF, active: true };
    if (id === BADREF) return { id, appRef: null, active: true };
    if (!rows[id]) throw Object.assign(new Error("the ledger holds no such deployment"), { code: "no_deployment" });
    return { id, appRef: rows[id], runner: "0x" + "e0".repeat(32), leaseUntil: "0", owner: "0x" + "00".repeat(20), isPublic: true, configCid: "", active: true };
  },
  versionConfigFor: async () => null, leaseHolderChipIds: async () => [], verifyGuestEvidence: () => { throw new Error("unused"); },
  runtimeIdOf: async () => Buffer.alloc(32), expectedGuestFor: async () => ({ ok: false, code: "unused" }),
  hostEligibility: () => ({ eligible: true, reason: null }), prewarmCollateral: async () => ({ ok: true }),
};
const status = async (id) => { const res = {}; const t0 = Date.now(); await handleSecrets({ method: "GET", headers: {} }, res,
  new URL(`http://x/v1/secrets/release-status?id=${id}`), ctx); return { ...res, ms: Date.now() - t0 }; };

test("an app-version listing reads THAT row by id through the agreeing RPCs, never the full-ledger scan", { timeout: 10_000 }, async () => {
  calls.confirm.length = 0; calls.scan = 0;
  assert.deepEqual((await status(LISTED)).body, { id: LISTED, listed: true }, "listed by id");
  assert.equal(calls.confirm.length, 0, "an id listed by SECRETS_RELEASE_DEPLOYMENTS reads nothing");
  const a = await status(BYREF), b = await status(OTHER);
  assert.equal(a.code, 200); assert.deepEqual(a.body, { id: BYREF, listed: true }, "its version is listed");
  assert.deepEqual(b.body, { id: OTHER, listed: false }, "another version is not");
  assert.deepEqual(calls.confirm, [BYREF, OTHER], "one confirmed row read per asked id");
  assert.equal(calls.scan, 0, "the slow full-ledger scan was never waited on");
  assert.ok(a.ms < 300 && b.ms < 300, `answered at once (${a.ms}, ${b.ms} ms)`);
  assert.deepEqual((await status(GONE)).body, { id: GONE, listed: false }, "no such deployment (agreed): not listed");
});

test("a row that cannot be read is 503 release_status_unavailable within the bound - never listed:false", { timeout: 10_000 }, async () => {
  for (const [id, why] of [[FAILS, "quorum unavailable"], [SPLIT, "the RPCs disagree"], [SLOW, "no answer"],
                           [NULLROW, "no row at all"], [WRONGID, "another deployment's row (of the listed version)"], [BADREF, "a non-string appRef"]]) {
    const r = await status(id);
    assert.equal(r.code, 503, `${why}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "release_status_unavailable", why);
    assert.equal(r.body.listed, undefined, `${why}: no listing is stated`);
    assert.doesNotMatch(JSON.stringify(r.body), /RPC|disagree|quorum/i, `${why}: the public answer names nothing of the relay's reads`);
    assert.ok(r.ms < 1500, `${why}: bounded (${r.ms} ms; SECRETS_RELEASE_STATUS_ROW_MS 300 here)`);
  }
  // the production bound sits below the supervisor's own status read (supervisor.js releaseListedFor's AbortSignal.timeout)
  const sup = fs.readFileSync(path.join(HERE, "..", "supervisor.js"), "utf8");
  const m = /async function releaseListedFor[\s\S]*?AbortSignal\.timeout\((\d+)\)/.exec(sup);
  assert.ok(m, "the supervisor's status read and its timeout");
  assert.ok(R.STATUS_ROW_MS < Number(m[1]) && R.STATUS_ROW_MS >= 1000, `${R.STATUS_ROW_MS} ms < the supervisor's ${m[1]} ms`);
});

test("unchanged: release off is 503 release_off; a bad id is 422; the rate limit still answers 429", { timeout: 10_000 }, async () => {
  process.env.SECRETS_ATTESTED_RELEASE = "";
  try { const off = await status(BYREF); assert.equal(off.code, 503); assert.equal(off.body.error, "release_off"); }
  finally { process.env.SECRETS_ATTESTED_RELEASE = "1"; }
  assert.equal((await status("0x1234")).code, 422);
  const limited = await R.releaseStatus(new URL(`http://x/v1/secrets/release-status?id=${BYREF}`), {}, {}, ctx,
    { bad: (code, error) => ({ code, error }), rate: () => false });
  assert.deepEqual(limited, { code: 429, error: "rate_limited" });
});

// ---- part 2: the REAL supervisor reading the REAL handler over HTTP ----------------------------------------------------
const pexec = promisify(execFile);
const QUIET = { INSTANCE_SELFTEST: "", POOL_SELFTEST: "", SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "",
  CFG_EDIT_SELFTEST: "", ISOLATION_SELFTEST: "", GUEST_POOL_SELFTEST: "", GUESTD_TRANSPORT_SELFTEST: "", RELEASE_SELFTEST: "",
  ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "",
  DNS_API: "", ISOLATION_RELEASE: "", REGISTRY_PRIVATE_KEY: "", ENABLE_MPS: "0" };
test("the supervisor's three-state read: an app-version deployment is LISTED at once while the ledger scan is slow; an unreadable row is unknown", { timeout: 60_000 }, async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    handleSecrets(req, res, u, { ...ctx, json: (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); } })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: "secrets_error", message: e.message })); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const t0 = Date.now();
    const { stdout } = await pexec(process.execPath, [path.join(HERE, "..", "supervisor.js")], { env: { ...process.env, SECRET: "test-secret", ...QUIET,
      SECRETS_API: `http://127.0.0.1:${server.address().port}`, ISOLATION_BACKEND: "snp-guest-per-app",
      RELEASE_SELFTEST: JSON.stringify({ listed: [BYREF, LISTED, OTHER, FAILS, NULLROW, WRONGID] }) } });
    const out = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1));
    assert.deepEqual(out.listed, ["listed", "listed", "unlisted", "unknown", "unknown", "unknown"],
      "the app-version deployment is listed, the id-listed one too, another version is unlisted; an unreadable, missing or mismatched row is unknown (never unlisted, never listed)");
    assert.ok(Date.now() - t0 < 30_000);
  } finally { server.closeAllConnections(); server.close(); }
});
