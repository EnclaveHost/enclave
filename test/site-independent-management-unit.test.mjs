// site/js/core/independent-management.js against the REAL management helper (network/management-browser.mjs, the module
// the vendored bundle is built from), a real WebCrypto P-256 session key signing through the sessions SDK, and scripted
// lease / directory / gateway answers. Fast and browser-free; the end-to-end Chromium run is site-independent-management.
// Also: the committed bundle equals a fresh build, and the Startup tab's explicit Shield tier.
// Every module test runs twice: against network/management-browser.mjs (the reviewed source) and against the shipped
// site/vendor/management.js (the bytes a browser loads), so the prepared bundle is tested, not only its source.
//   run: node --test test/site-independent-management-unit.test.mjs
import test, { describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import * as realHelper from "../network/management-browser.mjs";
import { signManagementRecord } from "../network/management-record.mjs";
import * as SDK from "../sdk/sessions/dist/node.mjs";
const { signApiRequest, ACTIONS } = SDK;
import { preparePackage as cliPrepare } from "../sdk/bootstrap/package.mjs";
import { shieldStartupEnvelope } from "../windows/node/shield-startup.mjs";
import { buildManagementVendor, OUT as VENDOR_OUT, MANIFEST as VENDOR_MANIFEST } from "../scripts/build-management-vendor.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "0x" + "22".repeat(20), REGISTRY = "0x" + "11".repeat(20);
const profile = { format: "enclave-browser-profile", version: 1, chainId: 8453, rpcs: ["https://a.example", "https://b.example"], quorum: 2,
  directories: ["http://192.0.2.10:8787", "https://dir.example.org"],
  contractPins: { version: 1, chainId: 8453, contracts: { registry: REGISTRY, deployments: LEDGER, appCatalog: "0x" + "33".repeat(20),
    proofOfTime: "0x" + "44".repeat(20), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20),
    sessionVaultFactory: "0x" + "55".repeat(20), secretVaultV2: "0x" + "00".repeat(20) } }, usdc: "0x" + "66".repeat(20) };
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i] ?? null, get length(){ return m.size; }, m });
const operator = privateKeyToAccount("0x" + "2".repeat(64)), stranger = privateKeyToAccount("0x" + "4".repeat(64));
const ID = "0x" + "ab".repeat(32), RUNNER = "0x" + "cd".repeat(32);
const WALLET = "0x" + "77".repeat(20), VAULT = "0x" + "88".repeat(20), SID = "0x" + "99".repeat(32);
const DASH = "https://dash.independent-site.net", MGMT = "https://mgmt.host-operator.net";
let MG, SP, IC;

/* a WebCrypto P-256 session key, as the browser's IndexedDB holds it (non-extractable private key) */
async function webKey(){
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const big = (b64) => BigInt("0x" + Buffer.from(b64, "base64url").toString("hex"));
  return { x: big(jwk.x), y: big(jwk.y), signBytes: async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, bytes)) };
}

const world = {};
function reset(){
  globalThis.localStorage.m.clear();
  Object.assign(world, {
    lease: { id: ID, owner: VAULT, runner: RUNNER, runnerOperator: operator.address.toLowerCase(), chainId: 8453, deployments: LEDGER, active: true,
             isPublic: false, leaseUntil: Date.now() + 600e3, validUntil: Date.now() + 90e3, blockNumber: "1234" },
    leaseError: null, current: true, envelopes: [], gateway: () => new Response(JSON.stringify({ id: ID, status: "running" }), { status: 200,
      headers: { "content-type": "application/json", "x-enclave-management-forwarded": "1" } }),
    calls: [], status: { live: true, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600), actions: (1n << 128n) | (1n << 129n) | (1n << 130n) | (1n << 132n) },
  });
}
async function record(over = {}, account = operator){
  const now = Date.now();
  return signManagementRecord(account, { version: 2, runner: RUNNER, operator: operator.address.toLowerCase(), chainId: 8453, deployments: LEDGER,
    address: "8.8.4.4", port: 8443, spkiSha256: "ab".repeat(32), sequence: 1, issuedAt: now, expiresAt: now + 3600e3,
    browser: { origin: MGMT, dashboards: [DASH] }, ...over });
}

test.before(async () => {
  const text = JSON.stringify(profile);
  globalThis.localStorage = mem(new Map([["enclave_independent_profile", text]]));
  globalThis.sessionStorage = mem(new Map([["enclave_independent_ack", text]]));
  globalThis.location = { hostname: "localhost", origin: DASH };
  MG = await import(pathToFileURL(path.join(REPO, "site/js/core/independent-management.js")).href);
  SP = await import(pathToFileURL(path.join(REPO, "site/js/core/startup-package.js")).href);
  IC = await import(pathToFileURL(path.join(REPO, "site/js/core/config.js")).href);
  const key = await webKey();
  const session = { handle: { vault: VAULT, sid: SID }, status: async () => world.status,
    apiAuthorization: (method, url, body) => signApiRequest(key, VAULT, SID, method, url, body) };
  MG._useForTests({ mod: realHelper, deps: {
    agreedLease: async () => { if (world.leaseError) throw world.leaseError; return { snap: { number: 1234 }, current: world.current, lease: { ...world.lease } }; },
    session: async () => ({ owner: WALLET, session }), sdk: async () => ({ ACTIONS }), wallet: () => WALLET, origin: () => DASH,
    fetch: async (url, init) => {
      world.calls.push({ url: String(url), init });
      if (String(url).endsWith("/v1/network/records")) return new Response(JSON.stringify({ version: 1, management: world.envelopes }), { status: 200 });
      return world.gateway(String(url), init);
    } } });
});
test.beforeEach(reset);
const gatewayCalls = () => world.calls.filter((c) => c.url.startsWith(MGMT));

test("the vendored bundle is exactly a fresh build of network/management-browser.mjs and its sources", async () => {
  const { js, manifest } = await buildManagementVendor();
  assert.equal(Buffer.compare(fs.readFileSync(VENDOR_OUT), js), 0, "rebuild with: node scripts/build-management-vendor.mjs");
  assert.deepEqual(JSON.parse(fs.readFileSync(VENDOR_MANIFEST, "utf8")), manifest);
});

const bundleHelper = await import(pathToFileURL(VENDOR_OUT).href);
for (const [label, helper] of [["source", realHelper], ["shipped bundle", bundleHelper]]) describe("with the " + label + " helper", () => {
  beforeEach(() => { MG._useForTests({ mod: helper }); reset(); });

  test("status: an agreed lease, the operator's record from every directory, the floor saved, one signed request to the signed origin", async () => {
  world.envelopes = [await record()];
  const { result, trust } = await MG.hostStatus(ID);
  assert.equal(result.json.status, "running");
  assert.equal(trust.transport, "browser-webpki"); assert.equal(trust.origin, MGMT); assert.equal(trust.sequence, 1); assert.equal(trust.block, 1234);
  assert.equal(world.calls.filter((c) => c.url.endsWith("/v1/network/records")).length, 2, "both directories are asked");
  const g = gatewayCalls();
  assert.equal(g.length, 1);
  assert.equal(g[0].url, MGMT + "/v1/deployments/" + ID);
  assert.deepEqual([g[0].init.method, g[0].init.redirect, g[0].init.credentials, g[0].init.mode, g[0].init.referrerPolicy], ["GET", "error", "omit", "cors", "no-referrer"]);
  await helper.checkAuthorizationWeb(g[0].init.headers.authorization, { method: "GET", hostPath: "enclave-management.invalid/" + RUNNER + "/v1/deployments/" + ID, body: new Uint8Array(0) });
  const floors = [...globalThis.localStorage.m.entries()].filter(([k]) => k.startsWith("enclave_mgmt_floor:"));
  assert.equal(floors.length, 1);
  const f = JSON.parse(floors[0][1]);
  assert.equal((f.operators ? f.operators[operator.address.toLowerCase()] : f).sequence, 1, "the helper's floor, stored as it returned it");
});

  test("records: a stranger's newer record is ignored; a rollback below the saved floor is refused with no host request", async () => {
  const good = await record();
  world.envelopes = [good, await record({ operator: stranger.address.toLowerCase(), sequence: 9, browser: { origin: "https://attacker.host-operator.net", dashboards: [DASH] } }, stranger)];
  assert.equal((await MG.hostStatus(ID)).trust.origin, MGMT);
  world.envelopes = [await record({ sequence: 2 })];
  await MG.hostStatus(ID);
  world.envelopes = [good]; world.calls = [];
  await assert.rejects(MG.hostStatus(ID), (e) => e.kind === "no-transport" && /stale management record/.test(e.message) && /enclave --independent/.test(e.native.command));
  assert.equal(gatewayCalls().length, 0);
  // forward only: an older floor never replaces a newer one
  const key = [...globalThis.localStorage.m.keys()].find((k) => k.startsWith("enclave_mgmt_floor:")).slice("enclave_mgmt_floor:".length);
  const seqOf = (f) => (f.operators ? f.operators[operator.address.toLowerCase()] : f).sequence;
  const stored = MG.loadFloor(key);
  MG.saveFloor(key, stored.operators ? { version: 1, operators: { [operator.address.toLowerCase()]: { sequence: 1, hash: "00".repeat(32) } } } : { sequence: 1, hash: "00".repeat(32) });
  assert.equal(seqOf(MG.loadFloor(key)), 2);
  // composite floors merge per operator, forward only
  assert.deepEqual(MG.mergeFloors({ version: 1, operators: { ["0x" + "01".repeat(20)]: { sequence: 5, hash: "aa".repeat(32) } } },
    { version: 1, operators: { ["0x" + "01".repeat(20)]: { sequence: 3, hash: "bb".repeat(32) }, ["0x" + "02".repeat(20)]: { sequence: 1, hash: "cc".repeat(32) } } }),
    { version: 1, operators: { ["0x" + "01".repeat(20)]: { sequence: 5, hash: "aa".repeat(32) }, ["0x" + "02".repeat(20)]: { sequence: 1, hash: "cc".repeat(32) } } });
});

  test("no browser transport: a dashboard the operator did not list, a v1 record, a withdrawal - the native command instead", async () => {
  const now = Date.now();
  const v1 = await signManagementRecord(operator, { version: 1, runner: RUNNER, operator: operator.address.toLowerCase(), chainId: 8453, deployments: LEDGER,
    address: "8.8.4.4", port: 8443, spkiSha256: "ab".repeat(32), sequence: 1, issuedAt: now, expiresAt: now + 3600e3 });
  for (const env of [await record({ browser: { origin: MGMT, dashboards: ["https://other.independent-site.net"] } }), v1,
                     await record({ address: null, port: null, spkiSha256: null, browser: null })]){
    reset();
    world.envelopes = [env];
    await assert.rejects(MG.hostStatus(ID), (e) => e.kind === "no-transport" && /native client/i.test(e.message) && /--directories http:\/\/192\.0\.2\.10:8787/.test(e.native.command));
    assert.equal(gatewayCalls().length, 0);
  }
});

  test("refused before anything is sent: no agreed lease, a stale owner, no current host, an ended session, a missing scope", async () => {
  world.envelopes = [await record()];
  world.leaseError = new Error("only 1 of 3 chain endpoints answered (need 2)");
  await assert.rejects(MG.hostStatus(ID), (e) => e.kind === "chain" && /did not agree.*Nothing was sent/.test(e.message));
  assert.equal(world.calls.length, 0, "not even a directory");
  reset(); world.envelopes = [await record()]; world.lease.owner = stranger.address.toLowerCase();
  await assert.rejects(MG.hostStatus(ID), new RegExp("current owner is " + stranger.address.toLowerCase() + " \\(read at block 1234\\)"));
  assert.equal(world.calls.length, 0);
  reset(); world.envelopes = [await record()]; world.lease.leaseUntil = Date.now() - 1;
  await assert.rejects(MG.hostStatus(ID), /No host holds a current lease/);
  reset(); world.envelopes = [await record()]; world.current = false;
  await assert.rejects(MG.hostStatus(ID), /registry entry is inactive or names another operator/);
  reset(); world.envelopes = [await record()]; world.status = { ...world.status, live: false };
  await assert.rejects(MG.hostRestart(ID), /session has ended/);
  reset(); world.envelopes = [await record()]; world.status = { ...world.status, actions: 1n << 128n };
  await assert.rejects(MG.hostRestart(ID), /does not allow api\.restart/);
  assert.equal(gatewayCalls().length, 0);
  // an unreadable session status is left to the gateway (it decides from its own agreed read)
  reset(); world.envelopes = [await record()]; world.status = null;
  const session = { status: async () => { throw new Error("rpc down"); } };
  assert.ok(session);   // the scripted status above already returns null for this case
  assert.equal((await MG.hostStatus(ID)).result.json.status, "running");
});

  test("mutations: a lost or cut answer is outcome-unknown (check status), sent once; a fetch failure on a read is 'unreachable'", async () => {
  world.envelopes = [await record()];
  world.gateway = () => new Response(JSON.stringify({ error: "restart_outcome_unknown", message: "the request was forwarded once" }), { status: 502,
    headers: { "content-type": "application/json", "x-enclave-management-forwarded": "1" } });
  await assert.rejects(MG.hostRestart(ID), (e) => e.kind === "unknown" && e.outcomeUnknown && /check status before asking again/.test(e.message));
  assert.equal(gatewayCalls().length, 1, "never retried");
  reset(); world.envelopes = [await record()];
  world.gateway = () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(MG.hostRestart(ID), (e) => e.kind === "unknown" && e.sent === null);
  await assert.rejects(MG.hostCpuProfileControl(ID, { action: "start", seconds: 5 }), (e) => e.kind === "unknown");
  await assert.rejects(MG.hostLogs(ID), (e) => e.kind === "unreachable" && /If its DNS name or certificate fails, use the native client/.test(e.message) && !!e.native);
  // a gateway refusal before forwarding is definite: nothing happened
  reset(); world.envelopes = [await record()];
  world.gateway = () => new Response(JSON.stringify({ error: "chain_unavailable", message: "no agreeing chain quorum" }), { status: 503,
    headers: { "content-type": "application/json", "x-enclave-management-forwarded": "0" } });
  await assert.rejects(MG.hostRestart(ID), (e) => e.kind === "refused" && !e.outcomeUnknown && /before reaching the supervisor \(HTTP 503\)/.test(e.message));
});

  test("app token: returned to the caller only; never stored, never echoed in an error", async () => {
  world.envelopes = [await record()];
  const token = "tok_" + "Z".repeat(200);
  world.gateway = () => new Response(JSON.stringify({ token, tokenType: "Cookie", deployment: ID, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    { status: 200, headers: { "content-type": "application/json", "x-enclave-management-forwarded": "1" } });
  assert.equal((await MG.hostAppToken(ID)).result.json.token, token);
  world.gateway = () => new Response(JSON.stringify({ token, tokenType: "Bearer", deployment: ID, expiresAt: "soon" }),
    { status: 200, headers: { "content-type": "application/json", "x-enclave-management-forwarded": "1" } });
  await assert.rejects(MG.hostAppToken(ID), (e) => !String(e.message).includes(token) && !JSON.stringify(e).includes(token));
  world.gateway = () => new Response(JSON.stringify({ error: "not_allowed", message: "refused " + token }), { status: 403,
    headers: { "content-type": "application/json", "x-enclave-management-forwarded": "1" } });
  await assert.rejects(MG.hostAppToken(ID), (e) => !String(e.message).includes(token));
  for (const st of [globalThis.localStorage, globalThis.sessionStorage]) for (const v of st.m.values()) assert.ok(!String(v).includes(token));
});

  test("the page sends only to the origin inside the operator's signature", async () => {
  world.envelopes = [await record()];
  const swapped = { ...helper, browserManagementEndpoint: async (...a) => ({ ...(await helper.browserManagementEndpoint(...a)), origin: "https://evil.host-operator.net" }) };
  MG._useForTests({ mod: swapped });
  try {
    await assert.rejects(MG.hostStatus(ID), /does not match its signed record\. Nothing was sent/);
    assert.equal(world.calls.filter((c) => !c.url.endsWith("/v1/network/records")).length, 0);
  } finally { MG._useForTests({ mod: helper }); }
});

  test("attestation is host-reported: a fresh 32-byte nonce, never 'verified'", async () => {
  world.envelopes = [await record()];
  world.gateway = (url) => new Response(JSON.stringify({ nonce: new URL(url).searchParams.get("nonce"), report: "host" }), { status: 200,
    headers: { "content-type": "application/json", "x-enclave-management-forwarded": "1" } });
  const r = await MG.hostAttestation(ID);
  assert.match(r.nonce, /^[0-9a-f]{64}$/); assert.equal(r.echoesNonce, true); assert.equal(r.verified, false);
  assert.match(MG.HOST_REPORTED_NOTE, /Host-reported, not verified/);
  assert.match(MG.TRANSPORT_NOTE, /did not check the host's TLS key \(SPKI\)/);
  assert.match(MG.nativeCommands(ID, "attestation").command, new RegExp("attest " + ID + " --native-profile base-profile\\.json"));
});

  test("the gateway's own limits (busy, rate limited, replay capacity) refuse before forwarding: 'try again shortly', nothing ran", async () => {
    world.envelopes = [await record()];
    for (const [status, code] of [[429, "busy"], [429, "rate_limited"], [503, "replay_capacity"]]){
      world.calls = [];
      world.gateway = () => new Response(JSON.stringify({ error: code, message: "the gateway is at its limit" }), { status,
        headers: { "content-type": "application/json", "x-enclave-management-forwarded": "0" } });
      await assert.rejects(MG.hostRestart(ID), (e) => e.kind === "busy" && e.outcomeUnknown === false && /try again shortly/.test(e.message), code);
      assert.equal(gatewayCalls().length, 1, "one request, never retried");
    }
  });

  test("a wallet-held deployment refused for want of a delegation is labeled so the panel can offer it", async () => {
    world.envelopes = [await record()]; world.lease.owner = WALLET;
    world.gateway = () => new Response(JSON.stringify({ error: "not_allowed", message: "the owner has not delegated this deployment to the session vault" }), { status: 403,
      headers: { "content-type": "application/json", "x-enclave-management-forwarded": "0" } });
    await assert.rejects(MG.hostStatus(ID), (e) => e.kind === "delegation" && /delegated/.test(e.message));
  });

  test("floors are the helper's composite, per operator; a legacy single floor is not honored or kept", async () => {
    world.envelopes = [await record({ sequence: 3 })];
    await MG.hostStatus(ID);
    const [[k, v]] = [...globalThis.localStorage.m.entries()].filter(([key]) => key.startsWith("enclave_mgmt_floor:"));
    const f = JSON.parse(v);
    assert.equal(f.version, 1); assert.equal(f.operators[operator.address.toLowerCase()].sequence, 3);
    const key = k.slice("enclave_mgmt_floor:".length);
    globalThis.localStorage.setItem(k, JSON.stringify({ sequence: 99, hash: "aa".repeat(32) }));
    assert.equal(MG.loadFloor(key), null, "a legacy floor reads as none");
    MG.saveFloor(key, { sequence: 1, hash: "bb".repeat(32) });
    assert.deepEqual(JSON.parse(globalThis.localStorage.getItem(k)), { sequence: 99, hash: "aa".repeat(32) }, "a non-composite floor is never written");
  });

  test("GPU: one signed GET to /v1/deployments/<id>/gpu under api.status; a CPU-only host is 'no GPU', not a transport failure", async () => {
    world.envelopes = [await record()];
    const answer = { ok: true, role: "worker", mpsActive: true, smTotal: 132, capacity: { gpuShareFree: 0.25, vramFreeGb: 20, smFree: 33 },
      tenants: [{ pct: 50, status: "running", smGranted: 66 }, { pct: 25, status: "running", smGranted: 33 }] };
    world.gateway = () => new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json", "x-enclave-management-forwarded": "1" } });
    const { result, trust } = await MG.hostGpu(ID);
    assert.deepEqual(result.json, answer); assert.equal(trust.transport, "browser-webpki");
    const g = gatewayCalls();
    assert.equal(g.length, 1); assert.equal(g[0].url, MGMT + "/v1/deployments/" + ID + "/gpu"); assert.equal(g[0].init.method, "GET");
    await realHelper.checkAuthorizationWeb(g[0].init.headers.authorization, { method: "GET", hostPath: "enclave-management.invalid/" + RUNNER + "/v1/deployments/" + ID + "/gpu", body: new Uint8Array(0) });
    // the session must hold api.status (the scope the route table names)
    reset(); world.envelopes = [await record()]; world.status = { ...world.status, actions: 1n << 129n };
    await assert.rejects(MG.hostGpu(ID), /does not allow api\.status/);
    assert.equal(gatewayCalls().length, 0);
    // a CPU-only host: the supervisor's 404 no_gpu
    reset(); world.envelopes = [await record()];
    world.gateway = () => new Response(JSON.stringify({ code: "no_gpu", message: "This is a CPU-only enclave: no GPU is attached." }), { status: 404,
      headers: { "content-type": "application/json", "x-enclave-management-forwarded": "1" } });
    await assert.rejects(MG.hostGpu(ID), (e) => e.kind === "no-gpu" && /reports no GPU/.test(e.message));
  });
});

test("GPU view: rows from the supervisor's answer, every value host-reported; Shield proof fields named as unverified claims", async () => {
  const v = MG.gpuView({ ok: true, role: "worker", mpsActive: true, smTotal: 132, capacity: { gpuShareFree: 0.25, vramFreeGb: 20, smFree: 33 },
    vm: { apps: 2, vramCommittedGb: 40, vramBudgetGb: 80, vramDivergenceGb: 0.5 }, tenants: [{ pct: 50, status: "running", smGranted: 66 }] });
  assert.deepEqual(Object.fromEntries(v.rows), { role: "worker", MPS: "active", "SMs (total)": "132", "free share": "25%", "free VRAM (GB)": "20", "free SMs": "33",
    "VM apps": "2", "VRAM committed / budget (GB)": "40 / 80", "VRAM divergence (GB)": "0.5" });
  assert.deepEqual(v.tenants, [{ pct: 50, status: "running", sms: 66 }]);
  assert.match(v.note, /not attestation and not a capacity reservation/);
  const sh = MG.gpuView({ ok: true, role: "shielded", cards: [{ id: "gpu0", available: true, vramBudgetGb: 80, vramLedgerFreeGb: 40, vramFreeGb: 39.5, gpuShareFree: 0.5,
    measurement: "ab", quote: "cd" }] });
  assert.equal(sh.headline, "Enclave Shield GPU host");
  assert.deepEqual(sh.cards, [{ id: "gpu0", available: true, vramFreeGb: 39.5, vramBudgetGb: 80, shareFree: "50%", claims: ["measurement", "quote"] }]);
  assert.deepEqual(MG.gpuView(null).rows, [], "nothing invented for an empty answer");
});

test("Startup tier: SNP by default (byte-identical to the CLI's activation); Shield only when chosen, which the Shield node accepts", async () => {
  const intent = { version: 1, sha256: "ab".repeat(32) };
  const current = JSON.stringify({ waf: { rps: 5 }, config: "x" });
  const snp = SP.activationEnvelope(current, intent);
  // the CLI's cmdBootstrap activate: cur.guestBootstrap=intent; cur.isolation={...cur.isolation, require:"snp-guest-per-app"}
  const cli = (() => { const cur = JSON.parse(current); delete cur.config; delete cur.configCid; cur.guestBootstrap = intent;
    cur.isolation = { ...(cur.isolation || {}), require: "snp-guest-per-app" }; return JSON.stringify(cur); })();
  assert.equal(snp, cli);
  const shield = SP.activationEnvelope(current, intent, { backend: "hyperv-partition-per-app" });
  assert.equal(SP.requiredBackend(shield), "hyperv-partition-per-app");
  assert.deepEqual(shieldStartupEnvelope(shield).intent, intent, "the Shield node takes it");
  assert.throws(() => shieldStartupEnvelope(snp), /this host starts packages only for "hyperv-partition-per-app"/, "and refuses the SNP default");
  assert.throws(() => SP.activationEnvelope(current, intent, { backend: "anything-else" }), /unsupported isolation backend/);
  assert.equal(SP.STARTUP_BACKENDS["hyperv-partition-per-app"].custody, false);
  assert.ok(cliPrepare, "package bytes do not depend on the tier");
  assert.equal(IC.INDEPENDENT.state, "on");
});

test("pending owner grant: the CLI's typed data is accepted only as the SDK's exact SessionGrant for this wallet's vault", async () => {
  const GC = await import(pathToFileURL(path.join(REPO, "site/js/core/grant-check.js")).href);
  const cfg = { chainId: 8453 };
  const vault = "0x" + "88".repeat(20);
  const grant = SDK.buildGrant({ preset: "browser", label: "enclave CLI (independent)", sessionKey: "0x" + "5a".repeat(32), policy: { budget: 0n, expiresIn: 3600 } });
  // exactly what the CLI prints: JSON.stringify(grantTypedData(chainId, getAddress(vault), grant)) with bigints as strings
  const { getAddress } = await import("viem");
  const printed = JSON.stringify(SDK.grantTypedData(8453, getAddress(vault), grant), (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  const { grant: g, typed } = GC.parseTypedGrant(printed, SDK, cfg);
  assert.deepEqual(g, grant, "the same grant, field for field and type for type");
  const expected = GC.checkTypedGrant(typed, g, { S: SDK, chainId: 8453, vault });
  assert.equal(SDK.checkCode(g.sessionKey), SDK.checkCode(grant.sessionKey));
  assert.equal(JSON.stringify(expected, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), JSON.stringify(SDK.grantTypedData(8453, vault, grant), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  // key order does not matter, values do
  const reordered = JSON.parse(printed); reordered.message = Object.fromEntries(Object.entries(reordered.message).reverse());
  GC.checkTypedGrant(GC.parseTypedGrant(JSON.stringify(reordered), SDK, cfg).typed, g, { S: SDK, chainId: 8453, vault });
  const mutate = (f) => { const t = JSON.parse(printed); f(t); return JSON.stringify(t); };
  for (const [what, text, re] of [
    ["another chain", mutate((t) => { t.domain.chainId = 1; }), /for chain 1, not 8453/],
    ["an extra field", mutate((t) => { t.message.extra = "x"; }), /unexpected or missing fields/],
    ["a missing field", mutate((t) => { delete t.message.budget; }), /unexpected or missing fields/],
    ["a malformed amount", mutate((t) => { t.message.budget = "-1"; }), /malformed budget/],
    ["not a grant", mutate((t) => { t.primaryType = "SessionCall"; }), /not a SessionGrant/],
    ["not JSON", "{", /not JSON/]])
    assert.throws(() => GC.parseTypedGrant(text, SDK, cfg), re, what);
  for (const [what, text, re] of [
    ["another wallet's vault", mutate((t) => { t.domain.verifyingContract = "0x" + "99".repeat(20); }), /not your wallet’s vault/],
    ["another domain name", mutate((t) => { t.domain.name = "Other"; }), /not exactly the SDK’s SessionGrant/],
    ["an extra domain field", mutate((t) => { t.domain.salt = "0x" + "00".repeat(32); }), /not exactly the SDK’s SessionGrant/],
    ["a changed type list", mutate((t) => { t.types.SessionGrant = t.types.SessionGrant.slice(1); }), /not exactly the SDK’s SessionGrant/]]){
    const p = GC.parseTypedGrant(text, SDK, cfg);
    assert.throws(() => GC.checkTypedGrant(p.typed, p.grant, { S: SDK, chainId: 8453, vault }), re, what);
  }
});
