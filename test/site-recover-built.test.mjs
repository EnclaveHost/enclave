// The SHIPPED site, not the source tree: scripts/build-site.mjs's output made into a release by the site-release tool
// (scripts/site-release/release.mjs prepareRelease, no base) and served from that release's site/ tree with the release's
// own derived headers (its Content-Security-Policy included), in Chromium. No Nan or other remote service: every request
// that is not to the test's loopback servers is aborted and recorded (the synthetic profile's RPCs are answered here).
//   1. /recover/ as released, with its PRODUCTION config, served from a local origin: refuses to sign (the pinned origin
//      is https://enclave.host and the page says so), loads with no module or CSP error and no remote request.
//   2. the same released bytes with only recover-config.json pointing at a local fixture origin and a local anvil running
//      the production-source credit-vault factory (d36100ae, deploy settings; test/fixtures): synthetic passkeys in
//      Chromium's virtual authenticator; the page derives the exact vault, signs the app's sign-in text, and the vault
//      accepts the ERC-6492 signature on chain. Refused: a raw digest, a message for another vault, a non-sign-in text,
//      a stranger's passkey for the account's vault (vault refuses), the account's own passkey asserting from ANOTHER
//      origin (page refuses; a raw assertion from there is refused by the vault).
//   3. dashboard navigation of the default build still works (header links, pretty URLs), hosted defaults (no profile).
//   4. the build with --built-in-profile: a fresh browser with empty storage starts in independent mode on exactly that
//      profile (its fingerprint), reads the profile's address book through the profile's RPCs, stores nothing.
//   SITE_DIST=… SITE_PROFILE_DIST=… SITE_PROFILE_FILE=… node --test test/site-recover-built.test.mjs
//   (work/site-passkey-recovery-integration/harness/build-variants.sh builds both with the real build script)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createPublicClient, http as viemHttp, encodeDeployData, hashMessage, decodeAbiParameters, decodeFunctionData } from "viem";
import { prepareRelease } from "../scripts/site-release/release.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium; try { ({ chromium } = require("playwright")); } catch {}
const { SITE_DIST, SITE_PROFILE_DIST, SITE_PROFILE_FILE } = process.env;
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !chromium ? "Playwright unavailable" : !haveAnvil ? "needs Foundry's anvil"
  : !(SITE_DIST && SITE_PROFILE_DIST && SITE_PROFILE_FILE) ? "needs SITE_DIST, SITE_PROFILE_DIST and SITE_PROFILE_FILE (built by scripts/build-site.mjs)" : false;
const VAULT = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/credit-vault-d36100ae.json"), "utf8"));
const PROD_ORIGIN = "https://enclave.host";
const b64u = (b) => Buffer.from(b).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm", ".map": "application/json", ".webp": "image/webp", ".woff2": "font/woff2", ".xml": "application/xml" };

/** A release's site/ tree served the way the gateway serves it: index.html for directories (with the trailing-slash
 *  redirect), the release's _redirects for absent paths, 404.html otherwise, and the release's headers on everything. */
function serveRelease(siteDir, headers, port, overrides = {}) {
  const rules = fs.readFileSync(path.join(siteDir, "_redirects"), "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
    .map((l) => l.split(/\s+/));
  const served = [];
  const send = (res, status, file, extra = {}) => {
    res.writeHead(status, { ...headers, "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store", ...extra });
    res.end(fs.readFileSync(file));
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = decodeURIComponent(u.pathname);
    served.push(p);
    if (overrides[p] !== undefined) { res.writeHead(200, { ...headers, "content-type": "application/json", "cache-control": "no-store" }); return res.end(overrides[p]); }
    let f = path.join(siteDir, p);
    if (!f.startsWith(siteDir)) { res.writeHead(400); return res.end(); }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) {
      if (!p.endsWith("/")) { res.writeHead(301, { ...headers, location: p + "/" + u.search }); return res.end(); }
      f = path.join(f, "index.html");
    }
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return send(res, 200, f);
    const r = rules.find(([from]) => from === p);
    if (r && r[2] === "200") return send(res, 200, path.join(siteDir, r[1]));
    if (r) { res.writeHead(Number(r[2]), { ...headers, location: r[1] }); return res.end(); }
    send(res, 404, path.join(siteDir, "404.html"));
  });
  return new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok({ srv, served, origin: `http://localhost:${port}` })));
}

function passkey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }), id = crypto.randomBytes(16);
  return { credId: b64u(id), idB64: id.toString("base64"), pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    x: "0x" + Buffer.from(jwk.x, "base64url").toString("hex"), y: "0x" + Buffer.from(jwk.y, "base64url").toString("hex") };
}
const siwe = (site, address, extra = "") => `${site} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to the synthetic app.\n\n`
  + `URI: https://${site}\nVersion: 1\nChain ID: 8453\nNonce: ${crypto.randomBytes(8).toString("hex")}\nIssued At: ${new Date().toISOString()}\n`
  + `Resources:\n- urn:enclave:deployment:0x${"cc".repeat(32)}${extra}`;

test("the built and released site: passkey recovery signer, dashboard navigation, built-in profile", { skip, timeout: 360000 }, async (t) => {
  const stops = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-recover-built-"));
  stops.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  try {
    // ---- the releases: exactly what site/deploy.sh prepare makes from a build (no base: a first release) ----
    const rel = prepareRelease({ dist: path.resolve(SITE_DIST), installers: path.join(REPO, "cli"), out: path.join(tmp, "rel"), noBase: true });
    const relP = prepareRelease({ dist: path.resolve(SITE_PROFILE_DIST), installers: path.join(REPO, "cli"), out: path.join(tmp, "relp"), noBase: true });
    const site = path.join(rel.dir, "site"), siteP = path.join(relP.dir, "site");
    const H = rel.manifest.headers;
    assert.match(H["Content-Security-Policy"], /script-src 'self'/); assert.doesNotMatch(H["Content-Security-Policy"], /script-src[^;]*'unsafe-inline'/);
    for (const f of ["recover/index.html", "recover/recover.js", "recover/recover-config.json", "vendor/aa.js"])
      assert.ok(fs.statSync(path.join(site, f)).isFile(), f + " is in the release");
    const relFile = (f) => fs.readFileSync(path.join(site, f));
    assert.deepEqual(JSON.parse(relFile("recover/recover-config.json")), JSON.parse(fs.readFileSync(path.join(REPO, "site/recover/recover-config.json"), "utf8")));
    assert.equal(JSON.parse(relFile("recover/recover-config.json")).origin, PROD_ORIGIN, "the release ships the production pin");
    assert.doesNotMatch(relFile("recover/index.html").toString(), /<script(?![^>]*\bsrc=)[^>]*>/, "the page has no inline script");
    assert.doesNotMatch(relFile("recover/recover.js").toString(), /from"\.\.?\/|import\("\.\.?\//, "the page module is self-contained apart from /vendor");
    t.diagnostic(`release ${rel.cid}: ${rel.manifest.files.length} files; profile release ${relP.cid}`);

    // ---- the chain: anvil (RIP-7212 P-256 precompile, as Base) with the production-source credit-vault factory ----
    const [pa, pb, pc, cport] = [await freePort(), await freePort(), await freePort(), await freePort()];
    const A_ORIGIN = `http://localhost:${pa}`, B_ORIGIN = `http://localhost:${pb}`, C_ORIGIN = `http://localhost:${pc}`;
    const anvil = spawn("anvil", ["--port", String(cport), "--chain-id", "8453", "--network", "optimism", "--silent"], { stdio: "ignore" });
    stops.push(() => anvil.kill("SIGKILL"));
    const chain = createPublicClient({ transport: viemHttp(`http://127.0.0.1:${cport}`) });
    for (let i = 0; ; i++) { try { await chain.getChainId(); break; } catch { if (i > 150) throw new Error("anvil did not start"); await sleep(100); } }
    const [from] = await chain.request({ method: "eth_accounts" });
    const txh = await chain.request({ method: "eth_sendTransaction", params: [{ from, gas: "0x7a1200", data: encodeDeployData({ abi: VAULT.factory.abi,
      bytecode: VAULT.factory.bytecode, args: ["0x" + "01".repeat(20), "0x" + "02".repeat(20), "0x" + "03".repeat(20), B_ORIGIN, ""] }) }] });
    let rc; while (!(rc = await chain.request({ method: "eth_getTransactionReceipt", params: [txh] }))) await sleep(100);
    assert.equal(rc.status, "0x1");
    const factory = rc.contractAddress.toLowerCase();
    const implementation = (await chain.readContract({ address: factory, abi: VAULT.factory.abi, functionName: "implementation" })).toLowerCase();
    const fixtureCfg = JSON.stringify({ origin: B_ORIGIN, rpId: "localhost", factory, implementation });

    // ---- servers: A = the release as is; B = the release with the fixture config; C = another origin, same files ----
    const sA = await serveRelease(site, H, pa), sB = await serveRelease(site, H, pb, { "/recover/recover-config.json": fixtureCfg }),
      sC = await serveRelease(site, H, pc, { "/recover/recover-config.json": fixtureCfg });
    const pd = await freePort(), sP = await serveRelease(siteP, relP.manifest.headers, pd);
    for (const s of [sA, sB, sC, sP]) stops.push(() => s.srv.close());

    // ---- the browser: anything not on these loopback servers is aborted and recorded; the synthetic RPCs are answered ----
    const remote = [], rpcCalls = [];
    const block = () => ({ number: "0x1000", hash: "0x" + "11".repeat(32), parentHash: "0x" + "10".repeat(32), timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
      baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [] });
    const rpcAnswer = (m) => m.method === "eth_chainId" ? { result: "0x2105" } : m.method === "eth_blockNumber" ? { result: "0x1000" }
      : m.method === "eth_getBlockByNumber" || m.method === "eth_getBlockByHash" ? { result: block() }
      : m.method === "eth_getCode" ? { result: "0x" } : { error: { code: 3, message: "execution reverted" } };
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--disable-gpu", "--disable-dev-shm-usage",
      "--renderer-process-limit=1", "--disable-extensions", "--js-flags=--max-old-space-size=192"] });
    stops.push(() => browser.close());
    const newContext = async () => {
      const ctx = await browser.newContext({ reducedMotion: "reduce" });
      await ctx.route("**/*", async (route) => {
        const u = new URL(route.request().url());
        if (["localhost", "127.0.0.1"].includes(u.hostname)) return route.continue();
        if (/^rpc-[ab]\.builtin\.invalid$/.test(u.hostname)) {
          if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
          const body = JSON.parse(route.request().postData() || "null"), one = (m) => ({ jsonrpc: "2.0", id: m.id, ...rpcAnswer(m) });
          for (const m of [].concat(body)) rpcCalls.push({ host: u.hostname, method: m.method, params: m.params });
          return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
        }
        remote.push(u.origin + u.pathname);
        return route.abort("blockedbyclient");
      });
      await ctx.addInitScript(() => { window.__csp = []; addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI)); });
      return ctx;
    };
    const watch = (page) => { const errs = []; page.on("pageerror", (e) => errs.push(String(e))); return errs; };

    // ================= 1. /recover/ as released (production config) on a local origin =================
    const ctx = await newContext();
    const page = await ctx.newPage(), errs = watch(page);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const K1 = passkey(), K2 = passkey(), K3 = passkey();       // K1, K2: the account's (in its migration file); K3: a stranger's
    for (const k of [K1, K2, K3]) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { credentialId: k.idB64, isResidentCredential: false,
      rpId: "localhost", privateKey: k.pkcs8, signCount: 0 } });
    const bundleFile = path.join(tmp, "migration.json");
    fs.writeFileSync(bundleFile, JSON.stringify({ kind: "EAB1-bundle", account: "acct_6a70718293a4b5c6d7e8f901",
      credentials: [K1, K2].map((k) => ({ kind: "passkey", value: `p256:${k.x.slice(2)}:${k.y.slice(2)}:${k.credId}` })) }));

    const resp = await page.goto(`${A_ORIGIN}/recover`);       // no trailing slash: the directory redirect, as gateways do
    assert.equal(resp.status(), 200); assert.equal(new URL(page.url()).pathname, "/recover/");
    await page.waitForFunction(() => document.querySelector("#note").textContent.length > 0);
    assert.match(await page.textContent("#note"), /only works at https:\/\/enclave\.host/);
    assert.equal(await page.getAttribute("#note", "class"), "bad");
    assert.ok(await page.isDisabled("#file") && await page.isDisabled("#sign"), "nothing can be loaded or signed at a wrong origin");
    const prodRefusal = await page.evaluate(async (x) => { const M = await import("/recover/recover.js");
      try { await M.signAsVault("anything", x); return "signed"; } catch (e) { return e.message; } }, { credId: K1.credId, x: K1.x, y: K1.y });
    assert.match(prodRefusal, /only works at https:\/\/enclave\.host.*Nothing was signed/);
    // the exact production derivation, by the shipped module (vectors: live vaultFor on Base, block 52859909)
    const prodVaults = await page.evaluate(async () => { const M = await import("/recover/recover.js"); return [
      M.vaultFor("0xc3f9e63cca407c6b44136db774e3d590565f53ac38d41dd4104a68060349b3c6", "0xc88c29a21177c272742fefab2f9eb0d1fa74b5a4c48a75d1fa524634a34b2aee"),
      M.vaultFor("0x61ede4d58bad446d4fe8f61f83c24baba1da91014e27a0be5079987f0d837e91", "0x1fc56d668056fe9b065c9690f56a2e7172f372cfc12c9b2e7d0078165cdfde2f")]; });
    assert.deepEqual(prodVaults, ["0x80a326cf9ed0fdbd732be734573b0e7735a50e13", "0xbdcc07e7c792e6c98745d806ad1b52c70c46f084"]);
    assert.deepEqual(await page.evaluate(() => window.__csp), [], "no CSP violation under the release's headers");
    assert.deepEqual(errs, []);
    for (const p of ["/recover/", "/recover/recover.js", "/recover/recover-config.json", "/vendor/aa.js"]) assert.ok(sA.served.includes(p), p + " served from the release");
    t.diagnostic("1. production config at a local origin: refused before any prompt; derivation = live vectors; no CSP/module errors");

    // ================= 2. the fixture origin: sign, verify on chain, refusals =================
    const vaultOf = async (k) => (await chain.readContract({ address: factory, abi: VAULT.factory.abi, functionName: "vaultFor", args: [BigInt(k.x), BigInt(k.y)] })).toLowerCase();
    const V1 = await vaultOf(K1), V2 = await vaultOf(K2), V3 = await vaultOf(K3);
    await page.goto(`${B_ORIGIN}/recover/`);
    await page.setInputFiles("#file", bundleFile);
    await page.waitForSelector("#step2", { state: "visible" });
    assert.equal((await page.textContent("#vault")).trim(), V1, "the page shows the factory's own vaultFor for passkey 1");
    await page.selectOption("#key", "1");
    assert.equal((await page.textContent("#vault")).trim(), V2, "and for passkey 2");
    await page.selectOption("#key", "0");
    const signOnPage = async (message) => {
      await page.fill("#message", message); await page.click("#sign");   // the click clears the old signature first
      await page.waitForFunction(() => document.querySelector("#signature").value.length > 0 || document.querySelector("#note").className === "bad", null, { timeout: 30000 });
      return { signature: await page.inputValue("#signature"), note: await page.textContent("#note") };
    };
    const msg = siwe("jot.app.example", V1);
    const ok = await signOnPage(msg);
    assert.match(ok.note, /^Signed\./); assert.match(ok.signature, /^0x[0-9a-f]+(6492){16}$/);
    assert.equal(await chain.verifyMessage({ address: V1, message: msg, signature: ok.signature }), true, "the vault accepts the page's ERC-6492 signature");
    assert.equal(await chain.getCode({ address: V1 }), undefined, "the vault was never deployed (ERC-6492 only)");
    // what was signed: the shared EIP-191 hash of the exact text, at this origin, in the 6492 wrapper of THIS factory's createVault(x, y)
    const [wf, wcall, inner] = decodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "bytes" }], "0x" + ok.signature.slice(2, -64));
    assert.equal(wf.toLowerCase(), factory);
    assert.deepEqual(decodeFunctionData({ abi: VAULT.factory.abi, data: wcall }).args, [BigInt(K1.x), BigInt(K1.y)]);
    const [w] = decodeAbiParameters([{ type: "tuple", components: [{ name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" },
      { name: "r", type: "uint256" }, { name: "s", type: "uint256" }, { name: "x", type: "uint256" }, { name: "y", type: "uint256" }] }], inner);
    const cd = JSON.parse(w.clientDataJSON);
    assert.equal(cd.type, "webauthn.get"); assert.equal(cd.origin, B_ORIGIN);
    assert.equal(cd.challenge, b64u(Buffer.from(hashMessage(msg).slice(2), "hex")));
    assert.equal(await chain.verifyMessage({ address: V1, message: msg + " ", signature: ok.signature }), false, "bound to the exact text");
    assert.equal(await chain.verifyMessage({ address: V2, message: msg, signature: ok.signature }), false, "bound to its own vault");

    // the page refuses: a raw digest, text that is not an app's sign-in, a sign-in naming another vault (another account
    // or an arbitrary address), and the account's own passkey's message with the other passkey selected
    for (const [what, text, re] of [
      ["a raw 32-byte digest", "0x" + "ab".repeat(32), /not a sign-in message/],
      ["a raw digest, labelled", "Sign this hash:\n0x" + "ab".repeat(32), /not a sign-in message/],
      ["a sign-in naming no Enclave deployment", siwe("jot.app.example", V1).replace(/urn:enclave:deployment:\S+/, "https://example.com/x"), /names no Enclave deployment/],
      ["a sign-in for a stranger's vault", siwe("jot.app.example", V3), /another address/],
      ["a sign-in for an arbitrary address", siwe("jot.app.example", "0x" + "12".repeat(20)), /another address/],
    ]) {
      const r = await signOnPage(text);
      assert.equal(r.signature, "", what + ": nothing signed"); assert.match(r.note, re, what);
    }
    await page.selectOption("#key", "1");
    assert.match((await signOnPage(msg)).note, /another address/, "passkey 2 does not sign passkey 1's vault message");
    await page.selectOption("#key", "0");

    // what an attacker could make outside the page, with the same vendored signer: a stranger's passkey asserting for the
    // account's vault, and (from another origin) the account's own passkey - the vault refuses both
    const raw = (origin, message, key, createFor) => page.evaluate(async ({ message, key, createFor, factory }) => {
      const L = await import("/vendor/aa.js");
      const b = new TextEncoder().encode(message);
      const challenge = L.keccak256(L.concat([L.toHex(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${b.length}`)), L.toHex(b)]));
      const a = await L.WebAuthnP256.sign({ challenge, credentialId: key.credId, rpId: "localhost", userVerification: "required" });
      const SIG = { type: "tuple", components: [{ name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" },
        { name: "r", type: "uint256" }, { name: "s", type: "uint256" }, { name: "x", type: "uint256" }, { name: "y", type: "uint256" }] };
      const inner = L.encodeAbiParameters([SIG], [{ authenticatorData: a.metadata.authenticatorData, clientDataJSON: a.metadata.clientDataJSON, r: a.signature.r, s: a.signature.s, x: BigInt(createFor.x), y: BigInt(createFor.y) }]);
      const deploy = L.encodeFunctionData({ abi: [{ type: "function", name: "createVault", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "address" }] }], functionName: "createVault", args: [BigInt(createFor.x), BigInt(createFor.y)] });
      return L.concat([L.encodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "bytes" }], [factory, deploy, inner]), "0x" + "6492".repeat(16)]);
    }, { message, key, createFor, factory });
    const stranger = await raw(B_ORIGIN, msg, K3, K1);
    assert.equal(await chain.verifyMessage({ address: V1, message: msg, signature: stranger }), false, "a stranger's passkey cannot sign as the account's vault");
    // positive control on the same path: the account's own passkey at the pinned origin is accepted
    assert.equal(await chain.verifyMessage({ address: V1, message: msg, signature: await raw(B_ORIGIN, msg, K1, K1) }), true, "control: own passkey, pinned origin");
    await page.goto(`${C_ORIGIN}/recover/`);
    await page.waitForFunction(() => document.querySelector("#note").textContent.length > 0);
    assert.match(await page.textContent("#note"), new RegExp("only works at " + B_ORIGIN.replace(/[.]/g, "\\.")));
    assert.ok(await page.isDisabled("#sign"));
    const elsewhere = await raw(C_ORIGIN, msg, K1, K1);
    assert.equal(await chain.verifyMessage({ address: V1, message: msg, signature: elsewhere }), false, "the account's own passkey from another origin is refused by the vault");
    assert.deepEqual(await page.evaluate(() => window.__csp), []);
    assert.deepEqual(errs, []);
    assert.deepEqual(remote, [], "the signer page made no remote request");
    t.diagnostic(`2. fixture origin: vault ${V1} accepts the page's 6492 signature; 7 page refusals; vault refuses stranger + other origin`);
    await ctx.close();

    // ================= 3. dashboard navigation of the default build (hosted defaults, no profile) =================
    const ctx3 = await newContext();
    const nav = await ctx3.newPage(), errs3 = watch(nav);
    await nav.goto(`${A_ORIGIN}/`);
    await nav.waitForSelector(".nav-links a[data-view='apps']");
    const seen = [];
    for (const view of ["apps", "develop", "host", "overview"]) {
      await nav.click(`.nav-links a[data-view='${view}']`);
      await nav.waitForFunction((v) => document.querySelector(`.nav-links a[data-view='${v}']`)?.classList.contains("active"), view, { timeout: 20000 });
      seen.push(new URL(nav.url()).pathname);
    }
    assert.ok(/^\/apps\/?$/.test(seen[0]) && /^\/develop$/.test(seen[1]) && /^\/host$/.test(seen[2]) && /^\/(index\.html)?$/.test(seen[3]), seen.join(" "));
    for (const p of ["/dashboard", "/apps/publish", "/sessions"]) {
      const r = await nav.goto(`${A_ORIGIN}${p}`);
      assert.equal(r.status(), 200, p);
      await nav.waitForSelector("c-header[data-ssr] .nav-links", { timeout: 20000 });
    }
    assert.equal(await nav.evaluate(() => document.querySelector(".ind-on")), null, "the default build ships no built-in profile");
    assert.equal(await nav.evaluate(() => localStorage.getItem("enclave_independent_profile")), null);
    assert.deepEqual(await nav.evaluate(() => window.__csp), [], "no CSP violation in dashboard navigation");
    assert.deepEqual(errs3.filter((e) => !/Failed to fetch|blockedbyclient|ERR_BLOCKED|NetworkError|net::/i.test(e)), [], "no page error besides the blocked hosted API");
    t.diagnostic(`3. navigation ${seen.join(" -> ")}; hosted endpoints attempted and blocked: ${[...new Set(remote.map((u) => new URL(u).host))].join(", ") || "none"}`);
    await ctx3.close();

    // ================= 4. the --built-in-profile build: a fresh browser, empty storage =================
    const text = fs.readFileSync(SITE_PROFILE_FILE, "utf8"), fp = crypto.createHash("sha256").update(fs.readFileSync(SITE_PROFILE_FILE)).digest("hex");
    const profile = JSON.parse(text);
    const ctx4 = await newContext();
    const dash = await ctx4.newPage(), errs4 = watch(dash);
    assert.deepEqual((await ctx4.storageState()).origins, [], "empty storage");
    const before = remote.length;
    await dash.goto(`http://localhost:${pd}/dashboard`);
    await dash.waitForSelector(".ind-panel.ind-on", { timeout: 30000 });
    const panel = await dash.textContent(".ind-panel.ind-on");
    assert.match(panel, /Independent mode/); assert.ok(panel.includes(profile.name), "the built-in profile's name");
    assert.match(panel, /built into this site/);
    await dash.waitForFunction(() => /sha256:[0-9a-f]{64}/.test(document.querySelector(".ind-fp")?.textContent || ""));
    assert.equal((await dash.textContent(".ind-fp")).trim(), "fingerprint sha256:" + fp, "exactly the reviewed profile text");
    await dash.click(".ind-recheck");
    await dash.waitForFunction(() => (document.querySelector(".ind-out")?.textContent || "").length > 12, null, { timeout: 30000 });
    const book = profile.addressBook.toLowerCase();
    const bookReads = rpcCalls.filter((c) => c.method === "eth_call" && String(c.params?.[0]?.to).toLowerCase() === book);
    assert.ok(new Set(bookReads.map((c) => c.host)).size === 2, "the administrator's address book is read through both of the profile's RPCs");
    assert.equal(await dash.evaluate(() => localStorage.getItem("enclave_independent_profile")), null, "the built-in profile is not copied into storage");
    assert.deepEqual(await dash.evaluate(() => window.__csp), []);
    assert.deepEqual(remote.slice(before), [], "independent mode contacted nothing but the profile's RPCs");
    assert.deepEqual(errs4, []);
    t.diagnostic(`4. built-in profile "${profile.name}" sha256:${fp}: ${bookReads.length} book reads over ${new Set(rpcCalls.map((c) => c.host)).size} RPCs`);
    await ctx4.close();
  } finally {
    for (const s of stops.reverse()) { try { await s(); } catch {} }
  }
});
