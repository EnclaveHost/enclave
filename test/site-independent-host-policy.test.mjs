// The Enclave administrator's platform host policy in the real dashboard (Chromium), on the original-style factory and
// address-book fixture (test/helpers/independent-browser-rig.mjs, legacySessionFactory). The rig's book owner (anvil #0, a
// public fixture key - never a production wallet) signs EIP-712 policies with the shared format
// (network/platform-host-policy.mjs) and anchors them with the book's own setMany on this local chain; two policy mirrors
// are answered by the test (Playwright routes). Host A (anvil #2) and host B (anvil #4) are both registered and live.
//   1. policy #1 admits both: both are offered in the Apps dialog; management of a lease on B passes the policy check
//   2. the admin bans B (#2) while the dialog is OPEN: deploying to B from that open dialog is refused before any
//      transaction; B is gone from a fresh dialog; managing B's lease is refused, nothing contacted
//   3. both mirrors down and one RPC down: B stays refused (the anchored digest + this browser's persisted policy)
//   4. the admin unbans (#3); with mirror A down, mirror B serves it: B is offered and manageable again
//   5. the admin anchors #4 that no mirror has: a bounded "unavailable" state, no host selectable, a plain reason
//   6. the book's owner rotates: #4 (signed by the former owner) admits nobody, an outage does not undo it, and the new
//      owner re-signing the same document resumes (core v3 confirmed authority)
//   node test/helpers/memory-guard.mjs --max-rss-mib 1408 --floor-available-mib 16384 -- node --test test/site-independent-host-policy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startRig, haveTools, walletScript, KEYS } from "./helpers/independent-browser-rig.mjs";
import { POLICY_FORMAT, policyTypedData, policyDigest, encodeAnchor, ANCHOR_KEYS } from "../network/platform-host-policy.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium; try { ({ chromium } = require("playwright")); } catch {}
const skip = haveTools() || (!chromium && "Playwright unavailable");
const MA = "https://policy-a.platform.test", MB = "https://policy-b.platform.test";
const Z32 = "0x" + "00".repeat(32);

test("platform host policy in the dashboard: admit, ban in an open view, outage cannot undo, unban, unavailable", { skip: skip || false, timeout: 480000 }, async () => {
  let rig, browser;
  const forbidden = [];
  try {
    rig = await startRig({ legacySessionFactory: true });
    const admin = rig.wc(KEYS.deployer), adminAcct = privateKeyToAccount(KEYS.deployer);
    const book = rig.addresses.book.toLowerCase(), registry = rig.addresses.registry.toLowerCase();
    // the host-ownership extension the policy binds (the repository's EnclaveHostOwnership, on this local chain)
    const OWN = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/foundry/out/EnclaveHostOwnership.sol/EnclaveHostOwnership.json"), "utf8"));
    const h = await admin.deployContract({ abi: OWN.abi, bytecode: OWN.bytecode.object, args: [rig.addresses.registry] });
    const own = (await rig.pc.waitForTransactionReceipt({ hash: h })).contractAddress.toLowerCase();
    rig.profile.addressBook = rig.addresses.book;
    rig.profile.hostPolicy = { hostOwnership: own, mirrors: [MA, MB] };
    const A = rig.endpoint, B = rig.endpoint2, idA = keccak256(toBytes(A)), idB = keccak256(toBytes(B));

    // policies: signed by the book owner; the anchor is the book's own setMany (owner-only)
    let prev = Z32;
    const policy = async (sequence, deny) => {
      const doc = { format: POLICY_FORMAT, chainId: 8453, book, registry, hostOwnership: own, sequence, issuedAt: Math.floor(Date.now() / 1000) - 30,
        expiresAt: 0, maxStaleSec: 0, previousDigest: prev, mode: "denylist", deny, admit: [] };
      const signed = { document: JSON.stringify(doc), signature: await adminAcct.signTypedData(policyTypedData(doc)) };
      prev = policyDigest(doc);
      return { doc, signed, digest: prev };
    };
    const anchor = async (p) => {
      const a = encodeAnchor(p.digest);
      await rig.write(admin, rig.addresses.book, rig.abi.book, "setMany", [[ANCHOR_KEYS.hi, ANCHOR_KEYS.lo], [a.hi, a.lo]]);
      for (let i = 0; i < 3; i++) await rig.pc.request({ method: "evm_mine", params: [] });
    };
    const served = new Map();                     // url -> body | "down"
    const publish = (base, p) => served.set(base + "/" + p.digest + ".json", p.signed);

    // an app for the dialog, and a funded deployment that host B claims (the lease management is judged on)
    await rig.write(admin, rig.addresses.catalog, rig.abi.catalog, "publishVersion", ["policyapp", "Policy app", "Policy fixture", "1",
      "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", [0, 0, 64, 1], "http:8080", "{}", 0n]);
    const appId = await rig.pc.readContract({ address: rig.addresses.catalog, abi: rig.abi.catalog, functionName: "appIdOf", args: [admin.account.address, "policyapp"] });
    await rig.write(admin, rig.addresses.catalog, rig.abi.catalog, "setApproval", [appId, 0n, 1]);
    const owner = rig.wc(KEYS.owner), L = rig.abi.ledger;
    await rig.write(owner, rig.addresses.ledger, L, "create", [`catalog://${appId}/0`, 0, 100, 8080, "", true, "", "0x" + "00".repeat(20), 0n, 1000n]);   // a ceiling host B (300/s for this size) can claim under
    const n = await rig.pc.readContract({ address: rig.addresses.ledger, abi: L, functionName: "count" });
    const [rec] = await rig.pc.readContract({ address: rig.addresses.ledger, abi: L, functionName: "getPage", args: [n - 1n, 1n] });
    await rig.write(owner, rig.addresses.usdc, rig.abi.usdc, "approve", [rig.addresses.ledger, parseUnits("1", 6)]);
    await rig.write(owner, rig.addresses.ledger, L, "fund", [rec.id, parseUnits("1", 6)]);
    await rig.write(rig.wc(KEYS.operator2), rig.addresses.ledger, L, "claim", [rec.id, idB]);
    const depB = rec.id.toLowerCase();

    const p1 = await policy(1, []);
    publish(MA, p1); publish(MB, p1); await anchor(p1);

    browser = await chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1", "--disable-extensions",
      "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return route.continue();
      const v = served.get(u.origin + u.pathname);
      if (u.origin === MA || u.origin === MB){
        if (served.get(u.origin) === "down") return route.abort("connectionrefused");
        if (v === undefined) return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" });
        return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(v) });
      }
      if (u.pathname === "/v1/host/capacity") return route.abort("connectionrefused");   // no capacity records here: registry writes keep A and B live
      forbidden.push(u.href); return route.abort();
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
    await page.goto(rig.site + "/dashboard");
    await page.waitForFunction(async () => { const E = (await import("/js/core/api.js")).Enclave; return !!(E.provider && E.address); });
    // a session, so host management can be attempted (it is signed by the session)
    await page.evaluate(async () => {
      const S = await import("/js/core/sessions.js"), E = (await import("/js/core/api.js")).Enclave;
      for (const end = Date.now() + 30000;;){
        try { if (E.provider && E.address) return await S.startSession({ budgetUsd: 1, hours: 1 }); }
        catch (e){ if (!/Connect a wallet first/.test(e.message) || Date.now() > end) throw e; }
        if (Date.now() > end) throw new Error("the injected wallet never settled");
        await new Promise((r) => setTimeout(r, 300));
      }
    });

    const openDialog = async () => {
      await page.goto(rig.site + "/apps?app=" + appId);
      await page.locator('#appDetailView [data-act="deploy"]').first().click({ timeout: 60000 });
      await page.waitForSelector(".qd-indhost", { timeout: 60000 });
    };
    const dialogState = async () => ({ options: await page.locator(".qd-indhost option").allTextContents(),
      pol: await page.locator(".qd-indpol").textContent().catch(() => ""), none: await page.locator(".qd-indnone").textContent().catch(() => "") });
    const manage = (id) => page.evaluate(async (id) => {
      try { await (await import("/js/core/independent-management.js")).resolveEndpoint(id, "status"); return { ok: true }; }
      catch (e){ return { ok: false, kind: e.kind || null, message: String(e.message || e) }; }
    }, id);
    const ledgerCount = () => rig.pc.readContract({ address: rig.addresses.ledger, abi: L, functionName: "count" });

    // ---- 1. policy #1 admits both ----
    await openDialog();
    let d = await dialogState();
    assert.ok(d.options.some((o) => o.includes(A)) && d.options.some((o) => o.includes(B)), JSON.stringify(d));
    assert.match(d.pol, /Platform host policy #1 \(anchored in the address book at block \d+\)/);
    let m = await manage(depB);
    assert.notEqual(m.kind, "policy", "an admitted host passes the policy check: " + m.message);

    // ---- 2. the admin bans B while this dialog is OPEN ----
    const idBpick = await page.locator(".qd-indhost option", { hasText: B }).getAttribute("value");
    await page.locator(".qd-indhost").selectOption(idBpick);
    const p2 = await policy(2, [{ kind: "registryId", value: idB.toLowerCase(), reason: "abuse: phishing kit" }]);
    publish(MA, p2); publish(MB, p2); await anchor(p2);
    const before = await ledgerCount();
    await page.locator(".qd-tosck").check();
    await page.locator("#qdAmt").fill("1");
    await page.locator(".qd-go").click();
    await page.waitForFunction(() => /refused by the platform host policy/.test(document.body.textContent || ""), null, { timeout: 90000 });
    assert.match(await page.locator("body").textContent(), /banned by platform policy #2 \(registryId\): abuse: phishing kit/);
    assert.equal(await ledgerCount(), before, "nothing was created");
    m = await manage(depB);
    assert.equal(m.kind, "policy"); assert.match(m.message, /refuses this deployment's host: banned by platform policy #2.*Nothing was sent/);
    await openDialog();
    d = await dialogState();
    assert.ok(d.options.some((o) => o.includes(A)), "A is still offered");
    assert.ok(!d.options.some((o) => o.includes(B)), "B is not offered: " + JSON.stringify(d.options));

    // ---- 3. both mirrors and one RPC down: the ban holds ----
    served.set(MA, "down"); served.set(MB, "down"); rig.rpcModes[0] = "down";
    try {
      await openDialog();
      d = await dialogState();
      assert.ok(!d.options.some((o) => o.includes(B)), "an outage never re-admits B");
      m = await manage(depB);
      assert.equal(m.kind, "policy"); assert.match(m.message, /banned by platform policy #2/);
    } finally { delete rig.rpcModes[0]; }

    // ---- 4. the authorized unban (#3), served by mirror B only ----
    const p3 = await policy(3, []);
    served.delete(MB); publish(MB, p3); await anchor(p3);
    await openDialog();
    d = await dialogState();
    assert.ok(d.options.some((o) => o.includes(B)), "B is offered again: " + JSON.stringify(d));
    assert.match(d.pol, /#3/);
    m = await manage(depB);
    assert.notEqual(m.kind, "policy", m.message);

    // ---- 5. an anchored policy no mirror has: bounded, plain unavailable state ----
    const p4 = await policy(4, []);
    await anchor(p4);
    const t0 = Date.now();
    await openDialog();
    d = await dialogState();
    assert.ok(Date.now() - t0 < 60000, "the dialog completed in " + (Date.now() - t0) + " ms");
    assert.ok(!d.options.some((o) => o.includes("http")), "no host is selectable: " + JSON.stringify(d.options));
    assert.match(d.none, /platform host policy is unavailable/);
    assert.match(d.pol, /Platform host policy unavailable: the anchored policy is not available from any mirror/);
    m = await manage(depB);
    assert.equal(m.kind, "policy"); assert.match(m.message, /not available from any mirror/);

    // ---- 6. core v3 CONFIRMED authority: the book's owner rotates (its own two-step handoff); #4 stops admitting at once,
    //         an RPC/mirror outage does not undo that, and the NEW owner re-signing the SAME document (no anchor write) resumes
    publish(MB, p4);                                               // #4 becomes available: both hosts admitted again
    await openDialog();
    d = await dialogState();
    assert.ok(d.options.some((o) => o.includes(A)) && d.options.some((o) => o.includes(B)), "#4 admits both: " + JSON.stringify(d));
    const nextOwner = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");   // anvil #3 (public fixture)
    await rig.write(admin, rig.addresses.book, rig.abi.book, "setOwner", [nextOwner.address]);
    await rig.write(rig.wc("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"), rig.addresses.book, rig.abi.book, "acceptOwnership", []);
    for (let i = 0; i < 3; i++) await rig.pc.request({ method: "evm_mine", params: [] });
    // WARM: this page accepted #4; at the new block its current owner does not sign it - a CONFIRMED authority refusal
    m = await manage(depB);
    assert.equal(m.kind, "policy"); assert.match(m.message, /not signed by the address book's current owner at this block/);
    // COLD: a fresh page never accepted #4; the same document does not verify against the current owner either
    await openDialog();
    d = await dialogState();
    assert.ok(!d.options.some((o) => o.includes("http")), "no host while the current owner does not sign #4: " + JSON.stringify(d.options));
    assert.match(d.pol, /does not verify against the current owner|not signed by the address book's current owner/);
    served.set(MB, "down"); rig.rpcModes[0] = "down";
    try {
      m = await manage(depB);
      assert.equal(m.kind, "policy", "an outage after the confirmed authority failure stays refused: " + m.message);
    } finally { served.delete(MB); delete rig.rpcModes[0]; }
    publish(MB, { digest: p4.digest, signed: { document: p4.signed.document, signature: await nextOwner.signTypedData(policyTypedData(p4.doc)) } });
    await openDialog();
    d = await dialogState();
    assert.ok(d.options.some((o) => o.includes(A)) && d.options.some((o) => o.includes(B)), "the re-signed #4 admits again: " + JSON.stringify(d));
    assert.match(d.pol, /#4/);
    m = await manage(depB);
    assert.notEqual(m.kind, "policy", m.message);

    assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
    assert.deepEqual(forbidden, [], "only the rig, the policy mirrors and the registered hosts were contacted");
  } finally { await browser?.close(); await rig?.stop(); }
});
