// Independent CLI, second suite: wallet-submitted session calls and relay-free session grants on the PINNED factory,
// version upgrades, ETH funding, owner-committed startup through a storage plan (SNP default and the explicit Shield
// target), and replicated publication. Same harness as test/cli-independent.test.mjs: the real CLI binary, real contracts
// on a local anvil, three RPC proxies, a stand-in Enclave API that must stay unused, and a network guard that refuses and
// logs every non-loopback connection. All mutation happens on this throwaway local chain.
//
//   run: node --test --test-concurrency=1 --test-timeout=180000 test/cli-independent-sessions.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, http as viemHttp, decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { haveTools, startRig, startStorage, KEYS, chain } from "./helpers/cli-independent-rig.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "cli", "enclave.mjs");
const GUARD = pathToFileURL(path.join(REPO, "test/helpers/cli-network-guard.mjs")).href;
const BOOK = "0x" + "ab".repeat(20);
const skip = haveTools();
const T = skip ? { skip, timeout: 150000 } : { timeout: 150000 };
const OWNER = privateKeyToAccount(KEYS.owner).address, OTHER = privateKeyToAccount(KEYS.other).address;
let r, tmp, pinsFile, netLog, sessionDir, storage;
const cliEntry = process.env.ENCLAVE_CLI_ENTRY || CLI;   // the staged bundle can be tested in place of the source

before(async () => {
  if (skip) return;
  r = await startRig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-ind-sess-"));
  pinsFile = path.join(tmp, "pins.json"); fs.writeFileSync(pinsFile, JSON.stringify(r.pins));
  netLog = path.join(tmp, "net.log"); fs.writeFileSync(netLog, "");
  sessionDir = path.join(tmp, "sessions");
  storage = await startStorage(r, { dir: tmp });
});
after(async () => { if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

// the CLI reads at a confirmed block: what the rig just wrote is mined over first
async function cli(args, opts = {}) { await r.mine(); await r.mine(); return run(args, opts); }
function run(args, { key = KEYS.owner, extra = {}, pins = pinsFile, sessions = sessionDir } = {}) {
  const base = ["--independent", "--contract-pins", pins, "--usdc-token", r.addresses.usdc, "--rpc", r.rpcs.join(","), "--confirmations", "1", "--yes"];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cliEntry, ...args, ...base], { cwd: tmp, env: {
      PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, "conf"), ENCLAVE_SESSION_DIR: sessions,
      ...(key ? { ENCLAVE_KEY: key } : {}), ENCLAVE_API_BASE: r.apiOrigin, ENCLAVE_ADDRESS_BOOK: BOOK, NODE_EXTRA_CA_CERTS: storage.caFile,
      NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_TEST_DENY_PORT: String(r.apiPort), ...extra } });
    let out = "", err = "";
    const killer = setTimeout(() => { err += "\n[test: CLI killed after 90 s]"; p.kill("SIGKILL"); }, 90000);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err, json: jsonOf(out) }); });
  });
}
// --json output, after any human lines the command printed first (those may contain braces): the block that starts a line
function jsonOf(out) {
  try { return JSON.parse(out); } catch {}
  const at = out.lastIndexOf("\n{");
  try { return at >= 0 ? JSON.parse(out.slice(at + 1)) : null; } catch { return null; }
}
const sends = () => r.rpcLog.filter((x) => x.method === "eth_sendRawTransaction").length;
function noEnclave() {
  assert.deepEqual(r.apiHits, [], "the stand-in Enclave API was called");
  assert.equal(fs.readFileSync(netLog, "utf8"), "", "a non-loopback or Enclave connection was attempted");
  assert.equal(r.rpcLog.filter((x) => x.to === BOOK).length, 0, "the mutable address book was read");
}
const ledgerGet = (id) => r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "get", args: [id] });
const reset = () => { for (const k of Object.keys(r.rpcModes)) delete r.rpcModes[k]; };
const sessionOf = (vault, sid) => r.pc.readContract({ address: vault, abi: r.A.vault.abi, functionName: "sessionOf", args: [sid] });

let sess;   // the live session opened by the owner's own key
let shieldRecord;   // the Shield startup record of the Shield test
test("session new: the owner's key signs the grant for the PINNED factory and opens it in one transaction, no relay", T, async () => {
  const x = await cli(["session", "new", "--preset", "browser", "--budget", "5", "--days", "1", "--label", "agent", "--json"]);
  assert.equal(x.code, 0, x.err + x.out);
  sess = x.json;
  assert.equal(sess.live, true); assert.equal(sess.factory.toLowerCase(), r.addresses.factory.toLowerCase());
  const [st, live] = await sessionOf(sess.vault, sess.sid);
  assert.equal(live, true); assert.equal(st.balance6, 5_000_000n);
  const insp = await cli(["session", "inspect", "--json"]);
  assert.equal(insp.code, 0, insp.err); assert.equal(insp.json.sid, sess.sid); assert.ok(insp.json.actions.includes("deploy.create"));
  noEnclave();
});

let held;   // a staging deployment the VAULT holds, created and funded by the session
test("session-signed actions: the session key authorizes, a different wallet only pays gas, the vault enforces scope and budget", T, async () => {
  // the gas payer is NOT the owner: the session's own grant is what authorizes every one of these
  const asPayer = { key: KEYS.other };
  const d = await cli(["deploy", "hello:1", "--cpu", "0.1", "--gpu", "0", "--env", "staging", "--fund", "1", "--json"], asPayer);
  assert.equal(d.code, 0, d.err + d.out);
  held = d.json.id;
  let rec = await ledgerGet(held);
  assert.equal(rec.owner.toLowerCase(), sess.vault.toLowerCase());
  assert.equal(rec.balance6, 1_000_000n);
  assert.match(d.err, /signed deploy\.create; 0x[0-9a-fA-F]{40} submits it and pays gas only/);
  for (const [args, check] of [
    [["fund", held, "--usdc", "0.5"], async () => assert.equal((await ledgerGet(held)).balance6, 1_500_000n)],
    [["rate-cap", held, "0.72"], async () => assert.equal(await r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "capOf", args: [held] }), 200n)],
    [["upgrade", held, "2"], async () => assert.equal((await ledgerGet(held)).appRef, `catalog://${r.appId}/1`)],
    [["stop", held], async () => assert.equal((await ledgerGet(held)).active, false)],
    [["resume", held], async () => assert.equal((await ledgerGet(held)).active, true)],
  ]) {
    const s0 = sends();
    const x = await cli(args, asPayer);
    assert.equal(x.code, 0, `${args[0]}: ${x.err}${x.out}`);
    assert.equal(sends() - s0, 3, `${args[0]}: one signed transaction, broadcast once to each RPC`);
    await check();
  }
  const [st] = await sessionOf(sess.vault, sess.sid);
  assert.equal(st.balance6, 3_500_000n, "the session budget paid exactly the 1.5 USDC of funding");
  // --unsigned: the exact session-signed call, for any gas payer, and nothing is sent
  const s0 = sends();
  const u = await cli(["fund", held, "--usdc", "0.1", "--unsigned", "--json"], { key: null });
  assert.equal(u.code, 0, u.err); assert.equal(u.json.unsigned.to.toLowerCase(), sess.vault.toLowerCase());
  assert.equal(decodeFunctionData({ abi: r.A.vault.abi, data: u.json.unsigned.data }).functionName, "execute", "a session-signed SessionVault.execute");
  assert.equal(sends(), s0);
  // no key at all and no --unsigned: refused, nothing sent
  const n = await cli(["fund", held, "--usdc", "0.1"], { key: null });
  assert.equal(n.code, 1); assert.match(n.err, /a gas payer must submit it/); assert.equal(sends(), s0);
  noEnclave();
});

test("config set/clear through the session on the staging record its vault holds; the gas payer only pays gas", T, async () => {
  const s0 = sends();
  const x = await cli(["config", "set", held, '{"mode":"fast"}', "--waf", '{"rps":7}', "--json"], { key: KEYS.other });
  assert.equal(x.code, 0, x.err + x.out); assert.equal(sends() - s0, 3);
  let env = JSON.parse((await ledgerGet(held)).configCid);
  assert.deepEqual(env.config, { mode: "fast" }); assert.deepEqual(env.waf, { rps: 7 });
  const c = await cli(["config", "clear", held, "config", "--json"], { key: KEYS.other });
  assert.equal(c.code, 0, c.err + c.out);
  env = JSON.parse((await ledgerGet(held)).configCid);
  assert.equal("config" in env, false); assert.deepEqual(env.waf, { rps: 7 }, "clearing config keeps the waf");
  noEnclave();
});

test("a session-signed call whose answers are lost is outcome-unknown and never resent", T, async () => {
  for (const i of [0, 1, 2]) r.rpcModes[i] = "blackhole-send";
  const s0 = sends();
  const x = await cli(["fund", held, "--usdc", "0.25"], { key: KEYS.other });
  reset();
  assert.notEqual(x.code, 0); assert.match(x.err, /outcome is UNKNOWN/);
  assert.equal(sends() - s0, 3);
  await r.mine(); await r.mine();
  assert.equal((await ledgerGet(held)).balance6, 1_750_000n, "it did land: exactly why it must not be retried");
  noEnclave();
});

test("wrong factory and wrong chain sessions are refused before anything is signed", T, async () => {
  // a second, unpinned factory: the stored session belongs to the pinned one, so pinning the other refuses it
  const lib = await r.deploy(r.A.svlib);
  const factory2 = await r.deploy(r.A.factory, [r.addresses.usdc, r.addresses.ledger, r.addresses.catalog, r.addresses.router,
    "0x0000000000000000000000000000000000000000", 1000_000000n], { "contracts/SessionVault.sol:SessionVaultLib": lib });
  const pins2 = path.join(tmp, "pins-factory2.json");
  fs.writeFileSync(pins2, JSON.stringify({ ...r.pins, contracts: { ...r.pins.contracts, sessionVaultFactory: factory2.toLowerCase() } }));
  const s0 = sends();
  const wf = await cli(["fund", held, "--usdc", "0.1"], { pins: pins2 });
  assert.equal(wf.code, 1); assert.match(wf.err, /not on the pinned chain and session factory/);
  // an isolated COPY of the session store whose record claims chain 1
  const copy = path.join(tmp, "sessions-chain1"); fs.cpSync(sessionDir, copy, { recursive: true });
  for (const f of fs.readdirSync(copy).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(copy, f), "utf8"));
    if (j.handle) { j.chainId = 1; j.handle.chainId = 1; fs.writeFileSync(path.join(copy, f), JSON.stringify(j), { mode: 0o600 }); }
  }
  const wc = await cli(["fund", held, "--usdc", "0.1"], { sessions: copy });
  assert.equal(wc.code, 1); assert.match(wc.err, /not on the pinned chain and session factory/);
  assert.equal(sends(), s0);
  noEnclave();
});

test("an externally held owner wallet: exact typed data out, the signature checked against the owner before anything is sent", T, async () => {
  const ext = path.join(tmp, "sessions-ext");
  // no owner key in this process: the grant is printed for the owner's own wallet (budget 0: one signature)
  const x = await cli(["session", "new", "--preset", "browser", "--owner", OWNER, "--days", "1", "--json"], { key: null, sessions: ext });
  assert.equal(x.code, 0, x.err + x.out);
  const { pending, typedData, vault } = x.json;
  assert.equal(typedData.primaryType, "SessionGrant"); assert.equal(typedData.domain.verifyingContract.toLowerCase(), vault.toLowerCase());
  const revive = (td) => JSON.parse(JSON.stringify(td), (k, v) => (typeof v === "string" && /^\d+$/.test(v) && ["budget", "spendPerPeriod", "maxFeePerOp", "maxAppFeePerHour", "maxRatePerHour", "expiresAt", "signBefore", "chainId"].includes(k)) ? BigInt(v) : v);
  const td = revive(typedData);
  const s0 = sends();
  const forged = await privateKeyToAccount(KEYS.other).signTypedData(td);
  const bad = await cli(["session", "open", pending, "--owner-signature", forged], { key: KEYS.other, sessions: ext });
  assert.equal(bad.code, 1); assert.match(bad.err, /is not 0x[0-9a-fA-F]{40}'s over this exact SessionGrant \(vault 0x[0-9a-fA-F]{40}, chain 8453\); nothing was sent/); assert.equal(sends(), s0);
  const sig = await privateKeyToAccount(KEYS.owner).signTypedData(td);
  // the owner's signature; a DIFFERENT wallet submits it and pays gas
  const ok = await cli(["session", "open", pending, "--owner-signature", sig, "--json"], { key: KEYS.other, sessions: ext });
  assert.equal(ok.code, 0, ok.err + ok.out); assert.equal(ok.json.live, true); assert.equal(ok.json.owner, OWNER);
  // the session key ends its own session; any gas payer submits that too
  const end = await cli(["session", "terminate", "--json"], { key: KEYS.other, sessions: ext });
  assert.equal(end.code, 0, end.err); assert.equal(end.json.ended, true);
  noEnclave();
});

test("revoke-all: the owner's own transaction ends every session; a revoked session's call is refused before sending", T, async () => {
  const u = await cli(["session", "revoke-all", "--vault", sess.vault, "--json"], { key: null });
  assert.equal(u.code, 0, u.err); assert.equal(u.json.unsigned.from.toLowerCase(), OWNER.toLowerCase(), "the exact DIRECT call for the owner's own wallet");
  const x = await cli(["session", "revoke-all", "--json"]);
  assert.equal(x.code, 0, x.err); assert.equal(x.json.revoked, true);
  const s0 = sends();
  const f = await cli(["fund", held, "--usdc", "0.1"], { key: KEYS.other });
  assert.equal(f.code, 1); assert.match(f.err, /ended|not live/); assert.equal(sends(), s0);
  const insp = await cli(["session", "inspect", "--json"]);
  assert.equal(insp.json.live, false); assert.match(insp.json.state, /revoked/);
  noEnclave();
});

test("wallet upgrade/set-version and ETH funding; a disabled ETH feed is refused at simulation, before signing", T, async () => {
  const id = r.createdId(await r.create(KEYS.owner));
  const up = await cli(["set-version", id, "2", "--wallet", "--json"]);
  assert.equal(up.code, 0, up.err + up.out); assert.equal((await ledgerGet(id)).appRef, `catalog://${r.appId}/1`);
  const eth = await cli(["fund", id, "--eth", "0.001", "--wallet", "--json"]);
  assert.equal(eth.code, 0, eth.err + eth.out);
  assert.ok((await ledgerGet(id)).balance6 > 0n, "credited at the feed's $3000/ETH");
  await r.write(r.wc(KEYS.deployer), r.addresses.ledger, r.A.ledger.abi, "setEthUsdFeed", ["0x0000000000000000000000000000000000000000"]);
  const s0 = sends();
  const off = await cli(["fund", id, "--eth", "0.001", "--wallet"]);
  await r.write(r.wc(KEYS.deployer), r.addresses.ledger, r.A.ledger.abi, "setEthUsdFeed", [r.addresses.feed]);
  assert.equal(off.code, 1); assert.match(off.err, /would revert.*eth funding disabled/); assert.equal(sends(), s0);
  noEnclave();
});

test("bootstrap prepare/publish/activate through the storage plan (SNP default); a short plan and a lost answer never commit twice", T, async () => {
  const d = await cli(["deploy", "hello:1", "--cpu", "0.1", "--gpu", "0", "--prepare-only", "--wallet", "--json"]);
  assert.equal(d.code, 0, d.err + d.out);
  const id = d.out.match(/created (0x[0-9a-f]{64})/)[1];
  const cfg = path.join(tmp, "app-config.json"); fs.writeFileSync(cfg, '{"greeting":"hi"}');
  const pkgFile = path.join(tmp, "pkg-snp.json");
  const p = await cli(["bootstrap", "prepare", id, "--config-file", cfg, "--app-id", "44".repeat(32), "--runtime-id", "55".repeat(32), "--public", "--out", pkgFile, "--json", "--wallet"]);
  assert.equal(p.code, 0, p.err + p.out);
  // two of three adapters refuse: the plan's two copies cannot be met, nothing is committed
  storage.modes[0] = "refuse"; storage.modes[1] = "refuse";
  const s0 = sends();
  const short = await cli(["bootstrap", "publish", id, "--file", pkgFile, "--storage-plan", storage.planFile, "--wallet"]);
  storage.modes[0] = storage.modes[1] = undefined;
  assert.notEqual(short.code, 0); assert.match(short.err, /storage availability requirement|copies/); assert.equal(sends(), s0);
  const pub = await cli(["bootstrap", "publish", id, "--file", pkgFile, "--storage-plan", storage.planFile, "--wallet", "--json"]);
  assert.equal(pub.code, 0, pub.err + pub.out); assert.ok(pub.json.storage.verifiedCopies >= 2);
  // the activation's answers are lost: outcome unknown, sent once
  for (const i of [0, 1, 2]) r.rpcModes[i] = "blackhole-send";
  const lost = await cli(["bootstrap", "activate", id, "--file", pkgFile, "--storage-plan", storage.planFile, "--wallet"]);
  reset();
  assert.notEqual(lost.code, 0); assert.match(lost.err, /outcome is UNKNOWN/); assert.equal(sends() - s0, 3);
  await r.mine(); await r.mine();
  const env = JSON.parse((await ledgerGet(id)).configCid);
  assert.equal(env.isolation.require, "snp-guest-per-app"); assert.equal(env.guestBootstrap.sha256, p.json.sha256);
  // the converse: an SNP record is never prepared for the Shield tier
  const s1 = sends();
  const shieldOnSnp = await cli(["bootstrap", "prepare", id, "--target", "shield", "--config-file", cfg, "--runtime-id", "55".repeat(32), "--public", "--out", path.join(tmp, "x5"), "--wallet"]);
  assert.equal(shieldOnSnp.code, 1); assert.match(shieldOnSnp.err, /requires snp-guest-per-app; use --target snp/); assert.equal(sends(), s1);
  noEnclave();
});

test("Shield target: the CLI derives the partition AppID and commits the measured configText with the host's own rule, and the host's startup check accepts it", T, async () => {
  const d = await cli(["deploy", "shieldapp:1", "--cpu", "0.1", "--gpu", "0", "--prepare-only", "--startup-target", "shield", "--wallet", "--json"]);
  assert.equal(d.code, 0, d.err + d.out);
  const id = d.out.match(/created (0x[0-9a-f]{64})/)[1];
  assert.equal(JSON.parse((await ledgerGet(id)).configCid).isolation.require, "hyperv-partition-per-app");
  const manager = { backend: "hyperv-partition-per-app", catalog: { derivations: ["enclave-catalog-bundle/1", "enclave-catalog-bundle/2", "enclave-catalog-bundle/5"] },
    supports: { config: true, configCid: false, secrets: false, gpu: false, ports: false, directBootstrap: true }, runtime: { configSocketServer: true },
    // the Shield-direct image the manager states (F3: the host compares it with its OWN pins, below)
    images: { shieldDirect: { runtimeId: "66".repeat(32), igvmSha256: "d1".repeat(32) } } };
  const mf = path.join(tmp, "shield-manager.json"); fs.writeFileSync(mf, JSON.stringify(manager));
  const comp = path.join(tmp, "component.wasm"); fs.writeFileSync(comp, r.component);
  // the owner's spelling (whitespace, a _media key the partition never sees) is NOT what the partition measures
  const cfg = path.join(tmp, "shield-config.json"); fs.writeFileSync(cfg, ' {\n  "greeting" : "hi",\n  "_media": {"logo": "x"}\n}\n');
  const rid = "66".repeat(32), pkgFile = path.join(tmp, "pkg-shield.json");
  const common = ["--target", "shield", "--shield-manager", mf, "--component-file", comp, "--runtime-id", rid, "--config-file", cfg, "--wallet"];
  // refusals: the wrong component bytes, an AppID the host would not derive, a custody package, the SNP record
  const wrong = path.join(tmp, "wrong.wasm"); fs.writeFileSync(wrong, Buffer.from("not the component"));
  const x1 = await cli(["bootstrap", "prepare", id, ...common.map((a) => a === comp ? wrong : a), "--public", "--out", path.join(tmp, "x1")]);
  assert.equal(x1.code, 1); assert.match(x1.err, /not the catalog version's component/);
  const x2 = await cli(["bootstrap", "prepare", id, ...common, "--app-id", "77".repeat(32), "--public", "--out", path.join(tmp, "x2")]);
  assert.equal(x2.code, 1); assert.match(x2.err, /is not the AppID the Shield host derives/);
  const custody = path.join(tmp, "custody.json"); fs.writeFileSync(custody, "{}");
  const x3 = await cli(["bootstrap", "prepare", id, ...common, "--custody-file", custody, "--out", path.join(tmp, "x3")]);
  assert.equal(x3.code, 1); assert.match(x3.err, /no direct custody-v2 delivery/); assert.ok(!fs.existsSync(path.join(tmp, "x3")));
  const p = await cli(["bootstrap", "prepare", id, ...common, "--public", "--out", pkgFile, "--json"]);
  assert.equal(p.code, 0, p.err + p.out);
  const appId = p.out.match(/shield: AppID ([0-9a-f]{64})/)[1];
  assert.match(p.out, /committing the measured configText/);
  const committed = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  assert.equal(committed.appId, appId); assert.equal(committed.configText, '{"greeting":"hi"}');
  assert.equal(jsonOf(p.out).configSha256, crypto.createHash("sha256").update('{"greeting":"hi"}').digest("hex"));
  // no effective public config ("{}", or only _media) is committed as "", never as the file's text
  for (const [i, text] of ['{}', '{"_media":{"logo":"x"}}', ' { } '].entries()) {
    const c = path.join(tmp, `empty-${i}.json`), out = path.join(tmp, `pkg-empty-${i}.json`); fs.writeFileSync(c, text);
    const e = await cli(["bootstrap", "prepare", id, ...common.map((a) => a === cfg ? c : a), "--public", "--out", out]);
    assert.equal(e.code, 0, e.err + e.out); assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).configText, "");
    assert.match(e.out, /enclave-catalog-bundle\/2\)/);   // no config requested: the http-port derivation, not /5
  }
  // custody-v2 only where the manager states direct custody: secrets-only commits "{}", and the bundle's hash is printed
  const custodyMgr = { ...manager, catalog: { derivations: [...manager.catalog.derivations, "enclave-catalog-bundle/6"] },
    supports: { ...manager.supports, secrets: true, custodyV2: true } };
  const cmf = path.join(tmp, "shield-manager-custody.json"); fs.writeFileSync(cmf, JSON.stringify(custodyMgr));
  const ptr = path.join(tmp, "custody-pointer.json"); fs.writeFileSync(ptr, JSON.stringify({ v: 2, chainId: 8453, vault: "0x" + "ab".repeat(20), machines: [] }));
  const emptyCfg = path.join(tmp, "empty-0.json"), cpkg = path.join(tmp, "pkg-shield-custody.json");
  const cp = await cli(["bootstrap", "prepare", id, ...common.map((a) => a === mf ? cmf : a === cfg ? emptyCfg : a), "--custody-file", ptr, "--out", cpkg, "--json"]);
  assert.equal(cp.code, 0, cp.err + cp.out);
  const cm = JSON.parse(fs.readFileSync(cpkg, "utf8"));
  assert.equal(cm.secretsMode, "custody-v2"); assert.equal(cm.configText, "{}"); assert.match(cp.out, /enclave-catalog-bundle\/6/);
  const h = crypto.createHash("sha256").update("{}").digest("hex");
  assert.equal(jsonOf(cp.out).configSha256, h); assert.match(cp.out, new RegExp(`seal the custody-v2 bundle with configSha256 ${h}`));
  assert.notEqual(cp.out.match(/shield: AppID ([0-9a-f]{64})/)[1], appId);
  // activating it is refused before any send without a direct-custody manager statement
  const sc = sends();
  const noMgr = await cli(["bootstrap", "activate", id, "--file", cpkg, "--storage-plan", storage.planFile, "--target", "shield", "--wallet"]);
  assert.equal(noMgr.code, 1); assert.match(noMgr.err, /Shield-direct manager stating custody-v2/);
  const pubMgr = await cli(["bootstrap", "activate", id, "--file", cpkg, "--storage-plan", storage.planFile, "--target", "shield", "--shield-manager", mf, "--wallet"]);
  assert.equal(pubMgr.code, 1); assert.match(pubMgr.err, /Shield-direct manager stating custody-v2/);
  assert.equal(sends(), sc);
  const pubSnp = await cli(["bootstrap", "publish", id, "--file", pkgFile, "--storage-plan", storage.planFile, "--wallet"]);
  assert.equal(pubSnp.code, 1); assert.match(pubSnp.err, /use --target shield \(refusing to publish it for snp-guest-per-app\)/);
  const pub = await cli(["bootstrap", "publish", id, "--file", pkgFile, "--storage-plan", storage.planFile, "--target", "shield", "--wallet"]);
  assert.equal(pub.code, 0, pub.err + pub.out);
  // target-specific validation: a Shield record is never prepared or activated for the SNP default, nothing is sent
  const s0 = sends();
  const snpOnShield = await cli(["bootstrap", "activate", id, "--file", pkgFile, "--storage-plan", storage.planFile, "--wallet"]);
  assert.equal(snpOnShield.code, 1); assert.match(snpOnShield.err, /requires hyperv-partition-per-app; use --target shield/);
  const snpPrepare = await cli(["bootstrap", "prepare", id, "--config-file", cfg, "--app-id", "44".repeat(32), "--runtime-id", rid, "--public", "--out", path.join(tmp, "x4"), "--wallet"]);
  assert.equal(snpPrepare.code, 1); assert.match(snpPrepare.err, /use --target shield/);
  assert.equal(sends(), s0);
  const act = await cli(["bootstrap", "activate", id, "--file", pkgFile, "--storage-plan", storage.planFile, "--target", "shield", "--wallet", "--json"]);
  assert.equal(act.code, 0, act.err + act.out);
  await r.mine(); await r.mine();
  const env = JSON.parse((await ledgerGet(id)).configCid);
  assert.equal(env.isolation.require, "hyperv-partition-per-app");
  // the Windows host's own startup authority, over the same chain and replicas, accepts exactly this package
  const { createShieldStartup } = await import("../windows/node/shield-startup.mjs");
  const { LeaseReader } = await import("../network/lease-reader.mjs");
  const clients = r.rpcs.map((u) => createPublicClient({ chain, transport: viemHttp(u, { retryCount: 0 }) }))
    .map((c) => Object.fromEntries(["getChainId", "getBlockNumber", "getBlock", "readContract"].map((k) => [k, c[k].bind(c)])));
  const reader = new LeaseReader({ clients, chainId: 8453, addressBook: "0x" + "00".repeat(20), confirmations: 1,
    authorityPins: { deployments: r.addresses.ledger, registry: r.addresses.registry, connectivity: "0x" + "00".repeat(20), sessionVaultFactory: "0x" + "00".repeat(20) } });
  const held0 = storage.held[0];
  const authority = createShieldStartup({ reader, pins: { deployments: r.addresses.ledger, appCatalog: r.addresses.catalog }, gateways: storage.plan.replicas.map((x) => x.gateway),
    fetchComponent: async (cid) => { assert.equal(cid, r.componentCid); return r.component; },
    fetchImpl: async (url) => { const cid = String(url).split("/ipfs/")[1]; const b = storage.held.map((m) => m.get(cid)).find(Boolean) || held0.get(cid);
      return b ? new Response(b) : new Response("", { status: 404 }); },
    abis: { DEP_ABI: r.A.ledger.abi, CATALOG_ABI: r.A.catalog.abi },
    // this node's own Shield-direct image pins (windows/node/shield-startup.mjs startupImages); ignored by a host without F3
    direct: { runtimeId: rid, imageSha256: "d1".repeat(32) } });
  shieldRecord = id;
  const v = await authority.materialize(id, { manager, runtimeId: rid, waf: {} });
  assert.equal(v.ok, true, JSON.stringify(v));
  // a Shield-direct manager: the committed configText IS the measured bytes, so the package is carried into the partition
  assert.equal(v.startup.direct, true); assert.ok(v.spawn.bootstrap);
  assert.equal(v.startup.appId, appId); assert.equal(v.startup.runtimeId, rid);
  noEnclave();
});

test("publish --storage-plan: the component and config are uploaded, read back and published by the wallet, no API", T, async () => {
  const wasm = path.join(REPO, "test/fixtures/egress-guest-http.wasm");
  const cfg = path.join(tmp, "pub-config.json"); fs.writeFileSync(cfg, '{"hello":"world"}');
  const x = await cli(["publish", wasm, "--slug", "pubtest", "--config-file", cfg, "--storage-plan", storage.planFile, "--wallet", "--json"]);
  assert.equal(x.code, 0, x.err + x.out);
  assert.ok(x.json.storage.wasm.verifiedCopies >= 2);
  const appId = await r.pc.readContract({ address: r.addresses.catalog, abi: r.A.catalog.abi, functionName: "appIdOf", args: [OWNER, "pubtest"] });
  assert.equal(await r.pc.readContract({ address: r.addresses.catalog, abi: r.A.catalog.abi, functionName: "numVersions", args: [appId] }), 1n);
  noEnclave();
});

test("wallet config: waf and override preserved separately; an oversized config needs the owner's storage plan; a Shield record refuses waf", T, async () => {
  const id = r.createdId(await r.create(KEYS.owner));
  const a = await cli(["config", "set", id, '{"k":"v"}', "--waf", '{"rps":5}', "--wallet", "--json"]);
  assert.equal(a.code, 0, a.err + a.out);
  let env = JSON.parse((await ledgerGet(id)).configCid);
  assert.deepEqual(env, { config: { k: "v" }, waf: { rps: 5 } });
  const show = await cli(["config", "show", id, "--wallet", "--json"]);
  assert.equal(show.code, 0, show.err); assert.deepEqual(show.json.config, { k: "v" });
  const big = JSON.stringify({ blob: "x".repeat(6000) });
  const s0 = sends();
  const noPlan = await cli(["config", "set", id, big, "--wallet"]);
  assert.equal(noPlan.code, 1); assert.match(noPlan.err, /too big for the envelope; pass --storage-plan/); assert.equal(sends(), s0);
  const pinned = await cli(["config", "set", id, big, "--storage-plan", storage.planFile, "--wallet", "--json"]);
  assert.equal(pinned.code, 0, pinned.err + pinned.out);
  env = JSON.parse((await ledgerGet(id)).configCid);
  assert.match(env.configCid, /^baf/); assert.deepEqual(env.waf, { rps: 5 });
  assert.ok(storage.held.filter((m) => m.has(env.configCid)).length >= 2, "the pinned body is held by at least two adapters");
  const s1 = sends();
  const shield = await cli(["config", "set", shieldRecord, "--waf", '{"rps":1}', "--wallet"]);
  assert.equal(shield.code, 1); assert.match(shield.err, /cannot enforce protection rules/); assert.equal(sends(), s1);
  const startupCfg = await cli(["config", "set", shieldRecord, '{"x":1}', "--wallet"]);
  assert.equal(startupCfg.code, 1); assert.match(startupCfg.err, /bootstrap prepare, publish and activate/); assert.equal(sends(), s1);
  noEnclave();
});

test("encvol is local; host declare-payout, status and fund use the schema-4 registry and the quorum; host setup needs its plan directory", T, async () => {
  const m = await cli(["encvol", "message", "k1"]);
  assert.equal(m.code, 0, m.err); assert.match(m.out, /Enclave encrypted volume key v1/);
  const dv = await cli(["encvol", "derive", "--key-id", "k1", "--json"]);
  assert.equal(dv.code, 0, dv.err); assert.deepEqual(Object.keys(dv.json).sort(), ["password", "salt", "sig"]);   // values are never printed by the test
  const reg = (id) => r.pc.readContract({ address: r.addresses.registry, abi: r.A.registry4.abi, functionName: "get", args: [id] });
  const dec = await cli(["host", "declare-payout", "--url", r.endpoint, "--wallet"]);
  assert.equal(dec.code, 0, dec.err + dec.out);
  assert.equal((await reg(r.runner)).payoutWallet, OWNER);
  const st = await cli(["host", "status", "--url", r.endpoint, "--json"]);
  assert.equal(st.code, 0, st.err); assert.equal(st.json.registered, true); assert.equal(st.json.host.payoutWallet, OWNER.toLowerCase());
  assert.equal(st.json.host.operator, r.operator.toLowerCase());
  const before = await r.pc.getBalance({ address: r.operator });
  const fund = await cli(["host", "fund", "--address", r.operator, "--eth", "0.001", "--wallet", "--json"]);
  assert.equal(fund.code, 0, fund.err + fund.out);
  assert.equal(await r.pc.getBalance({ address: r.operator }) - before, 1_000_000_000_000_000n);
  const clr = await cli(["host", "clear-payout", "--url", r.endpoint, "--wallet"]);
  assert.equal(clr.code, 0, clr.err); assert.equal((await reg(r.runner)).payoutWallet, "0x0000000000000000000000000000000000000000");
  // host setup is the plan-driven lifecycle now (docs/network/independent-host-onboarding.md): it needs the host's directory
  for (const sub of ["init", "run", "install"]) {
    const x = await cli(["host", sub]);
    assert.equal(x.code, 1); assert.match(x.err, /--dir HOST_DIR is required/);
  }
  for (const [cmd, re] of [["move", /registry host id.*no host names/], ["secrets", /usage: enclave.*secrets ls <id>/]]) {
    const x = await cli([cmd, "0x" + "11".repeat(32), "x"]);
    assert.equal(x.code, 1); assert.match(x.err, re);
  }
  // gpu is a supported management read, but only for a NAMED deployment: its host comes from the current lease
  const g = await cli(["gpu"]);
  assert.equal(g.code, 1); assert.match(g.err, /usage: enclave gpu <deployment-id>.*no host lookup/s);
  noEnclave();
});
