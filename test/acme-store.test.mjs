// The in-enclave ACME store (supervisor.js, ACME_STORE_DIR): what survives a
// container restart - issued certs with their keys, the ACME account per CA,
// and the per-name per-CA rate-limit dates - and the guard that keeps it all
// off host-backed disk. Driven through the supervisor's env-gated self-test
// seams (ACME_SELFTEST=store|account|platform), the same way
// test/acme.test.mjs drives the pure half: a child process that exits before
// any boot side effect, printing one JSON line. The 2026-08-27 failure this
// exists for: every release restarts every container, every name was
// re-issued from scratch, ZeroSSL hung, Let's Encrypt's 5-per-name weekly
// duplicate limit was spent by the day's restarts, and a box served NO
// certificate for any of its names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function selftest(mode, extraEnv = {}) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", ACME_SELFTEST: mode,
           ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "",
           CERTS_API: "", TCP_CERT_DOMAIN: "", REGISTRY_PRIVATE_KEY: "", PUBLIC_URL: "",
           ACME_STORE_DIR: "", ACME_STORE_ALLOW_DISK: "",
           ...extraEnv } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}
const tmpDir = (t, tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `enclave-acme-store-${tag}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
// A test directory is a plain temp dir; ACME_STORE_ALLOW_DISK=1 is what lets
// the store open it (the guard has its own tests below).
const storeOf = (dir, c, extra = {}) => selftest("store", { ACME_SELFTEST_STORE: JSON.stringify({ dir, allowDisk: true, ...c }), ...extra });

// A throwaway CA; real key+cert pairs, because a restored record must rebuild
// a TLS context (that is the parse that counts on the way back in).
let _ca = null;
async function caDir() {
  if (_ca) return _ca;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-acme-store-ca-"));
  await pexec("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", path.join(dir, "ca.key"), "-out", path.join(dir, "ca.pem"), "-days", "2", "-subj", "/CN=Enclave Store Test CA"]);
  return (_ca = dir);
}
const randomName = () => createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 8);
async function issuedRecord(name, { days = 90, issuer = "test-ca" } = {}) {
  const { csrPem, keyPem } = await selftest("csr", { ACME_SELFTEST_NAME: name });
  const ca = await caDir(), n = randomName();
  fs.writeFileSync(path.join(ca, `${n}.csr`), csrPem);
  await pexec("openssl", ["x509", "-req", "-in", path.join(ca, `${n}.csr`), "-CA", path.join(ca, "ca.pem"),
    "-CAkey", path.join(ca, "ca.key"), "-CAcreateserial", "-days", String(days), "-copy_extensions", "copy",
    "-out", path.join(ca, `${n}.pem`)]);
  const certPem = fs.readFileSync(path.join(ca, `${n}.pem`), "utf8") + fs.readFileSync(path.join(ca, "ca.pem"), "utf8");
  const now = Date.now();
  return { name, keyPem, certPem, expiresAt: now + days * 86400e3, renewAt: now + Math.round(days * 86400e3 * 2 / 3), issuer, cached: false };
}
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---------- the store: round trip ------------------------------------------

test("store: write, restore with a live TLS context, expired records dropped, files are 0600 in a 0700 dir", async (t) => {
  const dir = tmpDir(t, "rt");
  const a = await issuedRecord("aaaa0001.app.enclave.host");
  const b = await issuedRecord("shop.example.com", { issuer: "acme-v02.api.letsencrypt.org" });
  const dead = { ...(await issuedRecord("dead0000.app.enclave.host")), expiresAt: Date.now() - 1000 };
  const v = await storeOf(dir, { certs: [a, b, dead] });
  assert.equal(v.opened, true, JSON.stringify(v.logs));
  assert.deepEqual(v.filesWritten, [a.name, b.name, dead.name].map((n) => `${sha(n)}.json`).sort(), "one <sha256(name)>.json per cert, nothing else");
  assert.equal(v.dirMode, "700");
  for (const [f, m] of Object.entries(v.modes)) assert.equal(m, "600", `${f} must be owner-only`);
  assert.deepEqual(v.restored.map((r) => r.name).sort(), [a.name, b.name], "the expired one is not restored");
  assert.equal(v.filesAfterLoad, 2, "…and its file is gone");
  for (const r of v.restored) {
    assert.equal(r.ctxOk, true, `${r.name}: tls.createSecureContext rebuilt`);
    assert.equal(r.keyHeld, true);
    assert.equal(r.restoredFlag, true);
  }
  const rb = v.restored.find((r) => r.name === b.name);
  assert.equal(rb.issuer, b.issuer); assert.equal(rb.expiresAt, b.expiresAt); assert.equal(rb.renewAt, b.renewAt);
  // the boot path proper (acmeRestore) fills the map from the same files
  assert.equal(v.restoreCount, 2);
  assert.deepEqual(v.restoredNames, [a.name, b.name].sort());
  // a raw file holds exactly the record - and the private key, which is why the guard exists
  const raw = JSON.parse(fs.readFileSync(path.join(dir, `${sha(a.name)}.json`), "utf8"));
  assert.equal(raw.name, a.name); assert.equal(raw.keyPem, a.keyPem); assert.equal(raw.certPem, a.certPem);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "tmp+rename leaves no temp file behind");
});

test("store: a record for a name no deployment claims is removed by prune; the rest stay", async (t) => {
  const dir = tmpDir(t, "prune");
  const a = await issuedRecord("aaaa0002.app.enclave.host"), b = await issuedRecord("bbbb0002.app.enclave.host");
  const v = await storeOf(dir, { certs: [a, b], keep: [a.name] });
  assert.equal(v.pruned, 1);
  assert.deepEqual(v.namesAfterPrune, [a.name]);
  assert.ok(!fs.existsSync(path.join(dir, `${sha(b.name)}.json`)));
  assert.ok(fs.existsSync(path.join(dir, `${sha(a.name)}.json`)));
});

test("store: a corrupt or foreign file is dropped, not restored", async (t) => {
  const dir = tmpDir(t, "corrupt");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sha("x")}.json`), "{not json");
  const bogus = await issuedRecord("bogus000.app.enclave.host");
  fs.writeFileSync(path.join(dir, `${sha("y")}.json`), JSON.stringify({ ...bogus, v: 1, keyPem: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n" }));
  fs.writeFileSync(path.join(dir, "notes.txt"), "left alone");
  const v = await storeOf(dir, { certs: [] });
  assert.deepEqual(v.restored, []);
  assert.equal(v.filesAfterLoad, 0, "both bad records deleted");
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")), "only <sha256>.json files are the store's business");
});

// ---------- the guard: memory-backed only ------------------------------------

test("guard: a plain directory on a non-tmpfs filesystem is REFUSED (logged once) unless ACME_STORE_ALLOW_DISK=1", async (t) => {
  const dir = tmpDir(t, "guard");
  const EXT4 = 0xEF53, TMPFS = 0x01021994;
  const refused = await storeOf(dir, { allowDisk: false, fsType: EXT4 });
  assert.equal(refused.guard.ok, false);
  assert.match(refused.guard.why, /not tmpfs/);
  assert.equal(refused.opened, false, "nothing is written to disk");
  assert.equal(refused.logs.length, 1, "the refusal is logged exactly once");
  assert.match(refused.logs[0], /REFUSING ACME_STORE_DIR=.*never touch host-backed disk/);
  assert.ok(!fs.existsSync(path.join(dir, "accounts.json")));
  const allowed = await storeOf(dir, { allowDisk: true, fsType: EXT4, certs: [] });
  assert.equal(allowed.guard.ok, true); assert.match(allowed.guard.why, /ACME_STORE_ALLOW_DISK/);
  assert.equal(allowed.opened, true);
  const tmpfs = await storeOf(dir, { allowDisk: false, fsType: TMPFS, certs: [] });
  assert.equal(tmpfs.guard.ok, true); assert.equal(tmpfs.guard.why, "tmpfs");
  assert.equal(tmpfs.opened, true);
});

test("guard: a path tells nothing -- only a statfs that says tmpfs is accepted (inside the Tinfoil container /mnt/ramdisk is the overlay); an empty ACME_STORE_DIR disables the store", async () => {
  const EXT4 = 0xEF53, TMPFS = 0x01021994;
  // the old path allowlist is gone: /mnt/ramdisk and /dev/shm are refused when their filesystem is not tmpfs
  for (const dir of ["/mnt/ramdisk/enclave-acme", "/mnt/ramdisk", "/dev/shm/enclave-acme/", "/var/lib/enclave"]) {
    const v = await selftest("store", { ACME_SELFTEST_STORE: JSON.stringify({ dir, fsType: EXT4, guardOnly: true }) });
    assert.equal(v.guard.ok, false, `${dir} must not pass by path`); assert.match(v.guard.why, /not tmpfs/);
    assert.equal(v.opened, false);
  }
  // any path is accepted when statfs reports tmpfs -- e.g. the /var/lib/enclave bind of the CVM ramdisk
  for (const dir of ["/var/lib/enclave/acme", "/mnt/ramdisk/enclave-acme"]) {
    const v = await selftest("store", { ACME_SELFTEST_STORE: JSON.stringify({ dir, fsType: TMPFS, guardOnly: true }) });
    assert.equal(v.guard.ok, true, `${dir}: ${v.guard.why}`); assert.match(v.guard.why, /tmpfs/);
  }
  const off = await selftest("store", { ACME_SELFTEST_STORE: JSON.stringify({ dir: "" }) });
  assert.equal(off.guard.why, "disabled"); assert.equal(off.opened, false);
  assert.match(off.logs[0], /ACME_STORE_DIR is empty/);
});

test("guard: the real statfs on this machine agrees with `stat -f`", async (t) => {
  const dir = tmpDir(t, "statfs");
  const { stdout } = await pexec("stat", ["-f", "-c", "%t", dir]);
  const isTmpfs = parseInt(stdout.trim(), 16) === 0x01021994;
  const v = await storeOf(dir, { allowDisk: false });
  assert.equal(v.guard.ok, isTmpfs, `${dir} is ${isTmpfs ? "" : "not "}tmpfs per stat -f, guard said: ${v.guard.why}`);
});

// ---------- boot restore before issuance --------------------------------------

test("boot: a restored name is HELD - the platform service is never asked for it; a name not in the store still is", async (t) => {
  const dir = tmpDir(t, "boot");
  const APP = "abcd1234.app.enclave.host", OTHER = "ffff9999.app.enclave.host";
  // seed the store with a fresh cert for APP, as the previous container life would have
  await storeOf(dir, { certs: [await issuedRecord(APP, { issuer: "platform (zerossl)" })] });
  const seen = [];
  const svc = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => { seen.push(JSON.parse(raw).name); res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not_yours" })); });
  });
  await new Promise((r) => svc.listen(0, "127.0.0.1", r));
  t.after(() => svc.close());
  const url = `http://127.0.0.1:${svc.address().port}`;
  const run = (name) => selftest("platform", {
    CERTS_API: url, APP_CERT_DOMAIN: "app.enclave.host", ACME_STORE_DIR: dir, ACME_STORE_ALLOW_DISK: "1",
    ACME_SELFTEST_PLATFORM: JSON.stringify({ name, endpoint: "https://box7.enclave.containers.tinfoil.dev", restoreFirst: true,
                                             cas: [{ host: "acme.zerossl.com", outcome: "nameErr" }] }) });
  const held = await run(APP);
  assert.equal(held.restoredCount, 1);
  assert.deepEqual(held.held, [APP]);
  assert.equal(held.rounds[0].outcome, "held");
  assert.equal(held.rounds[0].issuer, "platform (zerossl)");
  assert.deepEqual(held.rounds[0].tried, [], "no slot walked for a restored name");
  assert.deepEqual(seen, [], "the service was not asked");
  const other = await run(OTHER);
  assert.equal(other.rounds[0].outcome, "failed");
  assert.deepEqual(other.rounds[0].tried, ["platform", "acme.zerossl.com"], "a name the store does not hold is issued as before");
  assert.deepEqual(seen, [OTHER]);
});

// ---------- account persistence -----------------------------------------------

// A mock ACME directory: enough of RFC 8555 for newAccount (directory, a
// nonce, and the registration itself), counting registrations.
async function mockAcmeCa() {
  const state = { newAccount: 0, kids: [] };
  let n = 0;
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const nonce = `nonce-${++n}`;
    if (req.url === "/directory") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ newNonce: `${base}/nonce`, newAccount: `${base}/new-acct`, newOrder: `${base}/new-order`, meta: {} }));
    }
    if (req.url === "/nonce") { res.writeHead(200, { "replay-nonce": nonce }); return res.end(); }
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/new-acct") {
        const jws = JSON.parse(raw);
        const prot = JSON.parse(Buffer.from(jws.protected, "base64url").toString());
        assert.ok(prot.jwk && !prot.kid, "a registration signs with the JWK, not a kid");
        state.newAccount++;
        const kid = `${base}/acct/${state.newAccount}`;
        state.kids.push(kid);
        res.writeHead(201, { "content-type": "application/json", "replay-nonce": nonce, location: kid });
        return res.end(JSON.stringify({ status: "valid" }));
      }
      res.writeHead(404, { "content-type": "application/problem+json", "replay-nonce": nonce });
      res.end(JSON.stringify({ type: "urn:ietf:params:acme:error:malformed", detail: "no such endpoint" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) };
}

test("account: the second run restores the CA account from the store and registers none", async (t) => {
  const dir = tmpDir(t, "acct");
  const ca = await mockAcmeCa();
  t.after(ca.close);
  const env = { ACME_DIRECTORY_2: `${ca.url}/directory`, ACME_STORE_DIR: dir, ACME_STORE_ALLOW_DISK: "1" };
  const first = await selftest("account", env);
  assert.equal(first.error, undefined, first.error);
  assert.equal(first.restored, false);
  assert.equal(first.kid, `${ca.url}/acct/1`);
  assert.equal(first.stored, first.kid, "kid + key persisted to accounts.json");
  assert.equal(ca.state.newAccount, 1);
  const accounts = JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"));
  assert.deepEqual(Object.keys(accounts), [`${ca.url}/directory`], "keyed by the directory URL");
  assert.match(accounts[`${ca.url}/directory`].keyPem, /^-----BEGIN PRIVATE KEY-----/);
  assert.equal((fs.statSync(path.join(dir, "accounts.json")).mode & 0o777).toString(8), "600");
  const second = await selftest("account", env);
  assert.equal(second.restored, true);
  assert.equal(second.kid, first.kid);
  assert.equal(second.thumbprint, first.thumbprint, "the same key, so the same dns-01 thumbprint");
  assert.equal(ca.state.newAccount, 1, "no second registration");
  // without the store every run registers - the old per-boot behaviour
  const memOnly = await selftest("account", { ...env, ACME_STORE_DIR: "" });
  assert.equal(memOnly.restored, false);
  assert.equal(ca.state.newAccount, 2);
});

// ---------- rate-limit honesty -----------------------------------------------

const ZS = "acme.zerossl.com", LE = "acme-v02.api.letsencrypt.org";
// the date Let's Encrypt names, six days out from the real clock (the store caps at seven)
const LE_ISO = new Date(Date.now() + 6 * 86400e3).toISOString().replace(/\.\d+Z$/, "Z");
const LE_DETAIL = `too many certificates (5) already issued for this exact set of identifiers in the last 168h0m0s, retry after ${LE_ISO}: see https://letsencrypt.org/docs/rate-limits/`;
const LE_AT = Date.parse(LE_ISO);
const NAME = "cafe0000.app.enclave.host";
const walk = (dir, c, extra = {}) => selftest("platform", {
  APP_CERT_DOMAIN: "app.enclave.host", ...(dir ? { ACME_STORE_DIR: dir, ACME_STORE_ALLOW_DISK: "1" } : {}),
  ACME_SELFTEST_PLATFORM: JSON.stringify({ name: NAME, endpoint: "https://box7.enclave.containers.tinfoil.dev", ...c }), ...extra });

test("rateLimited: retry-after is parsed from the detail and from the header (seconds or HTTP-date); the later wins; an hour when unsaid; a week at most", async () => {
  const v = await walk("", { cas: [{ host: ZS, outcome: "ok" }] });
  // the seam's fixture: clock 2026-08-28T00:00Z, the CA names 2026-09-03T10:04:00Z
  const r = v.retryAfter, now = Date.parse("2026-08-28T00:00:00Z"), FIX_AT = Date.parse("2026-09-03T10:04:00Z");
  assert.equal(r.detail, FIX_AT, "Let's Encrypt's 'retry after <ISO>' in the detail");
  assert.equal(r.headerSec, now + 3600_000, "Retry-After: 3600");
  assert.equal(r.headerDate, FIX_AT, "Retry-After as an HTTP-date");
  assert.equal(r.both, FIX_AT, "detail says a date, header says 60 s: the later");
  assert.equal(r.neither, now + 3600_000, "rateLimited with no date at all: an hour");
  assert.equal(r.capped, now + 7 * 86400e3, "never more than 7 days");
  assert.deepEqual(v.plans.ratelimited, { failures: 3, nextAt: 1_000_000 + 86400e3, why: "ratelimited" }, "every slot limited: retry at the date, no failure counted");
  assert.equal(v.plans.ratelimitedCapped.nextAt, 1_000_000 + 7 * 86400e3);
});

test("rateLimited: the limited CA is skipped for THAT name until the date while the other CA issues; the date is persisted and survives a restart", async (t) => {
  const dir = tmpDir(t, "rl");
  const v = await walk(dir, { rounds: 2, cas: [{ host: ZS, outcome: "rateLimited", retryAfterDetail: LE_DETAIL }, { host: LE, outcome: "ok" }] });
  const [r1, r2] = v.rounds;
  assert.equal(r1.outcome, "issued"); assert.equal(r1.caHost, LE);
  assert.deepEqual(r1.tried, [ZS, LE], "round 1: the limited CA answers 429, the next CA issues");
  assert.deepEqual(r1.cooled, [], "a rate limit is name-level: nothing cools off");
  assert.deepEqual(r1.rateLimited, { [ZS]: LE_AT }, "the date the CA named, remembered per (name, CA)");
  assert.equal(r2.outcome, "issued");
  assert.deepEqual(r2.tried, [LE], "round 2: the limited CA is not even asked");
  const file = JSON.parse(fs.readFileSync(path.join(dir, "ratelimits.json"), "utf8"));
  assert.deepEqual(file, { [`${NAME}|${ZS}`]: LE_AT }, "persisted as ratelimits.json");
  // a restart: the store is loaded first, so the CA is skipped from the first round
  const again = await walk(dir, { restoreFirst: true, cas: [{ host: ZS, outcome: "ok" }, { host: LE, outcome: "ok" }] });
  assert.deepEqual(again.rounds[0].tried, [LE], "after a restart the limited CA is still skipped until its date");
  assert.deepEqual(again.rounds[0].rateLimited, { [ZS]: LE_AT });
  // a different name is not affected
  const other = await selftest("platform", { APP_CERT_DOMAIN: "app.enclave.host", ACME_STORE_DIR: dir, ACME_STORE_ALLOW_DISK: "1",
    ACME_SELFTEST_PLATFORM: JSON.stringify({ name: "0ther000.app.enclave.host", endpoint: "https://x", restoreFirst: true, cas: [{ host: ZS, outcome: "ok" }, { host: LE, outcome: "ok" }] }) });
  assert.deepEqual(other.rounds[0].tried, [ZS], "per NAME: another name still goes to the limited CA first");
});

test("rateLimited: a Retry-After HEADER alone is honoured too; past dates are dropped on load", async (t) => {
  const dir = tmpDir(t, "rl-hdr");
  const v = await walk(dir, { cas: [{ host: ZS, outcome: "rateLimited", retryAfterHeader: "7200" }, { host: LE, outcome: "ok" }] });
  const until = v.rounds[0].rateLimited[ZS];
  assert.ok(until > Date.now() + 7100_000 && until < Date.now() + 7300_000, `about two hours out: ${until}`);
  // a stale entry in the file does not come back
  fs.writeFileSync(path.join(dir, "ratelimits.json"), JSON.stringify({ [`${NAME}|${ZS}`]: Date.now() - 1000 }));
  const again = await walk(dir, { restoreFirst: true, cas: [{ host: ZS, outcome: "ok" }, { host: LE, outcome: "ok" }] });
  assert.deepEqual(again.rounds[0].tried, [ZS], "an expired rate limit is forgotten");
});

test("rateLimited: every CA limited fails the round at the EARLIEST date, counts no failure, and does not use the 5-minute doubling", async (t) => {
  const dir = tmpDir(t, "rl-all");
  const soon = new Date(Date.now() + 2 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const v = await walk(dir, { rounds: 2, cas: [{ host: ZS, outcome: "rateLimited", retryAfterDetail: LE_DETAIL },
                                               { host: LE, outcome: "rateLimited", retryAfterDetail: `retry after ${soon}` }] });
  const [r1, r2] = v.rounds;
  assert.equal(r1.outcome, "failed");
  assert.deepEqual(r1.tried, [ZS, LE]);
  assert.equal(r1.allRateLimited, true);
  assert.equal(r1.rateLimitedUntil, Date.parse(soon), "the earliest of the two dates");
  assert.equal(r1.livePlan.why, "ratelimited");
  assert.equal(r1.livePlan.nextAt, Date.parse(soon));
  assert.equal(r1.livePlan.failures, 0, "no failure counted against the name");
  assert.equal(r2.outcome, "failed");
  assert.deepEqual(r2.tried, [], "round 2 walks nothing: both dates are in the future");
  assert.equal(r2.allRateLimited, true);
  assert.equal(r2.rateLimitedUntil, Date.parse(soon));
  // one CA limited, the other refusing the name: the ordinary backoff (the
  // limited CA is simply not walked)
  const mixed = await walk("", { cas: [{ host: ZS, outcome: "rateLimited", retryAfterDetail: LE_DETAIL }, { host: LE, outcome: "nameErr" }] });
  assert.equal(mixed.rounds[0].plan.why, "backoff");
  assert.equal(mixed.rounds[0].plan.failures, 1);
});
