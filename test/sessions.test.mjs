// Sessions end to end on a local chain: the SDK (sdk/sessions, built) drives the
// REAL relayer (relay/sessions.mjs) over HTTP, which submits to the REAL
// SessionVault deployed by scripts/deploy-session-vault.mjs, against the REAL
// ledger, catalog and PaymentRouter. Skips when Foundry (anvil/forge) is absent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http as viemHttp, parseUnits } from "viem";
import { foundry } from "viem/chains";
import { haveFoundry, startChain, deployPlatform, KEYS } from "./helpers/sessions-chain.mjs";
import { createSessionsService, createCustodyGate } from "../relay/sessions.mjs";
import { JsonStore } from "../relay/store.js";
import * as sdk from "../sdk/sessions/dist/node.mjs";

const skip = !haveFoundry() || !fs.existsSync(new URL("../sdk/sessions/dist/node.mjs", import.meta.url))
  ? "needs Foundry (anvil + forge) and a built SDK (cd sdk/sessions && npm run build)" : false;

let chain, P, svc, server, relayUrl, tmp, stores = [];
const owner = privateKeyToAccount(KEYS.owner);
const ownerSigner = { address: owner.address, signTypedData: (td) => owner.signTypedData(td) };

before(async () => {
  if (skip) return;
  chain = await startChain();
  P = await deployPlatform(chain);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-relay-"));
  const relayer = privateKeyToAccount(KEYS.relayer);
  svc = createSessionsService({
    pc: chain.pc, wc: createWalletClient({ chain: foundry, account: relayer, transport: viemHttp(chain.rpc) }),
    account: relayer, chainId: 31337, factory: P.factory, book: P.book, usdc: P.usdc, router: P.router,
    startBlock: P.deployBlock, ethUsd: 3000, minFee6: 500, now: chain.now,
    // Base today: ~0.005 gwei base + 0.001 gwei tip (anvil suggests a 1 gwei tip, 1000x Base)
    feesPerGas: async () => ({ maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    store: (stores[0] = new JsonStore(path.join(tmp, "idx.json"), {})),
    journal: (stores[1] = new JsonStore(path.join(tmp, "j.json"), { txs: [] }, { durable: true })),
    log: (...a) => { if (process.env.SESSIONS_TEST_LOG) console.log("[relay]", ...a); }, alert: (k, d) => { alerts.push([k, d]); },
  });
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://relay.test");
    if (u.pathname.startsWith("/v1/sessions")) return svc.handle(req, res, u, null);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, r));
  relayUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (process.env.SESSIONS_TEST_LOG && stores[1])
    for (const t of stores[1].data.txs) console.log("gas", t.label.replace(/ 0x[0-9a-f]+/, ""), t.gasUsed);
  for (const st of stores) clearInterval(st._timer);
  server?.close(); chain?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});
const alerts = [];

const usdcBal = async (a) => chain.pc.readContract({ address: P.usdc, abi: P.abi.usdc.abi, functionName: "balanceOf", args: [a] });

async function openFor(preset, { apps, budget = 0n, expiresIn, label = "test" } = {}) {
  const store = new sdk.MemoryStore();
  const { signer, record } = await sdk.newSessionKey(store, { relay: relayUrl, chainId: 31337, label, extractable: true });
  const grant = sdk.buildGrant({ sessionKey: signer.keyHash, label, preset,
    policy: { ...(apps ? { apps } : {}), budget, ...(expiresIn ? { expiresIn } : {}) } });
  const relay = new sdk.RelayClient(relayUrl);
  const vault = await sdk.vaultAddress(chain.pc, P.factory, owner.address);
  const usdc = budget > 0n ? await sdk.usdcDomain(chain.pc, P.usdc, 31337) : undefined;
  const out = await sdk.openSession({ relay, owner: ownerSigner, chainId: 31337, vault, grant, usdc });
  const rec = await sdk.completeSession(store, record, { vault, owner: owner.address, grant, rpc: chain.rpc });
  const session = await sdk.sessionFromRecord(rec);
  return { session, grant, vault, sid: out.sid, store, relay, signer };
}

test("agent staging-publish flow: publish, deploy to staging, re-point, sign out with refund", { skip }, async () => {
  const before = await usdcBal(owner.address);
  const { session, vault, sid } = await openFor("staging-publish", { apps: ["mine-staging"], budget: parseUnits("10", 6), label: "Claude Code" });
  assert.equal(await usdcBal(vault), parseUnits("10", 6));
  const st = await session.status();
  assert.equal(st.live, true);
  assert.equal(st.envs, 1);

  const pub = await session.call("app.publish", { slug: "mine-staging", name: "Mine (staging)", description: "",
    version: "0.1.0", cid: "bafymine1", res: [0, 0, 256, 10], ports: "", config: "{}", configCid: "" });
  assert.match(pub.txHash, /^0x[0-9a-f]{64}$/);
  const appId = await chain.pc.readContract({ address: P.catalog, abi: P.abi.catalog.abi, functionName: "appIdOf", args: [vault, "mine-staging"] });
  const ref0 = `catalog://${appId}/0`;

  const created = await session.call("deploy.create", { appRef: ref0, gpuMilli: 0, cpuMilli: 1000, appPort: 8080, ports: "",
    isPublic: false, configCid: "", maxRate6: 1000n, env: "staging", fund6: parseUnits("2", 6) });
  const id = `0x${created.result.slice(2, 66)}`;
  const d = await chain.pc.readContract({ address: P.ledger, abi: P.abi.ledger.abi, functionName: "get", args: [id] });
  assert.equal(d.owner, vault);
  assert.equal(d.appRef, ref0);

  await session.call("app.publish", { slug: "mine-staging", name: "Mine (staging)", description: "", version: "0.1.1",
    cid: "bafymine2", res: [0, 0, 256, 10], ports: "", config: "{}", configCid: "" });
  await session.call("deploy.setAppRef", { id, appRef: `catalog://${appId}/1` });
  const d2 = await chain.pc.readContract({ address: P.ledger, abi: P.abi.ledger.abi, functionName: "get", args: [id] });
  assert.equal(d2.appRef, `catalog://${appId}/1`);

  // outside the preset: the session can't touch the store app, prod, or pay orders
  await assert.rejects(session.call("deploy.setShares", { id, gpuMilli: 0, cpuMilli: 500 }), (e) => e.code === "not_allowed");
  await assert.rejects(session.call("deploy.create", { appRef: P.storeRef, gpuMilli: 0, cpuMilli: 1000, appPort: 8080, ports: "",
    isPublic: false, configCid: "", maxRate6: 1000n, env: "staging", fund6: 0n }), (e) => e.code === "app");

  const spent = (await session.status()).spent6;
  const res = await session.terminate();
  assert.equal(res.refund6, parseUnits("10", 6) - spent);
  assert.equal(await usdcBal(owner.address), before - spent);
  assert.equal((await session.status()).live, false);
  // the index saw all of it
  await svc.indexOnce();
  const byKey = await new sdk.RelayClient(relayUrl).request("GET", `/by-key/${session.signer.keyHash}`);
  assert.equal(byKey.sessions[0].sid, sid);
  assert.equal(byKey.sessions[0].ended, true);
});

test("browser flow: zero-budget sign-in, wallet top-up, spend, promote, revoke-all", { skip }, async () => {
  const { session, vault, sid, relay } = await openFor("browser", { label: "this browser", expiresIn: 3600 });
  assert.equal((await session.status()).balance6, 0n);
  // spending with no budget fails up front with a code the UI turns into "Top up"
  const mkArgs = (fund6, env = "staging") => ({ appRef: P.storeRef, gpuMilli: 0, cpuMilli: 1000, appPort: 8080, ports: "",
    isPublic: false, configCid: "", maxRate6: 1000n, env, fund6 });
  await assert.rejects(session.call("deploy.create", mkArgs(parseUnits("1", 6))), (e) => e.code === "budget");
  const usdc = await sdk.usdcDomain(chain.pc, P.usdc, 31337);
  await sdk.topUpFromWallet({ relay, owner: ownerSigner, chainId: 31337, vault, sessionId: sid, amount: parseUnits("5", 6), usdc });
  assert.equal((await session.status()).balance6, parseUnits("5", 6));
  const t0 = await usdcBal(P.treasury);
  const made = await session.call("deploy.create", mkArgs(parseUnits("1", 6)));
  const sid0 = `0x${made.result.slice(2, 66)}`;
  const row0 = await chain.pc.readContract({ address: P.ledger, abi: P.abi.ledger.abi, functionName: "get", args: [sid0] });
  assert.equal(row0.balance6, parseUnits("1", 6), "the funding reached the deployment");
  assert.ok(await usdcBal(P.treasury) >= t0 + made.fee, "the relay fee reached the treasury");

  // a prod deployment created by the session, then promoted by the owner
  const c = await session.call("deploy.create", { appRef: P.storeRef, gpuMilli: 0, cpuMilli: 1000, appPort: 8080, ports: "",
    isPublic: true, configCid: "", maxRate6: 1000n, env: "prod", fund6: 0n });
  const id = `0x${c.result.slice(2, 66)}`;
  let held = await chain.pc.readContract({ address: vault, abi: sdk.sessionVaultAbi, functionName: "held", args: [id] });
  assert.equal(held[0], 2);
  assert.equal(held[1], "0x" + "00".repeat(32), "unpromoted until the owner says so");
  // the session cannot re-point prod
  await assert.rejects(session.call("deploy.setAppRef", { id, appRef: P.storeRef }), (e) => e.code === "env");
  // a copied slug + label under another publisher, or the wrong exposure, is refused on chain
  const promo = { op: "promote", deployment: id, app: "store", publisher: P.publisher, appRef: P.storeRef, configCid: "",
    versionLabel: "1.0.0", isPublic: true };
  await assert.rejects(sdk.ownerOperation({ relay, owner: ownerSigner, chainId: 31337, vault, op: { ...promo, publisher: owner.address } }),
    /LabelMismatch|mismatch/i);
  await assert.rejects(sdk.ownerOperation({ relay, owner: ownerSigner, chainId: 31337, vault, op: { ...promo, isPublic: false } }),
    /LabelMismatch|mismatch/i);
  await sdk.ownerOperation({ relay, owner: ownerSigner, chainId: 31337, vault, op: promo });
  held = await chain.pc.readContract({ address: vault, abi: sdk.sessionVaultAbi, functionName: "held", args: [id] });
  assert.notEqual(held[1], "0x" + "00".repeat(32));

  const before = await usdcBal(owner.address);
  const left = (await session.status()).balance6;
  await sdk.ownerOperation({ relay, owner: ownerSigner, chainId: 31337, vault, op: { op: "revokeAll", withdraw: true } });
  assert.equal((await session.status()).live, false);
  assert.ok(await usdcBal(owner.address) >= before + left);
  await assert.rejects(session.call("deploy.setActive", { id, active: false }), (e) => e.code === "not_live");
});

test("the SDK's typed-data shapes hash to the vault's typehashes", { skip }, async () => {
  const { vault } = await openFor("auth-only", { label: "pin" });
  const { keccak256, toBytes } = await import("viem");
  const NAMES = { SessionGrant: "GRANT", SessionCall: "CALL", SessionEnd: "END", TopUp: "TOPUP", Extend: "EXTEND",
    Terminate: "TERMINATE", RevokeAll: "REVOKE", Withdraw: "WITHDRAW", Promote: "PROMOTE", Adopt: "ADOPT",
    SetEnvironment: "SETENV", Release: "RELEASE" };
  assert.deepEqual(Object.keys(NAMES).sort(), Object.keys(sdk.TYPES).sort(), "every SDK type is pinned");
  for (const [t, c] of Object.entries(NAMES)) {
    const enc = `${t}(${sdk.TYPES[t].map((f) => `${f.type} ${f.name}`).join(",")})`;
    const onChain = await chain.pc.readContract({ address: vault, abi: [{ type: "function", name: `${c}_TYPEHASH`,
      stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }], functionName: `${c}_TYPEHASH` });
    assert.equal(keccak256(toBytes(enc)), onChain, t);
  }
});

test("API request auth: valid, replayed, tampered, out of scope, signed out", { skip }, async () => {
  const { session, vault, sid, relay, signer } = await openFor("staging-publish", { apps: ["api-staging"], budget: 0n });
  const url = "https://api.enclave.host/v1/deployments/0xabc/logs?tail=10";
  const hdr = await session.apiAuthorization("GET", url);
  const ok = await svc.verifyApiRequest({ header: hdr, method: "GET", hostPath: "api.enclave.host/v1/deployments/0xabc/logs?tail=10", scope: "api.logs" });
  assert.equal(ok.owner, owner.address);
  assert.equal(ok.vault, vault);
  await assert.rejects(svc.verifyApiRequest({ header: hdr, method: "GET", hostPath: "api.enclave.host/v1/deployments/0xabc/logs?tail=10", scope: "api.logs" }),
    /replayed/);
  const h2 = await session.apiAuthorization("POST", "https://api.enclave.host/v1/upload", '{"a":1}');
  await assert.rejects(svc.verifyApiRequest({ header: h2, method: "POST", hostPath: "api.enclave.host/v1/upload", body: Buffer.from('{"a":2}'), scope: "api.upload" }),
    /bad session signature/);
  const h3 = await session.apiAuthorization("GET", "https://api.enclave.host/v1/x");
  await assert.rejects(svc.verifyApiRequest({ header: h3, method: "GET", hostPath: "api.enclave.host/v1/x", scope: "api.appAccess" }),
    /lacks api.appAccess/);
  // another key presenting this session id
  const other = await sdk.signerFromKeyPair(await sdk.generateKeyPair(false));
  const h4 = await sdk.signApiRequest(other, vault, sid, "GET", "https://api.enclave.host/v1/x");
  await assert.rejects(svc.verifyApiRequest({ header: h4, method: "GET", hostPath: "api.enclave.host/v1/x", scope: "api.status" }),
    /does not belong/);
  // sign-out revokes API access in the same flow
  await session.terminate();
  const h5 = await session.apiAuthorization("GET", "https://api.enclave.host/v1/x");
  await assert.rejects(svc.verifyApiRequest({ header: h5, method: "GET", hostPath: "api.enclave.host/v1/x", scope: "api.status" }),
    /signed out/);
  void relay; void signer;
});

test("relay maps vault reverts to typed errors and refuses unknown vaults", { skip }, async () => {
  const { session } = await openFor("staging-publish", { apps: ["e-staging"], budget: parseUnits("1", 6) });
  // bypass the SDK's pre-check: ask the relay directly to spend more than the budget
  const q = await session.relay.request("POST", "/quote", { vault: session.handle.vault, sid: session.handle.sid, action: 1, args: "0x" });
  const args = sdk.encodeArgs("deploy.fund", { id: "0x" + "12".repeat(32), amount6: parseUnits("50", 6) });
  const digest = sdk.digestOf(31337, session.handle.vault, "SessionCall", { sessionId: session.handle.sid, nonce: q.nonce, action: 1,
    argsHash: (await import("viem")).keccak256(args), fee: q.fee, deadline: q.deadline });
  const { r, s } = await session.signer.signDigest(digest);
  await assert.rejects(session.relay.request("POST", "/execute", { vault: session.handle.vault, sid: session.handle.sid, nonce: q.nonce,
    action: 1, args, fee: q.fee, deadline: q.deadline, x: session.signer.x, y: session.signer.y, r, s }),
  (e) => e instanceof sdk.SessionError && e.code === "budget");
  await assert.rejects(session.relay.request("POST", "/quote", { vault: P.ledger, sid: session.handle.sid, action: 1, args: "0x" }),
    (e) => e.code === "not_a_vault");
});

test("owner-only operations are unreachable for a session key, and the relay checks vault ownership", { skip }, async () => {
  const { vault, sid, relay } = await openFor("staging-publish", { apps: ["o-staging"], budget: 0n });
  const stranger = privateKeyToAccount(KEYS.stranger);
  const strangerSigner = { address: stranger.address, signTypedData: (td) => stranger.signTypedData(td) };
  await assert.rejects(sdk.ownerOperation({ relay, owner: strangerSigner, chainId: 31337, vault, op: { op: "withdraw", amount: 1n } }),
    (e) => e.code === "not_owner");
  // a signature from the wrong wallet presented as the owner's is refused by the vault itself
  const opNonce = "0x" + "77".repeat(32);
  const signBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const td = sdk.typedData(31337, vault, "Terminate", { sessionId: sid, opNonce, signBefore });
  const forged = await stranger.signTypedData(td);
  await assert.rejects(relay.request("POST", "/owner", { owner: owner.address, vault, op: "terminate",
    args: { sessionId: sid, opNonce, signBefore }, sig: forged }), (e) => e.code === "signature");
});

test("secret-release custody gate: staging releases, prod only once promoted, unadopted never, wallet rows untouched", { skip }, async () => {
  const gate = createCustodyGate({ pc: chain.pc, book: P.book, ttlMs: 0 });
  const { session, vault, relay } = await openFor("browser", { budget: parseUnits("1", 6), label: "gate" });
  const mk = async (env) => {
    const c = await session.call("deploy.create", { appRef: P.storeRef, gpuMilli: 0, cpuMilli: 1000, appPort: 8080, ports: "",
      isPublic: true, configCid: "", maxRate6: 1000n, env, fund6: 0n });
    return `0x${c.result.slice(2, 66)}`;
  };
  const row = (id) => chain.pc.readContract({ address: P.ledger, abi: P.abi.ledger.abi, functionName: "get", args: [id] });
  const stg = await mk("staging");
  const prd = await mk("prod");
  assert.equal(await gate.custodyRefusal(await row(stg)), null);
  assert.match(await gate.custodyRefusal(await row(prd)), /not been promoted/);
  await sdk.ownerOperation({ relay, owner: ownerSigner, chainId: 31337, vault,
    op: { op: "promote", deployment: prd, app: "store", publisher: P.publisher, appRef: P.storeRef, configCid: "",
      versionLabel: "1.0.0", isPublic: true } });
  assert.equal(await gate.custodyRefusal(await row(prd)), null, "promoted: releases");
  const prdUnpromoted = await mk("prod");
  // a deployment gifted into the vault is inert until adopted
  const stranger = chain.wc(KEYS.stranger);
  const h = await stranger.writeContract({ address: P.ledger, abi: P.abi.ledger.abi, functionName: "create",
    args: [P.storeRef, 0, 1000, 8080, "", true, "", "0x0000000000000000000000000000000000000000", 0n, 1_000_000n] });
  const rc = await chain.pc.waitForTransactionReceipt({ hash: h });
  const gift = rc.logs.find((l) => l.address.toLowerCase() === P.ledger.toLowerCase()).topics[1];
  await chain.pc.waitForTransactionReceipt({ hash: await stranger.writeContract({ address: P.ledger, abi: P.abi.ledger.abi,
    functionName: "transferDeployment", args: [gift, vault] }) });
  assert.match(await gate.custodyRefusal(await row(gift)), /not adopted/);
  // wallet-held rows and owner resolution
  const mine = await row(gift);
  assert.equal(await gate.custodyRefusal({ ...mine, owner: owner.address }), null, "a wallet-held row passes untouched");
  assert.equal(await gate.beneficialOwner(vault), owner.address);
  assert.equal(await gate.beneficialOwner(owner.address), owner.address);
  // a relay that no longer knows the vault's factory (rotated out of the book, history unset)
  // still gates it: held() answers, so an unpromoted prod record stays refused
  const blind = createCustodyGate({ pc: chain.pc, book: null, ttlMs: 0 });
  assert.equal(await blind.vaultOwnerOf(vault), null);
  assert.match(await blind.custodyRefusal(await row(prdUnpromoted)), /not been promoted/);
  assert.match(await blind.custodyRefusal(await row(gift)), /not adopted/);
  assert.equal(await blind.custodyRefusal(await row(stg)), null);
  // a contract owner with no held() (here the USDC token) passes like a wallet
  assert.equal(await blind.custodyRefusal({ ...mine, owner: P.usdc }), null);
  // an unreachable chain refuses (the callers fail closed on a throw)
  const dead = createCustodyGate({ pc: { getCode: async () => "0x60", call: async () => { throw new Error("fetch failed"); },
    readContract: async () => { throw new Error("fetch failed"); } }, book: null, ttlMs: 0 });
  await assert.rejects(dead.custodyRefusal({ ...mine, owner: vault }), /fetch failed/);
});

test("session-derived account token: sign-in, short SSO tokens, dies with the session", { skip }, async () => {
  // the relay's account + SSO modules in-process, wired to the sessions service exactly as api-relay.js does
  process.env.AUTH_DATA_DIR = fs.mkdtempSync(path.join(tmp, "auth-"));
  process.env.SSO_SIGNER_KEY = "0x" + "42".repeat(32);
  const auth = await import("../relay/auth.js");
  const sso = await import("../relay/sso.js");
  assert.equal((await auth.initAccounts()).enabled, true);
  assert.equal((await sso.initSso()).enabled, true);
  auth.setSessionHooks({
    verify: (req, raw) => svc.verifyApiRequest({ header: req.headers.authorization || "", method: req.method,
      hostPath: req.headers.host + new URL(req.url, "http://relay").pathname, body: raw, scope: "api.account", fresh: true }),
    state: async (vault, sid) => {
      const r = await svc.route("GET", `/session/${vault}/${sid}`, {});
      return { ...r.state, live: Boolean(r.state.live) && !r.revoked };
    },
    isRevoked: (sid) => Boolean(svc.store?.data?.revoked?.[String(sid).toLowerCase()]),
  });
  const ctx = {
    json: (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); },
    cors: () => ({}), clientIp: () => "127.0.0.1",
    readBody: async (req) => { const b = []; for await (const c of req) b.push(c); return Buffer.concat(b); },
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://relay");
    if (u.pathname.startsWith("/v1/sso")) return sso.handleSso(req, res, u, ctx);
    return auth.handleAccount(req, res, u, ctx);
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const post = async (p, { headers = {}, body } = {}) => {
      const r = await fetch(base + p, { method: "POST", headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    // an agent's staging key has no api.account: no account token
    const agent = await openFor("staging-publish", { apps: ["acct-agent"], budget: 0n });
    const refused = await post("/v1/account/session-login",
      { headers: { Authorization: await agent.session.apiAuthorization("POST", base + "/v1/account/session-login", "") } });
    assert.equal(refused.status, 403);
    assert.match(refused.body.message, /lacks api.account/);

    const { session, sid, vault } = await openFor("browser", { budget: 0n });
    const login = await post("/v1/account/session-login",
      { headers: { Authorization: await session.apiAuthorization("POST", base + "/v1/account/session-login", "") } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.sid, sid);
    assert.equal(login.body.vault, vault);
    const tok = { Authorization: "Bearer " + login.body.token };
    const aud = "0x" + "ab".repeat(32);
    // an est1 can't be recalled once an app holds it: a session-derived one is capped at 10 minutes
    const est = await post("/v1/sso/token", { headers: tok, body: { aud, ttl: 604800 } });
    assert.equal(est.status, 200, JSON.stringify(est.body));
    assert.equal(est.body.exp - est.body.iat, 600);
    // a session token can't widen the account it stands for
    const link = await post("/v1/account/link/siwe", { headers: tok, body: {} });
    assert.equal(link.status, 403);
    // sign-out: the account token is dead at once, and so is minting
    await session.terminate();
    assert.equal((await post("/v1/sso/token", { headers: tok, body: { aud } })).status, 401);
  } finally { srv.close(); }
});

test("keeper closes expired sessions and refunds the owner", { skip }, async () => {
  const { session, vault, sid } = await openFor("staging-publish", { apps: ["k-staging"], budget: parseUnits("3", 6), expiresIn: 600 });
  await svc.indexOnce();
  const before = await usdcBal(owner.address);
  await chain.warp(700);
  assert.equal((await session.status()).live, false);
  await svc.keeperOnce();
  const after = await usdcBal(owner.address);
  if (process.env.SESSIONS_TEST_LOG) console.log("keeper refund", before, after, after - before);
  assert.ok(after >= before + parseUnits("3", 6) - 100_000n, "refund landed, minus at most the close fee ($0.10 cap)");
  assert.ok(after > before, "something was refunded");
  const st = await sdk.readSession(chain.pc, vault, sid);
  assert.equal(st.state, 2);
});
