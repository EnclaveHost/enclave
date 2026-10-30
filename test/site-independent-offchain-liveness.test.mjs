// Off-chain host liveness in the real dashboard (Chromium): the original-style factory and address-book profile on a local
// chain whose hosts all registered two hours ago (old registry lastSeen; nothing heartbeats). Each host's own
// GET <endpoint>/v1/host/capacity and one capacity mirror are answered by the test (Playwright routes; the endpoints are
// the registered names), with records signed by the hosts' anvil fixture keys - never production keys.
//   A  fresh record from the host itself                     -> live, listed and selectable (old lastSeen notwithstanding)
//   B  host unreachable, its record from the mirror           -> live (no single source required)
//   C  signed by a key that is not the registered operator  -> refused
//   D  forged (names the operator, another key signed)       -> refused
//   E  a record for another endpoint                          -> refused
//   F  expired                                                -> refused
//   G  fresh record, then the operator deregisters on chain  -> listed, then gone (status change)
// Then the mirror goes down (B is reported as an outage, not "no capacity") and finally A hangs: the dialog still completes
// within its bound and says the hosts could not be confirmed live.
//   node test/helpers/memory-guard.mjs --max-rss-mib 1408 --floor-available-mib 16384 -- node --test test/site-independent-offchain-liveness.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startRig, haveTools, walletScript, KEYS } from "./helpers/independent-browser-rig.mjs";
import { buildHostCapacityRecord, signHostCapacity, hostCapacityMessage } from "../network/host-capacity.mjs";

const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium; try { ({ chromium } = require("playwright")); } catch {}
const skip = haveTools() || (!chromium && "Playwright unavailable");
const ADMIN = KEYS.deployer;   // anvil #0: the platform administrator of this local chain
// public anvil fixture accounts #5..#9 (never production keys): the extra hosts' operators
const FIX = ["0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"];
const MIRROR = "https://mirror.liveness.test";
const PAST = 7200;

test("signed off-chain liveness in the dashboard: verified records list old-lastSeen hosts; every bad record, inactive row and outage is told apart", { skip: skip || false, timeout: 420000 }, async () => {
  let rig, browser;
  const forbidden = [], asked = [];
  try {
    rig = await startRig({ legacySessionFactory: true, pastSec: PAST });
    rig.profile.addressBook = rig.addresses.book;
    rig.profile.capacityDirectories = [MIRROR];
    const admin = rig.wc(ADMIN), reg = rig.addresses.registry.toLowerCase();
    // the extra hosts register now - still two hours ago on this chain
    const [kC, kD, kE, kF, kG] = FIX.map((k) => privateKeyToAccount(k));
    const ep = { A: rig.endpoint, B: rig.endpoint2, C: "https://wrong-operator.liveness.test", D: "https://forged.liveness.test",
      E: "https://wrong-endpoint.liveness.test", F: "https://stale.liveness.test", G: "https://leaving.liveness.test" };
    for (const [k, e, price] of [[FIX[0], ep.C, 900n], [FIX[1], ep.D, 950n], [FIX[2], ep.E, 980n], [FIX[3], ep.F, 990n], [FIX[4], ep.G, 2000n]])
      await rig.write(rig.wc(k), rig.addresses.registry, rig.abi.registry, "register", [e, "independent/host", "0x" + "00".repeat(32), price, 0n,
        "0x0000000000000000000000000000000000000000"]);
    // an app to open the quick-deploy dialog for (published and approved by the platform administrator)
    await rig.write(admin, rig.addresses.catalog, rig.abi.catalog, "publishVersion", ["liveapp", "Live app", "Liveness fixture", "1",
      "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", [0, 0, 64, 1], "http:8080", "{}", 0n]);
    const appId = await rig.pc.readContract({ address: rig.addresses.catalog, abi: rig.abi.catalog, functionName: "appIdOf", args: [admin.account.address, "liveapp"] });
    await rig.write(admin, rig.addresses.catalog, rig.abi.catalog, "setApproval", [appId, 0n, 1]);
    const lastSeenAtRegistration = Number((await rig.pc.getBlock()).timestamp);
    await rig.jumpToNow();
    assert.ok(Math.floor(Date.now() / 1000) - lastSeenAtRegistration > 3600, "every host's registry write is over an hour old");

    // records, signed now by the hosts' fixture keys
    const opA = privateKeyToAccount(KEYS.operator), opB = privateKeyToAccount(KEYS.operator2);
    const avail = JSON.stringify({ gpu: false, maxShare: 1, cpuShareFree: 1, claimEnabled: true, vcpusFree: 4 });
    const rec = (endpoint, operator, { issuedAt = Date.now(), lifetimeMs = 5 * 60_000 } = {}) =>
      buildHostCapacityRecord({ availability: avail, chainId: 8453, registry: reg, endpoint, operator: operator.address, now: issuedAt, lifetimeMs });
    const sign = (account, record) => signHostCapacity(account, record);
    const forge = async (by, record) => ({ record, signature: await by.signMessage({ message: hostCapacityMessage(record) }) });
    const served = new Map([
      [ep.A + "/v1/host/capacity", await sign(opA, rec(ep.A, opA))],
      [ep.B + "/v1/host/capacity", "abort"],
      [MIRROR + "/v1/host-capacity", { records: [await sign(opB, rec(ep.B, opB))] }],
      [ep.C + "/v1/host/capacity", await sign(kD, rec(ep.C, kD))],                         // signed by D's key; the registry names C's
      [ep.D + "/v1/host/capacity", await forge(kE, rec(ep.D, kD))],                        // names D's operator, E signed
      [ep.E + "/v1/host/capacity", await sign(kE, rec("https://elsewhere.liveness.test", kE))],
      [ep.F + "/v1/host/capacity", await sign(kF, rec(ep.F, kF, { issuedAt: Date.now() - 20 * 60_000, lifetimeMs: 10 * 60_000 }))],
      [ep.G + "/v1/host/capacity", await sign(kG, rec(ep.G, kG))],
    ]);

    browser = await chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1", "--disable-extensions",
      "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return route.continue();
      const k = u.origin + u.pathname, v = served.get(k);
      asked.push(k);
      if (v === undefined){ forbidden.push(u.href); return route.abort(); }
      if (v === "abort") return route.abort("connectionrefused");
      if (v === "hang") return;                                   // never answered: only the page's own timeout ends it
      return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(v) });
    });
    await context.addInitScript(({ profile, address }) => {
      const text = JSON.stringify(profile);
      localStorage.setItem("enclave_independent_profile", text);
      sessionStorage.setItem("enclave_independent_ack", text);
      localStorage.setItem("enclave_session", JSON.stringify({ address, rdns: "test.local.wallet" }));
    }, { profile: rig.profile, address: rig.owner });
    await context.addInitScript({ content: walletScript({ rpc: rig.rpc, address: rig.owner }) });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));

    const quotes = () => page.evaluate(async () => {
      const q = await (await import("/js/core/independent-chain.js")).independentQuotes({ gpuMilli: 0, cpuMilli: 100, owner: "" });
      return { block: q.block, note: q.liveness.note, verified: q.liveness.verified, complete: q.liveness.complete,
        hosts: q.hosts.map((h) => ({ endpoint: h.endpoint, eligible: h.eligible, reason: h.reason, evidence: h.liveness.evidence, source: h.liveness.source,
          lastSeen: h.lastSeen, registryLastSeen: h.registryLastSeen })) };
    });
    const dialog = async () => {
      const t0 = Date.now();
      await page.goto(rig.site + "/apps?app=" + appId);
      await page.locator('#appDetailView [data-act="deploy"]').first().click({ timeout: 60000 });
      await page.waitForSelector(".qd-indhost", { timeout: 60000 });
      const options = await page.locator(".qd-indhost option").allTextContents();
      const warn = await page.locator(".qd-indev").textContent().catch(() => "");
      const none = await page.locator(".qd-indnone").textContent().catch(() => "");
      return { options, warn, none, ms: Date.now() - t0 };
    };
    const by = (q) => Object.fromEntries(q.hosts.map((h) => [h.endpoint, h]));
    await page.goto(rig.site + "/dashboard");

    // ---- 1. fresh records ----
    let q = await quotes(), h = by(q);
    for (const k of ["A", "B", "G"]){
      assert.equal(h[ep[k]].eligible, true, k + ": " + h[ep[k]].reason);
      assert.equal(h[ep[k]].evidence, "signed-record", k);
      assert.ok(h[ep[k]].registryLastSeen <= lastSeenAtRegistration, k + " has the old registry lastSeen");
      assert.ok(h[ep[k]].lastSeen > lastSeenAtRegistration + 3600, k + "'s lastSeen is the record's issue time");
    }
    assert.match(h[ep.C].reason, /not the host's current registry operator/);
    assert.match(h[ep.D].reason, /not signed by its operator/);
    assert.match(h[ep.E].reason, /another endpoint/);
    assert.match(h[ep.F].reason, /expired/);
    for (const k of ["C", "D", "E", "F"]) assert.equal(h[ep[k]].eligible, false, k);
    assert.equal(h[ep.A].source, "host");
    assert.equal(h[ep.B].source, MIRROR, "B's own endpoint is down; its record came from the mirror");
    assert.equal(q.note, "", "nothing is missing: every admitted host's liveness was decided");
    // the real dialog: exactly the live hosts, labelled by their evidence; host A selected
    let d = await dialog();
    const listed = (e) => d.options.some((o) => o.includes(e));
    for (const k of ["A", "B", "G"]) assert.ok(listed(ep[k]), k + " listed: " + JSON.stringify(d.options));
    for (const k of ["C", "D", "E", "F"]) assert.ok(!listed(ep[k]), k + " not listed");
    assert.ok(d.options.filter((o) => o.includes("http")).every((o) => /live: signed record/.test(o)), JSON.stringify(d.options));
    const idA = await page.locator(".qd-indhost option", { hasText: ep.A }).getAttribute("value");
    await page.locator(".qd-indhost").selectOption(idA);
    assert.equal(await page.locator(".qd-indhost").inputValue(), idA, "host A is selectable");
    assert.match(await page.locator(".qd-capnote").textContent(), /live host\(s\) post a price at or under this ceiling/);
    // direct-chain discovery (/enclaves shape) agrees
    const rows = await page.evaluate(async () => (await (await import("/js/core/api.js")).Enclave.getEnclaves())
      .map((r) => ({ endpoint: r.endpoint, serving: r.serving, evidence: r.liveness.evidence })));
    const serving = rows.filter((r) => r.serving).map((r) => r.endpoint).sort();
    assert.deepEqual(serving, [ep.A, ep.B, ep.G].sort());

    // ---- 2. status change: G's operator deregisters (an on-chain status write); its still-valid record no longer counts ----
    const gId = await rig.pc.readContract({ address: rig.addresses.registry, abi: rig.abi.registry, functionName: "idOf", args: [ep.G] });
    await rig.write(rig.wc(FIX[4]), rig.addresses.registry, rig.abi.registry, "deregister", [gId]);
    await rig.pc.request({ method: "evm_mine", params: [] });
    q = await quotes(); h = by(q);
    assert.equal(h[ep.G], undefined, "an inactive registration is not offered");
    d = await dialog();
    assert.ok(!d.options.some((o) => o.includes(ep.G)), "G is gone from the dialog");
    assert.ok(d.options.some((o) => o.includes(ep.A)));

    // ---- 3. the mirror goes down too: B is an outage, not "no capacity"; A is unaffected ----
    served.set(MIRROR + "/v1/host-capacity", "abort");
    d = await dialog();
    assert.ok(!d.options.some((o) => o.includes(ep.B)), "B cannot be confirmed live");
    assert.ok(d.options.some((o) => o.includes(ep.A)));
    assert.match(d.warn, /Liveness evidence incomplete/);
    assert.match(d.warn, /mirror\.liveness\.test/);
    assert.match(d.warn, /did not answer/);
    q = await quotes();
    assert.match(by(q)[ep.B].reason, /capacity record unavailable/);

    // ---- 4. A hangs: the page still completes within its bound and says why nothing is confirmed ----
    served.set(ep.A + "/v1/host/capacity", "hang");
    d = await dialog();
    assert.ok(d.ms < 45000, "the dialog completed in " + d.ms + " ms");
    assert.ok(!d.options.some((o) => o.includes("http")), "no host is confirmed live: " + JSON.stringify(d.options));
    assert.match(d.none, /No host could be confirmed live/);
    assert.match(d.warn, /did not answer/);

    assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
    assert.deepEqual(forbidden, [], "only the registered hosts and the profile's mirror were contacted");
    assert.ok(!asked.some((u) => /elsewhere\.liveness\.test/.test(u)), "a record's own claims never pick what is fetched");
  } finally { await browser?.close(); await rig?.stop(); }
});
