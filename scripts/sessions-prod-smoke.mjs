#!/usr/bin/env node
// Wallet sessions: ONE-SHOT production smoke test, run once right after the
// production relay goes live (docs/design/sessions.md §5, §6, §15).
//
//   node scripts/sessions-prod-smoke.mjs --relay https://api.enclave.host
//   node scripts/sessions-prod-smoke.mjs --relay https://api.enclave.host --rpc https://base-rpc.publicnode.com --chain-id 8453 \
//        [--factory 0x..] [--usdc 0x..] [--expires-in 900]
//
// What it does, on the chain the relay serves:
//   - makes a THROWAWAY owner wallet (never printed, never written anywhere) and a
//     non-extractable P-256 session key, and opens a ZERO-budget "browser" session
//     through the relay (gasless: the relayer pays; this also creates the owner's vault);
//   - checks the relay and the chain agree it is live with balance 0, signs in with it
//     (account token + a short SSO est1), proves a spend and an out-of-scope action are
//     refused in quote/simulation with nothing sent, signs it out, and proves the
//     sign-in, the account token and the session are dead afterwards.
// Money: the owner never holds or signs for any; the relayer pays gas for exactly two
// transactions (open, end). A refused probe that the relay SENT anyway is a FAIL.
// Nothing secret is printed: tokens show as lengths and claims only.
//
// Imports: viem from the repo's node_modules; the sessions SDK from SESSIONS_SDK, default
// sdk/sessions/dist (build it first). Validated against a local relay + anvil harness in
// which each deliberately broken relay behaviour fails exactly the check that covers it.
// Exit 0 = every check passed; 1 = a check failed or was skipped; 2 = bad usage.

import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createPublicClient, http, getAddress, isAddress, keccak256, recoverMessageAddress, formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const sdk = await import(process.env.SESSIONS_SDK ? pathToFileURL(path.resolve(process.env.SESSIONS_SDK)).href
  : new URL("../sdk/sessions/dist/node.mjs", import.meta.url).href);

// ---- arguments ----------------------------------------------------------------------

const USAGE = `usage: node prod-smoke.mjs --relay <https://api.enclave.host> [--rpc <url>] [--chain-id <n>]
                          [--factory <addr>] [--usdc <addr>] [--expires-in <seconds>]
defaults: --rpc https://base-rpc.publicnode.com --chain-id 8453 --expires-in 900
--factory/--usdc: what you EXPECT; else read from GET <relay>/v1/sessions/config (usdc: else the SDK's known one)`;
let a;
try {
  ({ values: a } = parseArgs({ options: {
    relay: { type: "string" }, rpc: { type: "string", default: "https://base-rpc.publicnode.com" },
    "chain-id": { type: "string", default: "8453" }, factory: { type: "string" }, usdc: { type: "string" },
    "expires-in": { type: "string", default: "900" }, help: { type: "boolean", short: "h" },
  } }));
} catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
if (a.help) { console.log(USAGE); process.exit(0); }
const bad = (m) => { console.error(`${m}\n${USAGE}`); process.exit(2); };
if (!a.relay || !/^https?:\/\/[^/]+$/.test(a.relay.replace(/\/+$/, ""))) bad("--relay must be a base URL like https://api.enclave.host");
const RELAY = a.relay.replace(/\/+$/, "");
const CHAIN_ID = Number(a["chain-id"]);
if (!Number.isSafeInteger(CHAIN_ID) || CHAIN_ID <= 0) bad("--chain-id must be a positive integer");
const EXPIRES_IN = Number(a["expires-in"]);
if (!Number.isInteger(EXPIRES_IN) || EXPIRES_IN < 660 || EXPIRES_IN > 3600)
  bad("--expires-in must be 660..3600 s (above 600, so the SSO cap - not the session's end - is what bounds the est1)");
for (const k of ["factory", "usdc"]) if (a[k] && !isAddress(a[k])) bad(`--${k} must be an address`);

// ---- output (never a secret) ---------------------------------------------------------

const SECRETS = [];                                   // exact strings that must never reach stdout
function redact(s) {
  let t = String(s);
  for (const x of SECRETS) if (x) t = t.split(x).join("<redacted>");
  return t.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>")
    .replace(/EST1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<est1>")
    .replace(/EnclaveSession v1 [^\s"']+/g, "<session-auth>")
    .replace(/Bearer\s+[^\s"']+/g, "Bearer <token>");
}
const out = (s) => console.log(redact(s));
const results = [];
const short = (h) => (typeof h === "string" && h.length > 14 ? `${h.slice(0, 10)}…` : String(h));
const usd = (v6) => `$${(Number(v6) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0")}`;
const now = () => Math.floor(Date.now() / 1000);

function record(status, name, ms, detail) {
  results.push({ name, status });
  out(`${status.padEnd(4)} ${name.padEnd(20)} ${(ms / 1000).toFixed(1).padStart(5)}s  ${detail}`);
}
async function check(name, fn) {
  const t0 = Date.now();
  try { const d = await fn(); record("PASS", name, Date.now() - t0, d ?? ""); return true; }
  catch (e) { record("FAIL", name, Date.now() - t0, e?.message ?? String(e)); return false; }
}
const skip = (name, why) => record("SKIP", name, 0, why);
function must(cond, msg) { if (!cond) throw new Error(msg); }

// ---- clients ------------------------------------------------------------------------

// cacheTime 0: viem otherwise caches the block number for 4 s, and the "relayer sent nothing" scan
// (before-head .. after-head) would then cover no block at all
const pc = createPublicClient({ cacheTime: 0, pollingInterval: 1_000,
  transport: http(a.rpc, { retryCount: 3, retryDelay: 500, timeout: 30_000 }) });
const requested = [];                                 // every relay call the SDK makes, in order
const relayFetch = (url, init = {}) => {
  requested.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
  return fetch(url, { ...init, signal: AbortSignal.timeout(180_000) });
};
const relay = new sdk.RelayClient(RELAY, relayFetch);

async function api(method, p, { headers = {}, body } = {}) {
  const r = await fetch(RELAY + p, { method, signal: AbortSignal.timeout(30_000),
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, body: json };
}
const why = (r) => `HTTP ${r.status} ${r.body?.code ?? r.body?.error ?? ""} ${r.body?.message ?? (typeof r.body?.error === "string" && r.body?.code ? r.body.error : "")}`.trim();
const claimsOf = (jwt) => JSON.parse(Buffer.from(String(jwt).split(".")[1] ?? "", "base64url").toString("utf8"));

/** chain reads at (or after) a block the relay's receipt named: a lagging RPC backend errors, never answers stale */
async function retry(fn, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
}
const at = (blockNumber) => ({ readContract: (p) => pc.readContract({ ...p, blockNumber }) });
const ZERO32 = "0x" + "00".repeat(32);
const USDC_BALANCE = [{ type: "function", name: "balanceOf", stateMutability: "view",
  inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

// ---- the run ------------------------------------------------------------------------

const ownerKey = generatePrivateKey();               // throwaway: memory only
SECRETS.push(ownerKey, ownerKey.slice(2));
const owner = privateKeyToAccount(ownerKey);
const ownerSigner = { address: owner.address, signTypedData: (td) => owner.signTypedData(td) };

const ctx = {};                                       // what each step hands the next
const gasTxs = [];                                    // relayer-paid receipts we know of

out(`sessions prod smoke  relay ${RELAY}  rpc ${a.rpc}  chain ${CHAIN_ID}  ${new Date().toISOString()}`);
out(`throwaway owner ${owner.address} (key in memory only)`);

async function main() {
  // 1. the relay's sessions surface answers, on the chain we expect, with a factory that exists
  const cfgOk = await check("config", async () => {
    const c = await relay.config();
    const rpcChain = await pc.getChainId();
    must(Number(c.chainId) === CHAIN_ID, `relay serves chain ${c.chainId}, expected ${CHAIN_ID}`);
    must(rpcChain === CHAIN_ID, `--rpc is chain ${rpcChain}, expected ${CHAIN_ID}`);
    must(isAddress(c.factory ?? ""), `relay names no factory (${c.factory})`);
    must(isAddress(c.relayer ?? ""), `relay names no relayer (${c.relayer})`);
    if (a.factory) must(getAddress(a.factory) === getAddress(c.factory), `relay uses factory ${c.factory}, --factory says ${a.factory}`);
    const known = Object.values(sdk.NETWORKS).find((n) => n.chainId === CHAIN_ID)?.usdc;
    if (a.usdc && c.usdc) must(getAddress(a.usdc) === getAddress(c.usdc), `relay names USDC ${c.usdc}, --usdc says ${a.usdc}`);
    ctx.usdcExpected = a.usdc ?? c.usdc ?? known ?? null;
    ctx.factory = getAddress(c.factory);
    ctx.relayer = getAddress(c.relayer);
    const code = await pc.getCode({ address: ctx.factory });
    must(code && code.length > 2, `factory ${ctx.factory} has no code on chain ${CHAIN_ID} (wrong --rpc?)`);
    const bal = await pc.getBalance({ address: ctx.relayer });
    ctx.relayerWei0 = bal;
    const low = bal < 2_000_000_000_000_000n ? " (LOW: under the relay's 0.002 ETH alert line)" : "";
    return `chain ${CHAIN_ID}, factory ${ctx.factory}, relayer ${ctx.relayer} ${formatEther(bal)} ETH${low}, ` +
      `usdc ${c.usdc ?? `null (expecting ${ctx.usdcExpected ?? "unknown"})`}`;
  });
  if (!cfgOk) return;

  // 2. open a zero-budget browser session; the relayer pays and creates the vault
  const opened = await check("open", async () => {
    const store = new sdk.MemoryStore();
    const label = `prod smoke ${new Date().toISOString().slice(0, 16)}Z`;
    const { record: rec, signer } = await sdk.newSessionKey(store, { relay: RELAY, chainId: CHAIN_ID, label, extractable: false });
    const grant = sdk.buildGrant({ sessionKey: signer.keyHash, label, preset: "browser", signWithin: 600,
      policy: { budget: 0n, expiresIn: EXPIRES_IN } });
    must(grant.budget === 0n, "the grant is not zero-budget");
    const vault = getAddress(await sdk.vaultAddress(pc, ctx.factory, owner.address));
    const before = await pc.getCode({ address: vault });
    must(!before || before.length <= 2, `the throwaway owner's vault ${vault} already has code`);
    const expectSid = sdk.sessionIdOf(vault, grant.sessionKey, grant.grantNonce);
    let res;
    try { res = await sdk.openSession({ relay, owner: ownerSigner, chainId: CHAIN_ID, vault, grant }); }
    catch (e) { throw new Error(`open refused: ${e.code ?? ""} ${e.message}`); }
    must(String(res.sid).toLowerCase() === expectSid.toLowerCase(), `relay reported sid ${res.sid}, expected ${expectSid}`);
    must(getAddress(res.vault) === vault, `relay reported vault ${res.vault}, expected ${vault}`);
    const done = await sdk.completeSession(store, rec, { vault, owner: owner.address, grant, rpc: a.rpc });
    Object.assign(ctx, { vault, sid: expectSid, grant, signer, label, opened: true,
      session: await sdk.sessionFromRecord(done, { fetch: relayFetch }) });
    const rc = await pc.waitForTransactionReceipt({ hash: res.txHash, timeout: 120_000 });
    gasTxs.push(["open", rc]);
    ctx.openBlock = rc.blockNumber;
    must(rc.status === "success", `open tx ${res.txHash} reverted`);
    const after = await retry(() => pc.getCode({ address: vault, blockNumber: rc.blockNumber }));
    must(after && after.length > 2, `vault ${vault} has no code after the open`);
    return `sid ${short(expectSid)} as expected, vault ${vault} created, tx ${res.txHash} (block ${rc.blockNumber}, ${rc.gasUsed} gas)`;
  });
  if (!opened) return;
  const { vault, sid, session, grant } = ctx;

  // 3. the relay says live
  await check("relay-session-live", async () => {
    const r = await relay.request("GET", `/session/${vault}/${sid}`);
    must(r.state?.live === true, `relay says live=${r.state?.live}`);
    must(r.revoked === false, `relay says revoked=${r.revoked}`);
    must(String(r.state.keyHash).toLowerCase() === grant.sessionKey.toLowerCase(), "relay's keyHash is not this key's");
    must(r.index && String(r.index.keyHash).toLowerCase() === grant.sessionKey.toLowerCase(), "the relay's index has no record of the open");
    return `live, not revoked, indexed (label "${r.index.label}", expires +${Number(r.index.expiresAt) - now()}s)`;
  });

  // 4. the chain (our own RPC, not the relay's word) says live with balance 0, as granted
  await check("chain-session-live", async () => {
    const s = await retry(() => sdk.readSession(at(ctx.openBlock), vault, sid));
    must(s.live === true && Number(s.state) === 1, `on chain: live=${s.live} state=${s.state}`);
    must(s.balance6 === 0n && s.spent6 === 0n, `on chain: balance ${s.balance6}, spent ${s.spent6}`);
    must(s.keyHash.toLowerCase() === grant.sessionKey.toLowerCase(), "on-chain keyHash is not this key's");
    must(s.expiresAt === grant.expiresAt, `on-chain expiry ${s.expiresAt} != granted ${grant.expiresAt}`);
    must(((s.actions >> 134n) & 1n) === 1n, "the on-chain mask lacks api.account (bit 134)");
    must(((s.actions >> 8n) & 1n) === 0n, "the on-chain mask HAS app.publish (bit 8): not the browser preset");
    const vUsdc = getAddress(await retry(() => pc.readContract({ address: vault, abi: sdk.sessionVaultAbi, functionName: "usdc", blockNumber: ctx.openBlock })));
    if (ctx.usdcExpected) must(vUsdc === getAddress(ctx.usdcExpected), `the vault's USDC is ${vUsdc}, expected ${ctx.usdcExpected}`);
    ctx.usdc = vUsdc;
    return `live, balance 0, spent 0, mask has api.account and not app.publish, expires ${s.expiresAt}, vault USDC ${vUsdc}`;
  });

  // 5. sign in with the session key: an account token bound to this sid
  const loginUrl = `${RELAY}/v1/account/session-login`;
  const loggedIn = await check("session-login", async () => {
    const r = await api("POST", "/v1/account/session-login", { headers: { Authorization: await session.apiAuthorization("POST", loginUrl, "") } });
    must(r.status === 200, `refused: ${why(r)}`);
    const t = r.body.token;
    must(typeof t === "string" && t.split(".").length === 3, "no account token in the answer");
    SECRETS.push(t);
    const c = claimsOf(t);
    must(String(r.body.sid).toLowerCase() === sid.toLowerCase() && String(c.sid).toLowerCase() === sid.toLowerCase(),
      `token bound to sid ${short(c.sid)} (answer says ${short(r.body.sid)}), expected ${short(sid)}`);
    must(getAddress(r.body.vault) === vault && getAddress(c.vault) === vault, `token bound to vault ${c.vault}, expected ${vault}`);
    must(getAddress(r.body.address) === owner.address, `account address ${r.body.address} is not the owner's`);
    must(c.amr === "session", `amr ${c.amr}, expected "session"`);
    must(Number(c.exp) <= Number(grant.expiresAt), `token exp ${c.exp} outlives the session (${grant.expiresAt})`);
    Object.assign(ctx, { token: t, tokenClaims: c, accountId: r.body.accountId });
    return `account ${r.body.accountId}, token ${t.length} chars, claims {amr:${c.amr}, sid:${short(c.sid)}, ` +
      `vault:${short(c.vault)}, exp:+${c.exp - now()}s (session +${Number(grant.expiresAt) - now()}s)}`;
  });

  if (loggedIn) {
    const bearer = () => ({ Authorization: `Bearer ${ctx.token}` });
    // 6. the token works as the owner's account
    await check("account-token", async () => {
      const r = await api("GET", "/v1/account/me", { headers: bearer() });
      must(r.status === 200, `GET /v1/account/me refused: ${why(r)}`);
      must(r.body.accountId === ctx.accountId, `/me is account ${r.body.accountId}, expected ${ctx.accountId}`);
      must(r.body.amr === "session", `/me amr ${r.body.amr}`);
      must((r.body.wallets ?? []).includes(owner.address.toLowerCase()), "/me does not list the owner's wallet");
      return `GET /v1/account/me 200 as ${r.body.accountId} (amr session, owner wallet linked)`;
    });
    // 7. it cannot change the account (a session must not plant credentials that outlive it)
    await check("token-no-acct-change", async () => {
      const r = await api("POST", "/v1/account/link/siwe", { headers: bearer(), body: {} });
      must(r.status === 403 && r.body.error === "session_token", `link/siwe with a session token: ${why(r)}, expected 403 session_token`);
      return "POST /v1/account/link/siwe 403 session_token";
    });
    // 8. SSO est1 from it: capped at 600 s, signed by the published signer
    await check("sso-token", async () => {
      const asked = 604800;
      const r = await api("POST", "/v1/sso/token", { headers: bearer(), body: { aud: ZERO32, ttl: asked } });
      must(r.status === 200, `refused: ${why(r)}`);
      const t = r.body.token;
      must(typeof t === "string" && /^EST1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t), "no EST1 token in the answer");
      SECRETS.push(t);
      const [, p64, s64] = t.split(".");
      const c = JSON.parse(Buffer.from(p64, "base64url").toString("utf8"));
      const ttl = c.exp - c.iat;
      must(c.sub === ctx.accountId && r.body.sub === ctx.accountId, `est1 sub ${c.sub}, expected ${ctx.accountId}`);
      must(c.aud === ZERO32, `est1 aud ${c.aud}`);
      must(c.exp === r.body.exp && c.iat === r.body.iat, "the answer's iat/exp differ from the token's");
      must(ttl > 0 && ttl <= 600, `est1 lives ${ttl} s (asked ${asked}); a session-derived one must be <= 600`);
      must(c.exp <= ctx.tokenClaims.exp, `est1 exp ${c.exp} outlives the account token (${ctx.tokenClaims.exp})`);
      const sig = `0x${Buffer.from(s64, "base64url").toString("hex")}`;
      const by = await recoverMessageAddress({ message: `EST1.${p64}`, signature: sig });
      must(getAddress(by) === getAddress(r.body.signer), `est1 recovers to ${by}, answer says signer ${r.body.signer}`);
      const pin = await api("GET", "/v1/sso/signer");
      must(pin.status === 200 && getAddress(pin.body.signer) === getAddress(by), `est1 signer ${by} != published /v1/sso/signer ${pin.body.signer}`);
      return `EST1 ${t.length} chars, exp-iat ${ttl}s (asked ${asked}), sub ${c.sub}, aud zero id, signed by ${by} (= /v1/sso/signer)`;
    });
  } else {
    for (const n of ["account-token", "token-no-acct-change", "sso-token"]) skip(n, "no account token (session-login failed)");
  }

  // 9-11. refusals that must happen BEFORE any chain spend. Precondition, checked first:
  // nothing to spend exists (session balance 0, vault holds 0 USDC); the probes name the zero app id.
  const pre = async () => {
    const s = await sdk.readSession(pc, vault, sid);
    must(s.live && s.balance6 === 0n, `precondition: session live=${s.live} balance=${s.balance6}; NOT probing`);
    const vb = await pc.readContract({ address: ctx.usdc ?? ctx.usdcExpected, abi: USDC_BALANCE, functionName: "balanceOf", args: [vault] });
    must(vb === 0n, `precondition: the vault holds ${vb} USDC units; NOT probing`);
  };
  const createArgs = { appRef: `catalog://${ZERO32}/0`, gpuMilli: 0, cpuMilli: 1000, appPort: 8080, ports: "",
    isPublic: false, configCid: "", maxRate6: 1000n, env: "staging", fund6: 1_000_000n };
  /** quote, sign and submit one SessionCall straight to /execute (no SDK pre-checks); returns the error or the success */
  async function rawExecute(action, args) {
    const data = sdk.encodeArgs(action, args);
    const n = sdk.ACTIONS[action];
    const q = await relay.request("POST", "/quote", { vault, sid, action: n, args: data });
    const digest = sdk.digestOf(CHAIN_ID, vault, "SessionCall", { sessionId: sid, nonce: q.nonce, action: n,
      argsHash: keccak256(data), fee: q.fee, deadline: q.deadline });
    const { r, s } = await session.signer.signDigest(digest);
    const nonce0 = await pc.getTransactionCount({ address: ctx.relayer });
    const head0 = await pc.getBlockNumber({ cacheTime: 0 });
    let err = null, okRes = null;
    try {
      okRes = await relay.request("POST", "/execute", { vault, sid, nonce: q.nonce, action: n, args: data, fee: q.fee,
        deadline: q.deadline, x: session.signer.x, y: session.signer.y, r, s });
    } catch (e) { err = e; }
    return { q, err, okRes, nonce0, head0 };
  }
  /** the relayer sent nothing to this vault: its nonce did not move, or (shared relayer, other traffic) none of the
   *  blocks since holds a relayer tx to the vault */
  async function sentNothing(nonce0, head0) {
    const nonce1 = await pc.getTransactionCount({ address: ctx.relayer });
    if (nonce1 === nonce0) return `relayer nonce ${nonce0} unchanged`;
    // scan up to a head whose own nonce already shows the move (a load-balanced RPC's backends can disagree)
    let head;
    for (let i = 0; ; i++) {
      head = await pc.getBlockNumber({ cacheTime: 0 });
      if (await pc.getTransactionCount({ address: ctx.relayer, blockNumber: head }) >= nonce1) break;
      must(i < 10, `relayer nonce ${nonce0}->${nonce1}, but --rpc's blocks never showed it; could not rule out a send`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    for (let b = head0 + 1n; b <= head; b++) {
      const blk = await retry(() => pc.getBlock({ blockNumber: b, includeTransactions: true }));
      for (const tx of blk.transactions)
        if (tx.from?.toLowerCase() === ctx.relayer.toLowerCase() && tx.to?.toLowerCase() === vault.toLowerCase())
          throw new Error(`the relayer SENT ${tx.hash} to the vault (block ${b})`);
    }
    return `relayer nonce ${nonce0}->${nonce1} (other traffic), none of its txs in blocks ${head0 + 1n}-${head} touch this vault`;
  }

  await check("create-budget-sdk", async () => {
    await pre();
    const from = requested.length;
    let e = null;
    try { await session.call("deploy.create", createArgs); } catch (x) { e = x; }
    const calls = requested.slice(from);
    must(e, `NOT REFUSED: deploy.create with fund6 ${createArgs.fund6} on a zero budget went through (${calls.join(", ")})`);
    must(e.code === "budget", `refused with "${e.code}": ${e.message}, expected "budget"`);
    must(calls.includes("POST /v1/sessions/quote"), `the SDK never quoted (${calls.join(", ") || "no relay calls"})`);
    must(!calls.includes("POST /v1/sessions/execute"), "the SDK reached /execute: not a quote-time refusal");
    const fee = BigInt(e.detail?.need ?? 0n) - createArgs.fund6;
    ctx.feeCreate = fee;
    return `refused "budget" at quote time (${e.message}; fee quoted ${usd(fee)}), never reached /execute`;
  });

  await check("create-budget-relay", async () => {
    await pre();
    const { q, err, okRes, nonce0, head0 } = await rawExecute("deploy.create", createArgs);
    const problems = [];
    if (!err) problems.push(`NOT REFUSED: the relay submitted ${okRes?.txHash}`);
    else if (err.code !== "budget") problems.push(`refused with "${err.code}": ${err.message}, expected "budget"`);
    else if (err.detail?.error !== "BudgetExceeded") problems.push(`"budget" without the vault's BudgetExceeded revert (${err.message})`);
    let sent = "";
    try { sent = await sentNothing(nonce0, head0); } catch (e) { problems.push(e.message); }
    must(!problems.length, problems.join("; "));
    return `relay simulation refused: vault ${err.message} (fee quoted ${usd(q.fee)}); ${sent}`;
  });

  await check("scope-refused", async () => {
    await pre();
    must(!grant.actions.includes("app.publish"), "the browser grant names app.publish");
    const { err, okRes, nonce0, head0 } = await rawExecute("app.publish", { slug: "smoke-never", name: "", description: "",
      version: "0", cid: "", res: [0, 0, 0, 0], ports: "", config: "", configCid: "" });
    const problems = [];
    if (!err) problems.push(`NOT REFUSED: the relay submitted ${okRes?.txHash}`);
    else if (err.code !== "not_allowed" || err.detail?.error !== "NotAllowed")
      problems.push(`refused with "${err.code}": ${err.message}, expected "not_allowed" (NotAllowed(8))`);
    let sent = "";
    try { sent = await sentNothing(nonce0, head0); } catch (e) { problems.push(e.message); }
    must(!problems.length, problems.join("; "));
    return `app.publish (not in the browser grant) refused in simulation: ${err.message}; ${sent}`;
  });

  // 12. sign-out by the session key itself
  const ended = await check("terminate", async () => {
    const r = await session.terminate();
    must(/^0x[0-9a-fA-F]{64}$/.test(String(r.txHash)), "no transaction hash in the answer");
    ctx.terminated = true;
    const rc = await pc.waitForTransactionReceipt({ hash: r.txHash, timeout: 120_000 });
    gasTxs.push(["end", rc]);
    ctx.endBlock = rc.blockNumber;
    must(rc.status === "success", `end tx ${r.txHash} reverted`);
    must(BigInt(r.refund6 ?? 0n) === 0n, `refund ${r.refund6} from a zero-budget session`);
    return `POST /end tx ${r.txHash} (block ${rc.blockNumber}, ${rc.gasUsed} gas), refund 0`;
  });
  if (!ended) {
    for (const n of ["login-after-end", "token-after-end", "session-ended"]) skip(n, "the session did not end");
    return;
  }

  // 13. the key can no longer sign in
  await check("login-after-end", async () => {
    const r = await api("POST", "/v1/account/session-login", { headers: { Authorization: await session.apiAuthorization("POST", loginUrl, "") } });
    must(r.status === 401, `session-login after sign-out: ${why(r)}, expected 401`);
    return `session-login ${why(r)}`;
  });

  // 14. the account token minted from it is dead, and cannot mint
  if (loggedIn) {
    await check("token-after-end", async () => {
      const bearer = { Authorization: `Bearer ${ctx.token}` };
      const me = await api("GET", "/v1/account/me", { headers: bearer });
      const mint = await api("POST", "/v1/sso/token", { headers: bearer, body: { aud: ZERO32 } });
      must(me.status === 401 && mint.status === 401, `old token after sign-out: /me ${why(me)}, /sso/token ${why(mint)}; expected 401 and 401`);
      return `old account token: GET /v1/account/me 401, POST /v1/sso/token 401`;
    });
  } else skip("token-after-end", "no account token (session-login failed)");

  // 15. ended, on the relay and on chain
  await check("session-ended", async () => {
    const r = await relay.request("GET", `/session/${vault}/${sid}`);
    must(r.state?.live === false && Number(r.state?.state) === 2, `relay says live=${r.state?.live} state=${r.state?.state}`);
    must(r.revoked === true, `relay says revoked=${r.revoked}`);
    must(r.index?.ended === true, `the relay's index does not record the end (${JSON.stringify(r.index?.ended)})`);
    const s = await retry(() => sdk.readSession(at(ctx.endBlock), vault, sid));
    must(s.live === false && Number(s.state) === 2 && s.balance6 === 0n, `on chain: live=${s.live} state=${s.state} balance=${s.balance6}`);
    return `relay: ended (reason ${r.index.reason}), revoked; chain: state 2 (ended), balance 0`;
  });
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; out(`CRASH ${e?.stack ?? e}`); }

// never leave a live session behind (it holds nothing and expires on its own, but say so)
if (ctx.opened && !ctx.terminated) {
  try {
    const r = await ctx.session.terminate();
    out(`cleanup: signed the session out (tx ${r.txHash})`);
    try { gasTxs.push(["end (cleanup)", await pc.waitForTransactionReceipt({ hash: r.txHash, timeout: 120_000 })]); } catch {}
  } catch (e) { out(`cleanup: could not sign out (${e.code ?? ""} ${e.message}); it expires on its own at ${ctx.grant?.expiresAt}`); }
}

// relayer cost of this run: the receipts of the transactions it paid for us
if (gasTxs.length) {
  let gas = 0n, wei = 0n, l1 = 0n;
  for (const [, rc] of gasTxs) {
    gas += rc.gasUsed;
    wei += rc.gasUsed * (rc.effectiveGasPrice ?? 0n);
    if (rc.l1Fee != null) l1 += BigInt(rc.l1Fee);  // OP-stack (Base) receipts carry the L1 data fee
  }
  out(`relayer gas: ${gasTxs.map(([n, rc]) => `${n} ${rc.gasUsed}`).join(" + ")} = ${gas} gas, ` +
    `${formatEther(wei + l1)} ETH (L2 ${formatEther(wei)} + L1 data ${formatEther(l1)})`);
}
if (ctx.vault) out(`left on chain: vault ${ctx.vault} (empty), session ${ctx.sid ?? "-"} (${ctx.terminated ? "ended" : "NOT ended"})`);

const failed = results.filter((r) => r.status !== "PASS");
const passed = results.length - failed.length;
if (!crashed && !failed.length && results.length) out(`RESULT PASS ${passed}/${results.length}`);
else out(`RESULT FAIL ${passed}/${results.length} passed${failed.length ? `; not passed: ${failed.map((r) => r.name).join(", ")}` : ""}${crashed ? "; crashed" : ""}`);
process.exit(!crashed && !failed.length && results.length ? 0 : 1);
