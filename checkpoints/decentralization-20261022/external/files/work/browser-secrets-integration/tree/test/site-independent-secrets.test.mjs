// The independent dashboard's Secrets tab (site/components/deployments/independent-secrets-panel.js,
// site/js/core/independent-secrets.js, /vendor/custody-v2.js) in a REAL headless Chromium on the REAL dashboard, against:
//   - test/helpers/independent-browser-rig.mjs: anvil 8453 with the repository's ledger, registry and session factory;
//   - test/helpers/browser-secrets-rig.mjs: the REAL EnclaveSecretVaultV2 + EnclaveHostOwnership, an independent committee of
//     three registered hosts, and three REAL createCustodianV2 instances behind the real router, behind the REAL Caddy site
//     directCustodyIngress generates (TLS from a throwaway CA the browser trusts through its own NSS store). The page calls
//     the custodians cross-origin, so every owner read goes through the real CORS preflight.
// Owners: the connected wallet (EOA, EIP-712), and a passkey account (the PINNED Safe passkey code copied from Base, made in
// the account panel; ERC-1271 through its passkey, Chrome's virtual authenticator). Threshold cryptography is real: the
// committee's key is f(x) = a0 + a1 x, each custodian holds f(k), the page combines t = 2 DLEQ-checked partials.
// Synthetic: no SEV-SNP or Shield hardware; custodians run in-process; no guest attestation is involved.
//   CADDY_BIN=work/custody-caddy/caddy node test/helpers/memory-guard.mjs --max-rss-mib 1408 --floor-available-mib 16384 -- \
//     node --max-old-space-size=256 test/site-independent-secrets.test.mjs          (the file itself, not under --test: one bounded process)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createWalletClient, http as viemHttp, hexToBytes, bytesToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { startRig, haveTools, walletScript, KEYS, chain } from "./helpers/independent-browser-rig.mjs";
import { custodyWorld } from "./helpers/browser-secrets-rig.mjs";
import { copySafePasskeyCode } from "./helpers/safe-passkey-code.mjs";
import * as v2 from "../custody/v2/protocol.mjs";
import { VAULT_V2_ABI } from "../custody/v2/chain.mjs";
import { UPDATE_V2_ABI } from "../custody/v2/owner.mjs";
import { canonicalRules } from "../custody/rules.mjs";
import { configSha256 } from "../custody/protocol.mjs";

const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium = null; try { ({ chromium } = require("playwright")); } catch {}
const skip = haveTools() || (!process.env.CADDY_BIN && "set CADDY_BIN to the real Caddy (the custodians' ingress)") || (!chromium && "needs Playwright (cd e2e && npm ci) and its Chromium");

const SNP = { v: 1, appId: "a7".repeat(32), images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "cd".repeat(32) }],
              minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
const SECRET_MARKERS = ["two-xyzzy", "s3cret-plugh", "node-wrote-this", "mine-frotz", "stranger-quux", "passkey-zorkmid"];
let rig, W, browser, context, page, setupError = null;
const pageErrors = [], consoleText = [], requests = [], refused = [], cleanups = [];
const cleanup = async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch {} } };
const rigRpc = async (method, params) => { const r = await (await fetch(rig.rpc, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
const ownerAcct = privateKeyToAccount(KEYS.owner);
const sendAs = async (acct, address, abi, functionName, args) => {
  const hash = await createWalletClient({ account: acct, chain, transport: viemHttp(rig.rpc) }).writeContract({ address, abi, functionName, args });
  const r = await rig.pc.waitForTransactionReceipt({ hash }); if (r.status !== "success") throw new Error(functionName + " reverted"); return r;
};

test.before(async () => {
  if (skip) return;
  const watchdog = setTimeout(() => { console.error("independent-secrets: watchdog"); cleanup().finally(() => process.exit(1)); }, 25 * 60 * 1000); watchdog.unref();
  try {
    rig = await startRig(); cleanups.push(() => rig.stop());
    W = await custodyWorld(rig); cleanups.push(() => W.stop());
    const profile = { ...rig.profile, contractPins: { ...rig.profile.contractPins, contracts: { ...rig.profile.contractPins.contracts, secretVaultV2: W.vault } } };
    browser = await chromium.launch({ env: { ...process.env, HOME: W.home }, args: ["--host-resolver-rules=" + W.hostRules, "--disable-gpu", "--disable-dev-shm-usage",
      "--renderer-process-limit=1", "--disable-extensions", "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] });
    cleanups.push(() => browser.close());
    context = await browser.newContext({ reducedMotion: "reduce" });          // certificate validation stays ON (NSS trusts only the test CA)
    // NO request interception (page/context.route would put Playwright between the page and the custodians and change
    // how CORS preflights are handled): every name but the test's resolves to NOT FOUND (W.hostRules), and every request
    // is recorded; an Enclave name would be recorded here and fail to resolve
    context.on("request", (r) => { requests.push(r.url()); try { if (/(^|\.)enclave\.host$/i.test(new URL(r.url()).hostname)) refused.push(r.url()); } catch {} });
    await context.addInitScript({ content: walletScript({ rpc: rig.rpc, address: rig.owner }) });
    const text = JSON.stringify(profile);
    await context.addInitScript(({ address, text }) => {
      if (!localStorage.getItem("enclave_session")) localStorage.setItem("enclave_session", JSON.stringify({ address, rdns: "test.local.wallet" }));
      localStorage.setItem("enclave_independent_profile", text); sessionStorage.setItem("enclave_independent_ack", text);
    }, { address: rig.owner, text });
    page = await context.newPage(); page.setDefaultTimeout(60000);
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
    page.on("console", (m) => consoleText.push(m.text()));
    page.on("dialog", (d) => d.accept());
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(rig.site + "/dashboard");
    for (let i = 0; i < 100 && !(await page.evaluate(async () => !!(await import("/js/core/api.js")).Enclave.address)); i++) await new Promise((r) => setTimeout(r, 200));
  } catch (e){ setupError = e; await cleanup(); throw e; }
});
test.after(cleanup);

// ---- helpers ------------------------------------------------------------------------------------------------------------
const policyOf = async (id) => {
  const [owner, policyRev, secretRev, committeeId, paused, rules] = await rig.pc.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "policyOf", args: [id] });
  const [, , data] = await rig.pc.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "bundleOf", args: [id] });
  return { owner: owner.toLowerCase(), policyRev, secretRev, committeeId: committeeId.toLowerCase(), paused, rules, data };
};
const stored = async (id) => {
  const p = await policyOf(id);
  if (p.data === "0x") return null;
  const bytes = hexToBytes(p.data);
  return v2.decryptBundle({ S: v2.parseBundle(bytes).Rp.multiply(W.a0), label: v2.labelOf({ chainId: 8453, vault: W.vault, id, secretRev: p.secretRev, committeeId: W.indCid }), bundle: bytes }).env;
};
async function nodeOwnerWrite(acct, id, env, { setPolicy = false, rules = null } = {}){
  const p = await policyOf(id), secretRev = p.secretRev + 1n;
  const bundle = v2.encryptBundle({ Y: secp256k1.ProjectivePoint.BASE.multiply(W.a0).toRawBytes(true), label: v2.labelOf({ chainId: 8453, vault: W.vault, id, secretRev, committeeId: W.indCid }),
                                    env, configSha256: configSha256("") });
  const u = { expectPolicyRev: p.policyRev, setPolicy, committeeId: setPolicy ? W.indCid : "0x" + "00".repeat(32), paused: false, rules: setPolicy ? bytesToHex(rules) : "0x",
              setBundle: true, bundle: bytesToHex(bundle), clear: false };
  return sendAs(acct, W.vault, UPDATE_V2_ABI, "update", [id, u]);
}
async function newRecord(){
  const n0 = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "count" });
  await page.evaluate(async () => (await import("/js/pages/deploy.js")).deployOnChain({ reference: "catalog://0x" + "11".repeat(32) + "/0", gpuMilli: 0, cpuMilli: 100,
    ports: "", isPublic: true, fundUsd: 0, prepareOnly: true }));
  const rec = (await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "getPage", args: [n0, 1n] }))[0];
  return { id: rec.id.toLowerCase(), owner: rec.owner.toLowerCase() };
}
async function openSecrets(id){
  await page.goto(rig.site + "/dashboard");
  await page.evaluate(() => customElements.whenDefined("c-deployments"));
  await page.locator(".enc-search").fill(id.slice(2, 14));
  await page.waitForFunction(() => document.querySelectorAll(".enc-row").length === 1, null, { timeout: 90000 });
  const row = page.locator(".enc-row").first();
  await row.locator(".enc-isecbtn").click();
  await row.locator(".isec-facts dt").first().waitFor({ timeout: 60000 });
  const h = await row.elementHandle();
  await page.waitForFunction((el) => !el.querySelector(".enc-isec[data-busy]"), h, { timeout: 60000 });
  return row;
}
const lines = (row) => row.locator(".isec-status .ln").allTextContents();
/** click and wait for the action's own outcome line ([✓] / [x] / [!] / "nothing stored"); -> its text */
async function act(row, sel, { timeout = 120000 } = {}){
  const n0 = (await lines(row)).length;
  await row.locator(sel).click();
  const h = await row.elementHandle();
  await page.waitForFunction(({ el, n0 }) => [...el.querySelectorAll(".isec-status .ln")].slice(n0).some((l) => /^\[(✓|x|!)\]|^nothing stored|^values hidden/.test(l.textContent)), { el: h, n0 }, { timeout });
  await page.waitForFunction((el) => !el.querySelector(".enc-isec[data-busy]"), h, { timeout });     // its closing refresh is painted
  const out = (await lines(row)).slice(n0).filter((t) => /^\[(✓|x|!)\]|^nothing stored|^values hidden/.test(t));
  return out[out.length - 1];
}
const factsText = (row) => row.locator(".isec-facts").textContent();
const createPolicyUI = async (row, { ownerRead, pairs }) => {
  await row.locator(".isec-rules").fill(JSON.stringify(SNP));
  await row.locator(".isec-committee").fill(W.indCid);
  if (ownerRead) await row.locator(".isec-ownerread").check(); else await row.locator(".isec-ownerread").uncheck();
  await row.locator(".isec-create-pairs").fill(pairs);
  await row.locator('.isec-cfg-create input[value="none"]').check();
  return act(row, ".isec-createbtn");
};
const preflights = () => W.custodians.reduce((n, c) => n + c.ctl.seen.filter((s) => s.startsWith("OPTIONS /v2/custody/owner-read")).length, 0);
const ownerReads = () => W.custodians.reduce((n, c) => n + c.ctl.seen.filter((s) => s === "POST /v2/custody/owner-read").length, 0);

// ---- the wallet (EOA) owner ---------------------------------------------------------------------------------------------
let eoaId = null;
test("EOA owner: create a policy WITH owner read, list names, reveal, set (merge), remove, replace all, clear - real custodians, real CORS", { skip, timeout: 600000 }, async () => {
  if (setupError) throw setupError;
  const { id, owner } = await newRecord(); eoaId = id;
  assert.equal(owner, rig.owner.toLowerCase());
  const row = await openSecrets(id);
  assert.match(await factsText(row), /policynone yet/);
  assert.match(await factsText(row), new RegExp("ledger owner" + owner + " \\(you\\)"));
  let out = await createPolicyUI(row, { ownerRead: true, pairs: 'A=1\nB="two-xyzzy"' });
  assert.match(out, /^\[✓\] created \(owner read on\): policy revision 1, secrets revision 1, read back at agreed block \d+ · 2 value\(s\): A, B$/, out);
  let p = await policyOf(id);
  assert.equal(p.rules, bytesToHex(canonicalRules({ ...SNP, ownerRead: true })), "the rules state ownerRead: true explicitly");
  assert.equal(p.owner, owner); assert.equal(p.committeeId, W.indCid);
  assert.deepEqual(await stored(id), { A: "1", B: "two-xyzzy" }, "encrypted IN THE PAGE to the committee key the test knows");
  assert.match(await factsText(row), /owner readon/); assert.match(await factsText(row), /2 of 3 custodians, epoch 1 · no Enclave-operated seat/);
  // list: names and sizes only
  const pre0 = preflights(), reads0 = ownerReads();
  out = await act(row, ".isec-list");
  assert.match(out, /^\[✓\] 2 value\(s\) at secrets revision 1, from 3 custodian share\(s\); values not shown$/, out);   // every honest share verified; t = 2 combined
  assert.deepEqual(await row.locator(".isec-name").allTextContents(), ["A  (1 bytes)", "B  (9 bytes)"]);
  assert.ok(!(await row.textContent()).includes("two-xyzzy"), "listing shows no value");
  assert.ok(preflights() > pre0, "the browser sent real CORS preflights to the custodians: " + JSON.stringify(W.custodians[0].ctl.seen.slice(-6)));
  // and CORS is real: the page cannot read a guest route of the same custodian (no Access-Control-Allow-Origin there)
  const guest = await page.evaluate(async (u) => fetch(u + "/v2/custody/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    .then((r) => "read " + r.status, (e) => "blocked: " + e.name), W.custodians[0].endpoint);
  assert.equal(guest, "blocked: TypeError", "the browser refuses a guest route cross-origin");
  assert.equal(ownerReads() - reads0, 3, "one owner-read request to each of the three custodians");
  // reveal (explicit), then hide
  out = await act(row, ".isec-reveal");
  assert.match(out, /^\[✓\] revealed 2 value\(s\)/);
  assert.deepEqual(await row.locator(".isec-value").allTextContents(), ["A=1", "B=two-xyzzy"]);
  out = await act(row, ".isec-hide");
  assert.equal(await row.locator(".isec-value").count(), 0, "Hide removes the values from the page");
  assert.ok(!(await row.textContent()).includes("two-xyzzy"));
  // set (merge)
  await row.locator(".isec-pairs").fill("C=3\nB=s3cret-plugh");
  out = await act(row, ".isec-set");
  assert.match(out, /^\[✓\] stored: policy revision 2, secrets revision 2, read back at agreed block \d+ · 3 value\(s\): A, B, C$/, out);
  assert.equal(await row.locator(".isec-pairs").inputValue(), "", "entered values are cleared once written");
  assert.deepEqual(await stored(id), { A: "1", B: "s3cret-plugh", C: "3" }, "merged: A kept, B replaced, C added");
  assert.equal((await policyOf(id)).rules, bytesToHex(canonicalRules({ ...SNP, ownerRead: true })), "a secrets edit never touches the rules");
  // remove exactly one key; removing a missing one is refused precisely
  await row.locator(".isec-rmkeys").fill("A");
  out = await act(row, ".isec-rm");
  assert.match(out, /^\[✓\] removed: policy revision 3, secrets revision 3.*2 value\(s\): B, C$/, out);
  assert.deepEqual(await stored(id), { B: "s3cret-plugh", C: "3" });
  await row.locator(".isec-rmkeys").fill("NOPE");
  out = await act(row, ".isec-rm");
  assert.match(out, /^\[x\] not stored: NOPE$/, out);
  // replace all (nothing read; the config named explicitly)
  await row.locator(".isec-pairs").fill("ONLY=x");
  await row.locator('.isec-cfg-replace input[value="none"]').check();
  out = await act(row, ".isec-replace");
  assert.match(out, /^\[✓\] replaced: policy revision 4, secrets revision 4.*1 value\(s\): ONLY$/, out);
  assert.deepEqual(await stored(id), { ONLY: "x" });
  // the deployment's inline config is required to be named when it has none inline (as the CLI)
  await row.locator(".isec-pairs").fill("ONLY=y");
  await row.locator('.isec-cfg-replace input[value="inline"]').check();
  out = await act(row, ".isec-replace");
  assert.match(out, /^\[x\] .*(config comes from its catalog version|config is at a CID|not JSON)/, out);
  // clear: confirmed twice
  out = await act(row, ".isec-clear");
  assert.match(out, /^\[!\] Clear destroys every stored value/);
  out = await act(row, ".isec-clear");
  assert.match(out, /^\[✓\] cleared: policy revision \d+, secrets revision 5/, out);
  assert.equal((await policyOf(id)).data, "0x");
  assert.match(await factsText(row), /nothing stored/);
  assert.equal(await row.locator(".isec-list").isDisabled(), true, "nothing to list once cleared");
});

test("owner read ABSENT (the default): the page refuses before any network call, the CUSTODIANS refuse too, and turning it on is an explicit policy change", { skip, timeout: 600000 }, async () => {
  if (setupError) throw setupError;
  const { id } = await newRecord();
  const row = await openSecrets(id);
  let out = await createPolicyUI(row, { ownerRead: false, pairs: "A=1" });
  assert.match(out, /^\[✓\] created \(owner read off\)/, out);
  assert.equal((await policyOf(id)).rules, bytesToHex(canonicalRules(SNP)), "no ownerRead key: the classic rule bytes exactly");
  assert.match(await factsText(row), /owner readoff \(not set in the rules\)/);
  assert.equal(await row.locator(".isec-list").isDisabled(), true); assert.equal(await row.locator(".isec-set").isDisabled(), true);
  const reads0 = ownerReads();
  const refusal = await page.evaluate(async (id) => (await import("/js/core/independent-secrets.js")).listSecrets(id).then(() => "listed", (e) => e.message + " |" + e.code), id);
  assert.match(refusal, /This policy's rules do not allow an owner read \(ownerRead is absent, which means off\)\. .* \|owner_read_disabled$/, refusal);
  assert.equal(ownerReads(), reads0, "refused before any custodian was asked");
  // the custodians enforce it themselves: a client fooled into believing ownerRead is on is refused by every custodian
  const forced = await page.evaluate(async ({ id, snp }) => {
    const IS = await import("/js/core/independent-secrets.js"), C = await IS.vendor(), S = await import("/js/core/sessions.js"), { Enclave } = await import("/js/core/api.js");
    const s = await IS.readState(id);
    s.st.policy.rules = C.canonicalRules({ ...snp, ownerRead: true });            // the page's mirror is lied to; the chain is not
    const o = (await S.sdk()).ownerFromProvider(Enclave.provider, Enclave.address);
    return C.readOwnerSecrets({ chainId: 8453, vault: s.vault, id, state: s.st, owner: { address: Enclave.address.toLowerCase(), signTypedData: (t) => o.signTypedData(t) }, post: IS.custodianFetch() })
      .then(() => "read", (e) => e.message);
  }, { id, snp: SNP });
  assert.match(forced, /insufficient custodians: 0 valid share/, forced);
  assert.equal((forced.match(/owner_read_disabled/g) || []).length, 3, "all three custodians refused: " + forced);
  // the explicit opt-in: the rules gain the key; values, committee and pause unchanged
  out = await act(row, ".isec-or-on");
  assert.match(out, /^\[✓\] owner read is on: policy revision 2, secrets revision 1/, out);
  assert.equal((await policyOf(id)).rules, bytesToHex(canonicalRules({ ...SNP, ownerRead: true })));
  assert.deepEqual(await stored(id), { A: "1" }, "the values are untouched by the opt-in");
  out = await act(row, ".isec-list");
  assert.match(out, /^\[✓\] 1 value\(s\)/, out);
  out = await act(row, ".isec-or-off");
  assert.match(out, /^\[✓\] owner read is off/, out);
  assert.equal((await policyOf(id)).rules, bytesToHex(canonicalRules({ ...SNP, ownerRead: false })));
  assert.equal(await row.locator(".isec-list").isDisabled(), true);
  // pause: owner reads refused by the page AND the custodians; Replace all still works while paused
  await act(row, ".isec-or-on");
  out = await act(row, ".isec-pause");
  assert.match(out, /^\[✓\] paused/, out);
  assert.equal((await policyOf(id)).paused, true);
  const paused = await page.evaluate(async (id) => (await import("/js/core/independent-secrets.js")).listSecrets(id).then(() => "listed", (e) => e.code), id);
  assert.equal(paused, "paused");
  await row.locator(".isec-pairs").fill("P=1"); await row.locator('.isec-cfg-replace input[value="none"]').check();
  out = await act(row, ".isec-replace");
  assert.match(out, /^\[✓\] replaced/, out);
  out = await act(row, ".isec-resume");
  assert.match(out, /^\[✓\] resumed/, out);
  out = await act(row, ".isec-list");
  assert.match(out, /^\[✓\] 1 value\(s\)/, out);
});

test("stale revision: another editor writes after the page's read; the page's write is refused at the vault's guard, nothing is lost, and a re-run merges", { skip, timeout: 600000 }, async () => {
  if (setupError) throw setupError;
  const { id } = await newRecord();
  const row = await openSecrets(id);
  await createPolicyUI(row, { ownerRead: true, pairs: "A=1" });
  // once all three custodians have answered the page's owner read, the owner (another client) writes first
  let answered = 0, wrote = false;
  const off = W.onOwnerRead(async () => { if (++answered === 3 && !wrote){ wrote = true; await nodeOwnerWrite(ownerAcct, id, { A: "1", N: "node-wrote-this" }); } });
  try {
    await row.locator(".isec-pairs").fill("B=2");
    const out = await act(row, ".isec-set");
    assert.match(out, /^\[x\] Someone changed this deployment's custody after this page read it \(policy revision 1 → 2\); nothing was sent and nothing changed\./, out);
  } finally { off(); }
  assert.ok(wrote);
  assert.deepEqual(await stored(id), { A: "1", N: "node-wrote-this" }, "the other editor's change stands");
  const out = await act(row, ".isec-set");
  assert.match(out, /^\[✓\] stored: policy revision 3.*3 value\(s\): A, B, N$/, out);
  assert.deepEqual(await stored(id), { A: "1", B: "2", N: "node-wrote-this" }, "nothing was lost");
});

test("malicious and unavailable custodians: one lying answer is caught by DLEQ/HPKE and the other two read; two bad answers fail closed with the reason; quorum loss fails closed", { skip, timeout: 600000 }, async () => {
  if (setupError) throw setupError;
  const id = eoaId || (await newRecord()).id;
  const row = await openSecrets(id);
  if (/nothing stored|policynone/.test(await factsText(row))){
    if (/policynone/.test(await factsText(row))) await createPolicyUI(row, { ownerRead: true, pairs: "M=1" });
    else { await row.locator(".isec-pairs").fill("M=1"); await row.locator('.isec-cfg-replace input[value="none"]').check(); await act(row, ".isec-replace"); }
  }
  const [c0, c1, c2] = W.custodians.map((c) => c.ctl);
  const reset = () => { for (const c of [c0, c1, c2]) { c.mode = "ok"; c.up = true; } };
  try {
    c1.mode = "lie-share";
    let out = await act(row, ".isec-list");
    assert.match(out, /^\[✓\] \d+ value\(s\) .* from 2 custodian share\(s\)/, "a wrong partial with a valid-looking proof is not used: " + out);
    c2.mode = "lie-recipient";
    out = await act(row, ".isec-list");
    assert.match(out, /^\[x\] Your values could not be read: fewer than the 2 custodians the committee needs gave a valid answer \(.*failed verification.*\)\. Nothing was changed\./, out);
    reset(); c0.mode = "lie-purpose"; c1.mode = "req-recipient";
    out = await act(row, ".isec-list");
    assert.match(out, /^\[x\] Your values could not be read/, out);
    assert.match(out, /owner_sig/, "the rewritten recipient is refused by the custodian (the owner signed another key): " + out);
    assert.match(out, /did not accept the owner's signature/, out);
    reset(); c1.mode = "req-purpose"; c2.mode = "req-purpose";
    out = await act(row, ".isec-list");
    assert.match(out, /^\[x\] Your values could not be read.*bad_request/, out);
    reset(); c1.up = false;
    out = await act(row, ".isec-list");
    assert.match(out, /^\[✓\] \d+ value\(s\) .* from 2 custodian share\(s\)/, "one custodian down: t = 2 of 3 still read: " + out);
    c2.up = false;
    out = await act(row, ".isec-list");
    assert.match(out, /^\[x\] Your values could not be read: fewer than the 2 custodians .*could not be reached/, out);
  } finally { reset(); }
  const out = await act(row, ".isec-list");
  assert.match(out, /^\[✓\] /);
});

test("transfer: the old owner is refused precisely; the ledger's new owner claims (the old values destroyed), stores its own, resumes and reads", { skip, timeout: 600000 }, async () => {
  if (setupError) throw setupError;
  const stranger = await W.acct();
  // a record the wallet owns, with a policy; the ledger moves it to a stranger: the wallet can no longer read
  const a = await newRecord();
  let row = await openSecrets(a.id);
  await createPolicyUI(row, { ownerRead: true, pairs: "A=1" });
  await sendAs(ownerAcct, rig.addresses.ledger, rig.abi.ledger, "transferDeployment", [a.id, stranger.address]);
  await act(row, ".isec-refresh");
  assert.match(await factsText(row), /the ledger moved this deployment: custody must be claimed/);
  assert.equal(await row.locator(".isec-edit").isHidden(), true, "no edits offered to the old owner");
  const moved = await page.evaluate(async (id) => (await import("/js/core/independent-secrets.js")).listSecrets(id).then(() => "listed", (e) => e.message + " |" + e.code), a.id);
  assert.match(moved, /^The ledger now names 0x[0-9a-f]{40} as this deployment's owner, but its custody policy still belongs to 0x[0-9a-f]{40}: .* \|transferred$/, moved);
  // the other way round: a stranger's policy on a record the ledger then gives to this wallet -> claim
  const b = await newRecord();
  await sendAs(ownerAcct, rig.addresses.ledger, rig.abi.ledger, "transferDeployment", [b.id, stranger.address]);
  await nodeOwnerWrite(stranger, b.id, { S: "stranger-quux" }, { setPolicy: true, rules: canonicalRules({ ...SNP, ownerRead: true }) });
  await sendAs(stranger, rig.addresses.ledger, rig.abi.ledger, "transferDeployment", [b.id, rig.owner]);
  row = await openSecrets(b.id);
  assert.match(await factsText(row), /the ledger moved this deployment/);
  assert.equal(await row.locator(".isec-claim").isVisible(), true);
  let out = await act(row, ".isec-claimbtn");
  assert.match(out, /^\[✓\] claimed: policy revision 2 is yours, paused, with no values/, out);
  const p = await policyOf(b.id);
  assert.equal(p.owner, rig.owner.toLowerCase()); assert.equal(p.paused, true); assert.equal(p.data, "0x");
  await row.locator(".isec-pairs").fill("MINE=mine-frotz"); await row.locator('.isec-cfg-replace input[value="none"]').check();
  out = await act(row, ".isec-replace");
  assert.match(out, /^\[✓\] replaced/, out);
  out = await act(row, ".isec-resume");
  assert.match(out, /^\[✓\] resumed/, out);
  out = await act(row, ".isec-reveal");
  assert.deepEqual(await row.locator(".isec-value").allTextContents(), ["MINE=mine-frotz"], "the previous owner's values are gone");
  await act(row, ".isec-hide");
});

test("passkey account owner (the pinned Safe, ERC-1271 through its passkey): create with owner read, list, set - the Safe signs and calls, never the wallet", { skip, timeout: 900000 }, async () => {
  if (setupError) throw setupError;
  const pins = await page.evaluate(async () => Object.entries((await import("/js/core/account-providers.js")).PROVIDERS["safe-passkey"].contracts)
    .map(([name, c]) => ({ name, address: c.address, codeHash: c.codeHash || null })));
  // a read-only upstream read of the PINNED code from Base (test/helpers/safe-passkey-code.mjs); a public RPC can fail a read
  let rows = null, last = null;
  for (let i = 0; i < 4 && !rows; i++){ try { rows = await copySafePasskeyCode(pins, rigRpc); } catch (e){ last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); } }
  if (!rows) throw last;
  for (const c of rows) if (!c.ok) throw new Error(c.name + " is not the pinned code");
  await page.goto(rig.site + "/dashboard");
  const waitAcct = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".acct-status")?.textContent || ""), re.source, { timeout: 90000 })
    .catch(async (e) => { throw new Error(e.message + "\nstatus: " + await page.locator(".acct-status").textContent().catch(() => "?")); });
  await page.locator(".acct-panel > summary").click();
  await page.locator(".acct-label").fill("laptop");
  await page.locator(".acct-create").click(); await waitAcct(/passkey created under/);
  await page.locator(".acct-compute").click(); await waitAcct(/your account address: 0x[0-9a-f]{40} \(not deployed yet\)/);
  const safe = /your account address: (0x[0-9a-f]{40})/.exec(await page.locator(".acct-status").textContent())[1];
  await page.locator(".acct-save").click();
  await page.locator(".acct-deploy").click();
  await page.locator(".acct-send").nth(0).click(); await waitAcct(/create the signer for passkey laptop confirmed/);
  await page.locator(".acct-send").nth(1).click(); await waitAcct(/create the account confirmed/);
  await page.locator(".acct-use").click(); await waitAcct(/the dashboard now acts as your passkey account/);
  const { id, owner } = await newRecord();
  assert.equal(owner, safe, "the Safe holds the record itself");
  const row = await openSecrets(id);
  assert.match(await factsText(row), new RegExp("you act aspasskey account " + safe));
  let out = await createPolicyUI(row, { ownerRead: true, pairs: "K=passkey-zorkmid" });
  assert.match(out, /^\[✓\] created \(owner read on\)/, out);
  const p = await policyOf(id);
  assert.equal(p.owner, safe, "the policy belongs to the Safe (it called the vault itself)");
  assert.deepEqual(await stored(id), { K: "passkey-zorkmid" });
  const code = await rig.pc.getCode({ address: safe });
  assert.ok(code && code !== "0x", "a contract owner: the custodians check its ERC-1271 answer");
  out = await act(row, ".isec-list");
  assert.match(out, /^\[✓\] 1 value\(s\) .* from 3 custodian share\(s\)/, out);
  await row.locator(".isec-pairs").fill("L=2");
  out = await act(row, ".isec-set");
  assert.match(out, /^\[✓\] stored: .*2 value\(s\): K, L$/, out);
  assert.deepEqual(await stored(id), { K: "passkey-zorkmid", L: "2" });
  assert.equal((await policyOf(id)).owner, safe);
});

test("no Enclave or relay fetch, no secret in console or browser storage, no page error", { skip }, async () => {
  if (setupError) throw setupError;
  assert.deepEqual(refused, [], "nothing tried to reach *.enclave.host");
  const hosts = new Set(requests.map((u) => { try { return new URL(u).hostname; } catch { return u; } }).filter((h) => h && !/^(data|blob|about)/.test(h)));
  const allowed = new Set(["localhost", "127.0.0.1", "127.0.0.2", ...W.custodians.map((c) => c.host)]);
  assert.deepEqual([...hosts].filter((h) => !allowed.has(h)), [], "only the local site, RPCs, storage and the custodians: " + [...hosts].join(", "));
  for (const c of W.custodians) assert.ok(requests.some((u) => u.startsWith(c.endpoint + "/v2/custody/owner-read")), c.endpoint + " was called directly by the page");
  const storage = await page.evaluate(async () => {
    const dump = (s) => Object.keys(s).map((k) => k + "=" + s.getItem(k)).join("\n");
    const dbs = (await indexedDB.databases?.() || []).map((d) => d.name).join(",");
    return dump(localStorage) + "\n" + dump(sessionStorage) + "\n" + dbs;
  });
  for (const m of SECRET_MARKERS){
    assert.ok(!storage.includes(m), m + " is not in browser storage");
    assert.ok(!consoleText.some((t) => t.includes(m)), m + " was never logged");
  }
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
});
