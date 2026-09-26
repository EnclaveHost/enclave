// The per-deployment protection rules on the VBS box, checked against the PLATFORM RUNNER's own
// self-test seam (supervisor.js WAF_SELFTEST) rather than against my reading of it.
//
// Why that way round: the options envelope is FAIL-CLOSED, so a runner that does not know a
// namespace refuses the whole deployment, and the relay AND-folds `waf` across the fleet before
// the console offers the controls. A box that parsed these rules differently would leave the same
// deployment protected in one place and open in another, with nothing having said so. Identical
// error strings matter for the same reason: they are what a deployer reads when a rule is rejected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWaf, pathBlocked, check, forget, clientIp, bucketCount, SCANNER_PATHS } from "../windows/node/waf.mjs";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

/** The platform runner's verdicts for the same inputs. */
async function platform(c) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", WAF_SELFTEST: JSON.stringify(c),
           SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "",
           REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
           APP_CERT_DOMAIN: "", DNS_API: "" }, maxBuffer: 8 << 20 });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const PARSE_CASES = [
  '{"waf":{"rps":5}}', '{"waf":{"rps":5,"burst":40}}', '{"waf":{"burst":40}}',
  '{"waf":{"rps":0.05}}', '{"waf":{"rps":20000}}', '{"waf":{"maxConcurrent":4}}',
  '{"waf":{"maxConcurrent":4.5}}', '{"waf":{"maxBodyMb":2}}', '{"waf":{"maxBodyMb":0}}',
  '{"waf":{"methods":["get","POST","get"]}}', '{"waf":{"methods":["GETTTTTTTTTTT"]}}',
  '{"waf":{"methods":[]}}', '{"waf":{"pathBlock":["/Admin","/admin"]}}',
  '{"waf":{"pathBlock":["admin"]}}', '{"waf":{"uaBlock":["CurL","bot"]}}',
  '{"waf":{"uaBlock":["ab"]}}', '{"waf":{"blockScanners":true}}', '{"waf":{"blockScanners":false}}',
  '{"waf":{"blockScanners":"yes"}}', '{"waf":{}}', '{"waf":[]}', '{"waf":{"nope":1}}',
  '{"waf":{"rps":5,"maxConcurrent":2,"maxBodyMb":1.5,"methods":["GET"],"pathBlock":["/x"],"uaBlock":["bot"],"blockScanners":true}}',
];
const PATH_CASES = [
  { waf: { blockScanners: true }, url: "/.env" },
  { waf: { blockScanners: true }, url: "/%2e%65nv" },
  { waf: { blockScanners: true }, url: "//.env" },
  { waf: { blockScanners: true }, url: "/.ENV?x=1" },
  { waf: { blockScanners: true }, url: "/ok" },
  { waf: { blockScanners: true }, url: "/wp-admin/x" },
  { waf: { pathBlock: ["/admin"] }, url: "/ADMIN/panel" },
  { waf: { pathBlock: ["/admin"] }, url: "/administrator" },
  { waf: { pathBlock: ["/admin"] }, url: "/x/admin" },
  { waf: { pathBlock: ["/a"] }, url: "/%ZZ" },
  { waf: {}, url: "/.env" },
];

test("every rule parses exactly as the platform runner parses it, errors included", async () => {
  const plat = await platform({ parse: PARSE_CASES, paths: [] });
  for (const [i, raw] of PARSE_CASES.entries()) {
    const p = plat.parse[i];
    let mine;
    try { mine = { ok: { waf: parseWaf(JSON.parse(raw).waf) } }; } catch (e) { mine = { err: e.message }; }
    assert.equal(mine.ok ? JSON.stringify(mine.ok.waf) : `ERR:${mine.err}`,
                 p.ok ? JSON.stringify(p.ok.waf) : `ERR:${p.err}`,
                 `case ${i}: ${raw}`);
  }
});

test("every path verdict matches the platform runner's, encoding tricks included", async () => {
  const plat = await platform({ parse: [], paths: PATH_CASES });
  for (const [i, c] of PATH_CASES.entries())
    assert.equal(pathBlocked(c.waf, c.url), plat.paths[i], `case ${i}: ${JSON.stringify(c)}`);
});

test("the scanner list is the platform's, not an approximation of it", async () => {
  // Each entry, asserted to block on the platform side too. A list that drifted would quietly stop
  // blocking something a deployer believes is blocked.
  const cases = SCANNER_PATHS.map((p) => ({ waf: { blockScanners: true }, url: p }));
  const plat = await platform({ parse: [], paths: cases });
  assert.ok(SCANNER_PATHS.length >= 25);
  for (const [i, c] of cases.entries()) {
    assert.equal(plat.paths[i], true, `the platform no longer blocks ${c.url}`);
    assert.equal(pathBlocked(c.waf, c.url), true, `this box no longer blocks ${c.url}`);
  }
});

// ---- enforcement, which the platform seam does not expose ------------------------------------

test("a method outside the allowed set is refused with the platform's status and code", () => {
  const w = parseWaf({ methods: ["GET"] });
  const v = check("0x1", w, { method: "POST", url: "/", headers: {}, ip: "1.2.3.4" });
  assert.equal(v.status, 405);
  assert.equal(v.error, "waf_method");
  assert.match(v.message, /allow only: GET/);
  assert.equal(check("0x1", w, { method: "GET", url: "/", headers: {}, ip: "1.2.3.4" }).allow, true);
});

test("a blocked agent and a blocked path each answer 403", () => {
  const ua = parseWaf({ uaBlock: ["badbot"] });
  assert.equal(check("0x2", ua, { method: "GET", url: "/", headers: { "user-agent": "X BadBot/1" }, ip: "a" }).error, "waf_agent");
  assert.equal(check("0x2", ua, { method: "GET", url: "/", headers: { "user-agent": "Mozilla" }, ip: "a" }).allow, true);
  const pb = parseWaf({ pathBlock: ["/admin"] });
  assert.equal(check("0x3", pb, { method: "GET", url: "/admin/x", headers: {}, ip: "a" }).status, 403);
});

test("an over-large declared body is refused before the app sees a byte", () => {
  const w = parseWaf({ maxBodyMb: 1 });
  const v = check("0x4", w, { method: "POST", url: "/", headers: { "content-length": String(2 * 1048576) }, ip: "a" });
  assert.equal(v.status, 413);
  assert.equal(v.error, "waf_body");
  assert.equal(check("0x4", w, { method: "POST", url: "/", headers: { "content-length": "1024" }, ip: "a" }).allow, true);
});

test("the rate limit is a token bucket, per address, and it refills", async () => {
  forget("0x5");
  const w = parseWaf({ rps: 5, burst: 3 });
  const req = (ip) => check("0x5", w, { method: "GET", url: "/", headers: {}, ip });
  assert.equal(req("1.1.1.1").allow, true);
  assert.equal(req("1.1.1.1").allow, true);
  assert.equal(req("1.1.1.1").allow, true);
  const denied = req("1.1.1.1");
  assert.equal(denied.status, 429);
  assert.equal(denied.error, "waf_rate_limited");
  assert.ok(Number(denied.headers["retry-after"]) >= 1, "it says when to come back");
  // A DIFFERENT address has its own bucket - that is what "per address" means.
  assert.equal(req("2.2.2.2").allow, true);
  // ...and the first one refills: 5/sec, so ~250ms buys a token back.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(req("1.1.1.1").allow, true);
});

test("concurrency counts what is IN FLIGHT, and a released slot comes back", () => {
  forget("0x6");
  const w = parseWaf({ maxConcurrent: 2 });
  const req = () => check("0x6", w, { method: "GET", url: "/", headers: {}, ip: "9.9.9.9" });
  const a = req(), b = req();
  assert.equal(a.allow, true); assert.equal(b.allow, true);
  const c = req();
  assert.equal(c.status, 429);
  assert.equal(c.error, "waf_busy");
  a.release();
  assert.equal(req().allow, true, "finishing a request frees its slot");
  // Releasing twice must not credit a slot that was never taken.
  b.release(); b.release();
  const d = req(), e = req();
  assert.equal(d.allow, true);
  assert.equal(e.status, 429, "a double release did not inflate the limit");
});

test("a refused request does not hold a concurrency slot", () => {
  forget("0x7");
  // rps runs AFTER maxConcurrent, so a rate-refused request has already taken a slot and has to
  // give it back - otherwise a client that trips the rate limit slowly starves itself of slots.
  const w = parseWaf({ rps: 0.1, burst: 1, maxConcurrent: 1 });
  const first = check("0x7", w, { method: "GET", url: "/", headers: {}, ip: "7.7.7.7" });
  assert.equal(first.allow, true);
  first.release();
  const second = check("0x7", w, { method: "GET", url: "/", headers: {}, ip: "7.7.7.7" });
  assert.equal(second.error, "waf_rate_limited");
  // The slot the refused request briefly took is back, so a later allowed request can have it.
  const st = check("0x7", parseWaf({ maxConcurrent: 1 }), { method: "GET", url: "/", headers: {}, ip: "7.7.7.7" });
  assert.equal(st.allow, true);
});

test("the per-address bucket map cannot be grown without end by the sender, and the rule still holds for a live address that arrived after the flood (eviction is FIFO)", (t) => {
  // The buckets are keyed by CLIENT ADDRESS, so their number is chosen by whoever is sending
  // traffic - the wrong person to let decide how much memory this box uses. A sweep handles
  // addresses that go idle; this is the other case, a burst from many addresses at once.
  // The buckets refill from the wall clock (waf.mjs Date.now), and at rps 1000 one millisecond is a
  // token: the six requests below used to straddle a millisecond (or a GC pause after the 6000-address
  // flood) and let the 6th through - 3 of 24 main runs on 09-26, 8 of 200 local runs. The clock is
  // frozen for this test, so what it measures is the rule, not the scheduler.
  t.mock.timers.enable({ apis: ["Date"], now: 1_790_000_000_000 });
  forget("0x9");
  const w = parseWaf({ rps: 1000, burst: 5 });
  for (let i = 0; i < 6000; i++)
    check("0x9", w, { method: "GET", url: "/", headers: {}, ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` });
  assert.ok(bucketCount("0x9") <= 4096, `tracking ${bucketCount("0x9")} addresses`);
  // ...and the limit still WORKS for a live address that arrived AFTER the flood. Eviction is FIFO by arrival, not LRU
  // (waf.mjs), so a later flood of 4096 new addresses can evict an OLDER live address's bucket and hand it a fresh burst.
  // Backlog note, not a defect (enclave-87): it gives nothing to a sender who controls 4096+ addresses, since they could
  // spread their requests across them anyway.
  const ip = "10.99.99.99";
  for (let i = 0; i < 5; i++) assert.equal(check("0x9", w, { method: "GET", url: "/", headers: {}, ip }).allow, true);
  assert.equal(check("0x9", w, { method: "GET", url: "/", headers: {}, ip }).status, 429,
    "evicting old buckets must not disarm the rule for a live address that arrived after the flood (eviction is FIFO)");
  // ...and the refill is still the wall clock's: one millisecond at rps 1000 is one request again
  t.mock.timers.tick(1);
  assert.equal(check("0x9", w, { method: "GET", url: "/", headers: {}, ip }).allow, true, "a token after 1 ms at rps 1000");
  assert.equal(check("0x9", w, { method: "GET", url: "/", headers: {}, ip }).status, 429, "and only one");
});

test("forgetting a deployment drops everything it was counting", () => {
  forget("0xA");
  const w = parseWaf({ rps: 1, burst: 1 });
  assert.equal(check("0xA", w, { method: "GET", url: "/", headers: {}, ip: "1.2.3.4" }).allow, true);
  assert.equal(check("0xA", w, { method: "GET", url: "/", headers: {}, ip: "1.2.3.4" }).status, 429);
  forget("0xA");
  assert.equal(bucketCount("0xA"), 0);
  // A lease handed back can be re-claimed; the returning tenant must not meet a bucket their own
  // traffic emptied an hour ago.
  assert.equal(check("0xA", w, { method: "GET", url: "/", headers: {}, ip: "1.2.3.4" }).allow, true);
});

test("no rules means no checks at all", () => {
  assert.equal(check("0x8", null, { method: "DELETE", url: "/.env", headers: {}, ip: "a" }), null);
});

test("the client address is the relay's last forwarded hop, then the socket", () => {
  assert.equal(clientIp({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }), "10.0.0.1");
  assert.equal(clientIp({}, { remoteAddress: "5.5.5.5" }), "5.5.5.5");
  assert.equal(clientIp({}), "?", "no address at all is a single shared bucket, not a bypass");
});
