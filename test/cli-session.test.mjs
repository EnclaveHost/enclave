// `enclave session …` and the session-aware commands, end to end: the REAL CLI
// (cli/enclave.mjs, run as a child process with NO wallet key) against the REAL
// sessions relayer (relay/sessions.mjs) over HTTP, submitting to the REAL
// SessionVault, ledger and catalog on anvil (test/helpers/sessions-chain.mjs).
// The owner's signature is made here with the SDK, as the grant page would.
// Skips when Foundry (anvil/forge) is absent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http as viemHttp, parseUnits } from "viem";
import { foundry } from "viem/chains";
import { haveFoundry, startChain, deployPlatform, KEYS } from "./helpers/sessions-chain.mjs";
import { createSessionsService } from "../relay/sessions.mjs";
import { JsonStore } from "../relay/store.js";
import * as sdk from "../sdk/sessions/dist/node.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// ENCLAVE_CLI_BIN runs the same flow against a bundle (node cli/build.mjs <out>)
const CLI = process.env.ENCLAVE_CLI_BIN || path.join(REPO, "cli", "enclave.mjs");
const skip = !haveFoundry() || !fs.existsSync(path.join(REPO, "sdk/sessions/dist/node.mjs"))
  ? "needs Foundry (anvil + forge) and a built SDK (cd sdk/sessions && npm run build)" : false;

let chain, P, svc, server, relayUrl, tmp, stores = [];
const hits = [];          // every non-sessions path the CLI asked the stub API for
const pins = [];          // { hash, owner } per pinned upload
const owner = privateKeyToAccount(KEYS.owner);
const ownerSigner = { address: owner.address, signTypedData: (td) => owner.signTypedData(td) };

const json = (res, code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });

before(async () => {
  if (skip) return;
  chain = await startChain();
  P = await deployPlatform(chain);
  // outside any git working tree: FileStore refuses to keep keys inside one
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-session-"));
  const relayer = privateKeyToAccount(KEYS.relayer);
  svc = createSessionsService({
    pc: chain.pc, wc: createWalletClient({ chain: foundry, account: relayer, transport: viemHttp(chain.rpc) }),
    account: relayer, chainId: 31337, factory: P.factory, book: P.book, usdc: P.usdc, router: P.router,
    startBlock: P.deployBlock, ethUsd: 3000, minFee6: 500, now: chain.now,
    feesPerGas: async () => ({ maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    store: (stores[0] = new JsonStore(path.join(tmp, "idx.json"), {})),
    journal: (stores[1] = new JsonStore(path.join(tmp, "j.json"), { txs: [] }, { durable: true })),
    log: (...a) => { if (process.env.SESSIONS_TEST_LOG) console.log("[relay]", ...a); },
  });
  // The sessions surface is the real service. Around it, the few platform API
  // routes the CLI reads: fleet availability (a fleet that serves dev-mode and
  // config overrides, posting $1/h per node), the claim hint, and the upload
  // token route, which verifies the session-signed header with the relay's own
  // verifier exactly as relay/api-relay.js does, then a pin gateway that checks it.
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://relay.test");
    if (u.pathname.startsWith("/v1/sessions")) return svc.handle(req, res, u, null);
    hits.push(`${req.method} ${u.pathname}`);
    if (u.pathname === "/availability")
      return json(res, 200, { aggregate: true, devDeploy: true, configOverride: true, configCidOverride: true, configEdit: true,
        shareResize: true, cheapestCpuPricePerSec6: 278, cheapestGpuPricePerSec6: 0 });
    if (u.pathname === "/v1/claim-hint" && req.method === "POST") return json(res, 200, { accepted: true });
    if (u.pathname === "/v1/apps/upload-token" && req.method === "POST") {
      const raw = await body(req);
      try {
        const v = await svc.verifyApiRequest({ header: req.headers.authorization, method: req.method,
          hostPath: req.headers.host + u.pathname + u.search, body: raw, scope: "api.upload", fresh: true });
        const b = JSON.parse(raw.toString());
        return json(res, 200, { token: `tok:${b.hash}:${v.owner.toLowerCase()}`, address: v.owner.toLowerCase(), expiry: b.expiry });
      } catch (e) { return json(res, e.status || 401, { error: e.code || "unauthorized", message: e.message }); }
    }
    if ((u.pathname === "/add-wasm" || u.pathname === "/add-json") && req.method === "POST") {
      const raw = await body(req);
      const hash = createHash("sha256").update(raw).digest("hex");
      if (req.headers["x-upload-token"] !== `tok:${hash}:${req.headers["x-upload-address"]}`)
        return json(res, 401, { error: "bad upload token" });
      pins.push({ hash, owner: req.headers["x-upload-address"] });
      return json(res, 200, { cid: `bafy${hash.slice(0, 52)}` });
    }
    return json(res, 404, { error: "not_found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  relayUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const st of stores) clearInterval(st._timer);
  server?.close(); chain?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// The CLI with no wallet key anywhere: HOME/XDG point at an empty temp dir and
// ENCLAVE_KEY is unset, so any wallet fallback would fail loudly.
function cli(args, { env = {}, dir } = {}) {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
             ENCLAVE_API_BASE: relayUrl, ENCLAVE_RPC: chain.rpc, ENCLAVE_ADDRESS_BOOK: P.book,
             ENCLAVE_SESSION_DIR: dir ?? path.join(tmp, "sessions"),
             ENCLAVE_IPFS_UPLOAD: `${relayUrl}/add-wasm`, ENCLAVE_IPFS_JSON_UPLOAD: `${relayUrl}/add-json`, ...env },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => out += d); p.stderr.on("data", (d) => err += d);
    p.stdin.end();
    p.on("close", (code) => {
      if (process.env.SESSIONS_TEST_LOG) console.log(`$ enclave ${args.join(" ")}\n${out}${err}`);
      resolve({ code, out, err });
    });
  });
}
const ok = (r, what) => assert.equal(r.code, 0, `${what} failed:\n${r.out}\n${r.err}`);

// what the owner's grant page does with the link: decode the fragment, sign, submit
async function ownerSigns(text) {
  const frag = /\/grant#([A-Za-z0-9_-]+)/.exec(text);
  assert.ok(frag, `no grant link in:\n${text}`);
  const req = sdk.decodeGrantRequest(frag[1]);
  const vault = await sdk.vaultAddress(chain.pc, P.factory, owner.address);
  const usdc = req.grant.budget > 0n ? await sdk.usdcDomain(chain.pc, P.usdc, 31337) : undefined;
  const opened = await sdk.openSession({ relay: new sdk.RelayClient(relayUrl), owner: ownerSigner, chainId: req.chainId,
    vault, grant: req.grant, usdc });
  return { req, vault, sid: opened.sid };
}

const usdcBal = (a) => chain.pc.readContract({ address: P.usdc, abi: P.abi.usdc.abi, functionName: "balanceOf", args: [a] });
const ledgerGet = (id) => chain.pc.readContract({ address: P.ledger, abi: P.abi.ledger.abi, functionName: "get", args: [id] });

test("agent flow: session new -> owner signs the link -> resume-wait -> publish, deploy, manage on staging -> refusals -> terminate", { skip }, async () => {
  const dir = path.join(tmp, "sessions");
  const r1 = await cli(["session", "new", "--preset", "staging-publish", "--app", "mine-staging", "--budget", "5",
    "--label", "CLI agent", "--no-wait"]);
  ok(r1, "session new");
  assert.match(r1.out, /Apps: only mine-staging\./);
  assert.match(r1.out, /Environments: staging\./);
  const pendingId = /resume-wait (pending-[0-9a-f]+)/.exec(r1.out)?.[1];
  assert.ok(pendingId, r1.out);
  assert.ok(fs.existsSync(path.join(dir, `${pendingId}.json`)), "the pending key is on disk");
  assert.equal(fs.statSync(path.join(dir, `${pendingId}.json`)).mode & 0o777, 0o600);

  // the owner opens the link and signs (here: the SDK, as the grant page would)
  const { req, vault, sid } = await ownerSigns(r1.out);
  assert.equal(req.chainId, 31337);
  assert.equal(req.relay, relayUrl);
  assert.deepEqual(req.grant.apps, ["mine-staging"]);
  assert.deepEqual(req.grant.environments, ["staging"]);
  assert.equal(req.grant.budget, parseUnits("5", 6));
  assert.equal(req.grant.label, "CLI agent");
  const code = sdk.checkCode(req.grant.sessionKey);
  assert.ok(r1.out.includes(`check code: ${code}`), "the check code is printed");
  assert.ok(r1.out.includes(req.grant.sessionKey.slice(2, 10)), "and the hex a hardware wallet shows");

  const r2 = await cli(["session", "resume-wait", pendingId]);
  ok(r2, "resume-wait");
  assert.ok(r2.out.includes(`session open: ${sid}`), r2.out);
  assert.ok(r2.out.includes(owner.address));
  assert.ok(fs.existsSync(path.join(dir, `${sid}.json`)), "the open session is stored under its sid");
  assert.ok(!fs.existsSync(path.join(dir, `${pendingId}.json`)), "and the pending record is gone");
  assert.equal(fs.readFileSync(path.join(dir, "active"), "utf8").trim(), sid, "and it is the active session");

  const r3 = await cli(["session", "status"]);
  ok(r3, "status");
  assert.match(r3.out, /state\s+live/);
  assert.match(r3.out, /balance\s+\$5\.00 left, \$0\.00 spent/);
  assert.match(r3.out, /this period\s+\$0\.00 of \$5\.00/);
  assert.match(r3.out, /environments\s+staging/);
  assert.match(r3.out, /apps\s+mine-staging/);
  assert.ok(r3.out.includes(vault) && r3.out.includes(owner.address));

  // publish through the session: the upload token is session-signed, the vault is the publisher
  const wasm = path.join(tmp, "app.wasm");
  fs.writeFileSync(wasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]));
  const r4 = await cli(["publish", wasm, "--slug", "mine-staging", "--version", "0.1.0", "--yes"]);
  ok(r4, "publish");
  assert.match(r4.out, /published mine-staging:0\.1\.0/);
  assert.match(r4.err, /session: acting through/);
  assert.equal(pins.at(-1).owner, owner.address.toLowerCase(), "the pin was authorized for the session's owner");
  const appId = await chain.pc.readContract({ address: P.catalog, abi: P.abi.catalog.abi, functionName: "appIdOf", args: [vault, "mine-staging"] });
  assert.equal(await chain.pc.readContract({ address: P.catalog, abi: P.abi.catalog.abi, functionName: "numVersions", args: [appId] }), 1n);

  // deploy to staging through the session: create + fund in one vault operation
  const r5 = await cli(["deploy", "mine-staging:0.1.0", "--private", "--fund", "1", "--no-wait", "--yes"]);
  ok(r5, "deploy");
  const id = /created (0x[0-9a-f]{64})/.exec(r5.out)?.[1];
  assert.ok(id, r5.out);
  assert.match(r5.out, /\(staging, held by vault/);
  assert.match(r5.out, /funded \$1\.00 out of the session budget/);
  const d = await ledgerGet(id);
  assert.equal(d.owner, vault, "the vault holds the deployment");
  assert.equal(d.appRef, `catalog://${appId}/0`);
  const held = await chain.pc.readContract({ address: vault, abi: sdk.sessionVaultAbi, functionName: "held", args: [id] });
  assert.equal(held[0], 1, "held as staging");

  // fund, config, a new version + upgrade, stop and resume: each one session operation
  const bal0 = (await ledgerGet(id)).balance6;
  ok(await cli(["fund", id, "--usdc", "0.5", "--yes"]), "fund");
  assert.ok((await ledgerGet(id)).balance6 > bal0, "funding landed on the deployment");
  ok(await cli(["config", "set", id, '{"mode":"test"}', "--yes"]), "config set");
  assert.equal((await ledgerGet(id)).configCid, '{"config":{"mode":"test"}}');
  ok(await cli(["publish", wasm, "--slug", "mine-staging", "--version", "0.1.1", "--yes"]), "publish 0.1.1");
  const up = await cli(["upgrade", id, "0.1.1", "--yes"]);
  ok(up, "upgrade");
  assert.match(up.out, /switched to mine-staging:0\.1\.1/);
  assert.equal((await ledgerGet(id)).appRef, `catalog://${appId}/1`);
  const stop = await cli(["stop", id, "--yes"]);
  ok(stop, "stop");
  assert.match(stop.out, /stopped on-chain/);
  assert.equal((await ledgerGet(id)).active, false);
  ok(await cli(["resume", id, "--yes"]), "resume");
  assert.equal((await ledgerGet(id)).active, true);

  // outside the preset: resize is deploy.setShares, which staging-publish does not grant
  const r6 = await cli(["resize", id, "--cpu", "0.5", "--yes"]);
  assert.notEqual(r6.code, 0);
  assert.match(r6.err, /refused deploy\.setShares: not_allowed/);
  assert.match(r6.err, /next: ask the owner for a session with deploy\.setShares/);
  assert.doesNotMatch(r6.err, /no wallet key/, "no wallet fallback was attempted");
  // over budget: the refusal names the top-up command
  const r7 = await cli(["deploy", "mine-staging:0.1.1", "--private", "--fund", "10", "--no-wait", "--yes"]);
  assert.notEqual(r7.code, 0);
  assert.match(r7.err, /refused deploy\.create: budget/);
  assert.match(r7.err, /enclave session top-up-link --amount \d+/);
  // an app the grant does not name
  const r8 = await cli(["deploy", "store:1.0.0", "--fund", "1", "--no-wait", "--yes"]);
  assert.notEqual(r8.code, 0);
  assert.match(r8.err, /refused deploy\.create: app/);
  assert.match(r8.err, /--app store/);

  const link = await cli(["session", "top-up-link", "--amount", "3"]);
  ok(link, "top-up-link");
  assert.ok(link.out.includes(`https://enclave.host/sessions#topup=${vault}:${sid}:3000000`), link.out);
  const ls = await cli(["session", "list"]);
  ok(ls, "list");
  assert.match(ls.out, /\*\s+0x[0-9a-f]{8}…\s+open\s+CLI agent/);

  // the CLI never asked for a wallet login
  assert.ok(!hits.some((h) => /\/v1\/auth\//.test(h)), hits.join("\n"));

  // sign out: the remaining budget returns to the owner, the key file goes
  const left = (await sdk.readSession(chain.pc, vault, sid)).balance6;
  assert.ok(left > 0n && left < parseUnits("5", 6));
  const before = await usdcBal(owner.address);
  const r9 = await cli(["session", "terminate", "--yes"]);
  ok(r9, "terminate");
  assert.ok(r9.out.includes(`refund ${sdk.fmtUsd(left)} to ${owner.address}`), r9.out);
  assert.equal(await usdcBal(owner.address), before + left);
  assert.equal((await sdk.readSession(chain.pc, vault, sid)).live, false);
  assert.ok(!fs.existsSync(path.join(dir, `${sid}.json`)), "the key file is deleted");
  assert.ok(!fs.existsSync(path.join(dir, "active")), "and nothing is active");
  // with nothing active the commands are wallet commands again (and there is no wallet here)
  const r10 = await cli(["fund", id, "--usdc", "1", "--yes"]);
  assert.notEqual(r10.code, 0);
  assert.match(r10.err, /no wallet key/);
});

test("--env: the session as one exported string; status, routing and sign-out work with no key files", { skip }, async () => {
  const dir = path.join(tmp, "env-sessions");
  const r1 = await cli(["session", "new", "--preset", "staging-publish", "--app", "env-staging", "--label", "env agent",
    "--budget", "0", "--env", "--no-wait"], { dir });
  ok(r1, "session new --env");
  assert.equal(r1.out, "", "with --env, stdout carries only the export line");
  const pendingId = /resume-wait (pending-[0-9a-f]+) --env/.exec(r1.err)?.[1];
  assert.ok(pendingId, r1.err);
  const { sid } = await ownerSigns(r1.err);

  const r2 = await cli(["session", "resume-wait", pendingId, "--env"], { dir });
  ok(r2, "resume-wait --env");
  const m = /^export ENCLAVE_SESSION=([A-Za-z0-9_-]+)$/m.exec(r2.out);
  assert.ok(m, r2.out);
  assert.equal(r2.out.trim().split("\n").length, 1, "stdout is exactly the export line");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".json")), [], "no key file is left behind");
  assert.ok(!fs.existsSync(path.join(dir, "active")));

  const empty = path.join(tmp, "nowhere");
  const env = { ENCLAVE_SESSION: m[1] };
  const r3 = await cli(["session", "status"], { env, dir: empty });
  ok(r3, "status from ENCLAVE_SESSION");
  assert.match(r3.out, /state\s+live/);
  assert.match(r3.out, /\(ENCLAVE_SESSION\)/);
  assert.match(r3.out, /label\s+env agent/);
  assert.match(r3.out, /balance\s+\$0\.00 left/);
  const j = JSON.parse((await cli(["session", "status", "--json"], { env, dir: empty })).out);
  assert.equal(j.sid, sid);
  assert.equal(j.live, true);
  assert.deepEqual(j.environments, ["staging"]);

  // the session-aware commands route through it (and refuse what it may not do) ...
  const r4 = await cli(["deploy", "store:1.0.0", "--fund", "1", "--no-wait", "--yes"], { env, dir: empty });
  assert.notEqual(r4.code, 0);
  assert.match(r4.err, /session: acting through/);
  assert.match(r4.err, /refused deploy\.create: app/);
  // ... and --wallet is the explicit way out (no wallet here, so it says so)
  const r5 = await cli(["fund", "0x" + "ab".repeat(32), "--usdc", "1", "--wallet", "--yes"], { env, dir: empty });
  assert.notEqual(r5.code, 0);
  assert.match(r5.err, /no wallet key/);
  assert.doesNotMatch(r5.err, /acting through/);

  const r6 = await cli(["session", "terminate", "--yes"], { env, dir: empty });
  ok(r6, "terminate from ENCLAVE_SESSION");
  assert.match(r6.out, /signed out: refund \$0\.00/);
  assert.match(r6.out, /unset ENCLAVE_SESSION/);
  assert.ok(!fs.existsSync(empty), "nothing was written to disk");
  const r7 = await cli(["session", "status"], { env, dir: empty });
  ok(r7, "status after sign-out");
  assert.match(r7.out, /state\s+ended/);
});

// A JSON-RPC signer in front of anvil, standing in for Frame/Clef behind --signer: anvil holds the owner's dev
// key unlocked, and this answers the CLI's Base chain id (the CLI signs for Base only) and drops it from the
// eth_sendTransaction it forwards, so the real wallet path (sendTx -> eth_sendTransaction) runs end to end.
async function anvilSigner() {
  const srv = http.createServer(async (req, res) => {
    const one = async (m) => {
      if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0x2105" };
      if (m.method === "eth_sendTransaction") m = { ...m, params: [{ ...m.params[0], chainId: undefined }] };
      const r = await fetch(chain.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) });
      return r.json();
    };
    const raw = JSON.parse((await body(req)).toString());
    json(res, 200, Array.isArray(raw) ? await Promise.all(raw.map(one)) : await one(raw));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

test("records the owner's WALLET holds: refused until `session delegate`, then fund/resize/rate-cap/stop/resume/refund through the session; never upgrade/config", { skip }, async () => {
  const dir = path.join(tmp, "wallet-sessions");
  const r1 = await cli(["session", "new", "--preset", "browser", "--budget", "3", "--label", "wallet agent", "--no-wait"], { dir });
  ok(r1, "session new");
  const pendingId = /resume-wait (pending-[0-9a-f]+)/.exec(r1.out)?.[1];
  const { vault } = await ownerSigns(r1.out);
  ok(await cli(["session", "resume-wait", pendingId], { dir }), "resume-wait");
  const as = (args, o = {}) => cli(args, { dir, ...o });

  // the owner's wallet creates a record directly on the ledger: the WALLET holds it, not the vault
  const wallet = chain.wc(KEYS.owner);
  const rc = await chain.pc.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: P.ledger, abi: P.abi.ledger.abi,
    functionName: "create", args: [P.storeRef, 0, 1000, 8080, "", false, "", "0x0000000000000000000000000000000000000000", 0n, 1000n] }) });
  const id = rc.logs.find((l) => l.address.toLowerCase() === P.ledger.toLowerCase()).topics[1];
  assert.equal((await ledgerGet(id)).owner, owner.address);
  const capOf = () => chain.pc.readContract({ address: P.ledger, abi: P.abi.ledger.abi, functionName: "capOf", args: [id] });
  const slot = async () => BigInt(await chain.pc.getStorageAt({ address: P.ledger, slot: sdk.delegateSlot(owner.address, vault) }) || "0x0");

  // not delegated: refused before anything is sent, naming the owner's command
  const r2 = await as(["stop", id, "--yes"]);
  assert.notEqual(r2.code, 0);
  assert.match(r2.err, /refused deploy\.setActive: delegation: .*held by the owner's wallet/);
  assert.match(r2.err, /next: .*the owner runs `enclave session delegate`/);
  assert.equal((await ledgerGet(id)).active, true);
  // --status needs no key: the owner is the active session's
  const s1 = await as(["session", "delegate", "--status"]);
  ok(s1, "delegate --status");
  assert.match(s1.out, new RegExp(`owner\\s+${owner.address}`));
  assert.match(s1.out, new RegExp(`vault\\s+${vault}`));
  assert.match(s1.out, new RegExp(`ledger\\s+${P.ledger}`));
  assert.match(s1.out, /supported\s+yes/);
  assert.match(s1.out, /granted\s+no/);
  assert.match(s1.out, /enclave session delegate$/m);
  // a grant is the owner's wallet transaction: without a wallet there is nothing to sign with
  const r3 = await as(["session", "delegate", "--yes"]);
  assert.notEqual(r3.code, 0);
  assert.match(r3.err, /no wallet key/);

  // the owner grants it with the wallet (here through --signer: the real sendTx path, read back from storage)
  const signer = await anvilSigner();
  try {
    const g = await as(["session", "delegate", "--signer", signer.url, "--from", owner.address, "--yes"]);
    ok(g, "delegate");
    assert.match(g.out, new RegExp(`granted: setDelegate\\(${vault}, true\\) tx 0x[0-9a-f]{64}`));
    assert.doesNotMatch(g.out, /does not read it back/);
  } finally { signer.close(); }
  assert.equal(await slot(), 1n);
  const sj = JSON.parse((await as(["session", "delegate", "--status", "--json"])).out);
  assert.deepEqual([sj.supported, sj.granted, sj.vault, sj.ledger, sj.source], [true, true, vault, P.ledger, "chain"]);
  // the relay answers the same question when the chain can't be read
  const sr = await as(["session", "delegate", "--status", "--owner", owner.address, "--json"], { env: { ENCLAVE_RPC: "http://127.0.0.1:9" } });
  ok(sr, "delegate --status from the relay");
  assert.deepEqual([JSON.parse(sr.out).granted, JSON.parse(sr.out).source], [true, "relay"]);

  // now the session acts on it: stop, resume, resize, lower the cap, fund - each one session operation, no wallet
  const stop = await as(["stop", id, "--yes"]);
  ok(stop, "stop");
  assert.match(stop.out, /stopped on-chain/);
  assert.equal((await ledgerGet(id)).active, false);
  ok(await as(["resume", id, "--yes"]), "resume");
  assert.equal((await ledgerGet(id)).active, true);
  const rz = await as(["resize", id, "--cpu", "0.5", "--yes"]);
  ok(rz, "resize");
  assert.equal((await ledgerGet(id)).cpuMilli, 500);
  // a wallet record is PRODUCTION to a session: the cap only goes down
  const up = await as(["rate-cap", id, "4", "--yes"]);
  assert.notEqual(up.code, 0);
  assert.match(up.err, /a session may only LOWER a production deployment's rate cap .*held by the owner's wallet.*--wallet/);
  assert.equal(await capOf(), 1000n);
  ok(await as(["rate-cap", id, "2.88", "--yes"]), "rate-cap down");
  assert.equal(await capOf(), 800n);
  // ... and what it runs is the wallet's alone, refused up front whatever the grant says
  for (const args of [["upgrade", id, "1.0.0", "--yes"], ["config", "set", id, '{"mode":"x"}', "--yes"]]) {
    const r = await as(args);
    assert.notEqual(r.code, 0, args.join(" "));
    assert.match(r.err, /a session can't change what a production app runs .*the owner does it with --wallet/);
  }
  assert.equal((await ledgerGet(id)).configCid, "");
  const bal0 = (await ledgerGet(id)).balance6;
  const fund = await as(["fund", id, "--usdc", "0.5", "--yes"]);
  ok(fund, "fund");
  assert.ok((await ledgerGet(id)).balance6 > bal0, "the funding landed on the wallet's record");

  // refund: the ledger pays the WALLET (never the vault or the session)
  const refundable = await chain.pc.readContract({ address: P.ledger, abi: P.abi.ledger.abi, functionName: "refundableOf", args: [id] });
  assert.ok(refundable > 0n);
  const before = await usdcBal(owner.address), vaultBefore = await usdcBal(vault);
  const rf = await as(["refund", id, "--yes"]);
  ok(rf, "refund");
  assert.ok(rf.out.includes(`refunded ${sdk.fmtUsd(refundable)} to ${owner.address} (the owner's wallet)`), rf.out);
  assert.equal(await usdcBal(owner.address), before + refundable);
  assert.ok((await usdcBal(vault)) <= vaultBefore, "nothing of it went to the vault");
  assert.equal((await ledgerGet(id)).active, false);
  assert.equal((await ledgerGet(id)).owner, owner.address, "still the wallet's");

  // revoke (here as an unsigned transaction the owner signs elsewhere): refused again, with the same next step
  const rv = await as(["session", "delegate", "--revoke", "--unsigned", "--from", owner.address, "--json", "--yes"]);
  ok(rv, "delegate --revoke --unsigned");
  const tx = JSON.parse(rv.out).unsigned;
  assert.equal(tx.to, P.ledger);
  assert.equal(tx.data, sdk.setDelegateCall(vault, false).data);
  await chain.pc.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: tx.to, data: tx.data }) });
  assert.equal(await slot(), 0n);
  const r4 = await as(["resume", id, "--yes"]);
  assert.notEqual(r4.code, 0);
  assert.match(r4.err, /refused deploy\.setActive: delegation/);
  assert.match(r4.err, /enclave session delegate/);
  assert.equal((await ledgerGet(id)).active, false);

  // a staging-only agent never reaches a wallet record, delegation or not
  const sdir = path.join(tmp, "wallet-staging");
  const a1 = await cli(["session", "new", "--preset", "staging-publish", "--app", "ws-staging", "--budget", "0", "--no-wait"], { dir: sdir });
  ok(a1, "staging session new");
  await ownerSigns(a1.out);
  ok(await cli(["session", "resume-wait", /resume-wait (pending-[0-9a-f]+)/.exec(a1.out)[1]], { dir: sdir }), "staging resume-wait");
  const a2 = await cli(["resume", id, "--yes"], { dir: sdir });
  assert.notEqual(a2.code, 0);
  assert.match(a2.err, /refused deploy\.setActive: env: .*held by the owner's wallet .* acts only in staging/);
});
