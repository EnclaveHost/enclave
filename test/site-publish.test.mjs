// Publication through the REAL enclave CLI on a local anvil chain (work/site-automation-interface.txt §5): the real
// ledger, the pinned session factory and a real SessionVault. What it proves:
//   - a publisher record the owner's VAULT holds in STAGING is published by a session limited to deploy.setConfig, with a
//     gas payer that authorizes nothing: no wallet ceremony for the release; only `value` changes; the key reference
//     (the IPNS identity) is unchanged; the result is read back from the chain;
//   - a WALLET-held record cannot be changed by that session (the CLI and the vault refuse), and publication is then
//     reported pending the owner's one authorization, with the exact plan.
// No Enclave API, address book or non-loopback connection is used (the network guard records any).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeFunctionData } from "viem";
import { haveTools, startRig, openSession, KEYS } from "./helpers/cli-independent-rig.mjs";
import { prepareRelease } from "../scripts/site-release/release.mjs";
import { loadPublication, publishRelease } from "../scripts/site-release/publish.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = pathToFileURL(path.join(REPO, "test/helpers/cli-network-guard.mjs")).href;
const skip = haveTools();
const T = skip ? { skip, timeout: 240000 } : { timeout: 240000 };
const ZERO = "0x0000000000000000000000000000000000000000";
let r, tmp, release, session, netLog, env;
const CONFIG = { ipnsKey: "$IPNS_ED25519_SK", value: "https://mutable.example/site-root", lifetimeSecs: 172800, republishSecs: 14400,
  delegates: ["https://delegated-ipfs.dev"], dht: true, api_key: "$API_KEY", ipni: { indexers: ["https://cid.contact"] } };

before(async () => {
  if (skip) return;
  r = await startRig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-publish-"));
  netLog = path.join(tmp, "net.log"); fs.writeFileSync(netLog, "");
  const cli = path.join(tmp, "cli"); fs.mkdirSync(cli);
  for (const n of ["install.sh", "install.ps1", "host.ps1"]) fs.writeFileSync(path.join(cli, n), `# ${n}\n`);
  const dist = path.join(tmp, "dist"); fs.mkdirSync(path.join(dist, "js/chunks"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<script>x</script>");
  fs.writeFileSync(path.join(dist, "js/chunks/a-AAAA.js"), "a");
  fs.writeFileSync(path.join(dist, "csp-script-src.txt"), `script-src 'self' 'sha256-${createHash("sha256").update("x").digest("base64")}';\n`);
  release = prepareRelease({ dist, installers: cli, out: path.join(tmp, "out"), noBase: true });
  fs.writeFileSync(path.join(tmp, "pins.json"), JSON.stringify(r.pins));
  // the operator's environment for the CLI: the session store and a gas payer (an EOA with gas only), by NAME in the file
  env = { PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, "conf"), ENCLAVE_SESSION_DIR: path.join(tmp, "sessions"),
    ENCLAVE_KEY: KEYS.other, ENCLAVE_API_BASE: r.apiOrigin, ENCLAVE_ADDRESS_BOOK: "0x" + "ab".repeat(20),
    NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_TEST_DENY_PORT: String(r.apiPort) };
});
after(async () => { if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const ledgerGet = (id) => r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "get", args: [id] });
const envelope = async (id) => JSON.parse((await ledgerGet(id)).configCid);
const TEST_ENV = ["XDG_CONFIG_HOME", "ENCLAVE_API_BASE", "ENCLAVE_ADDRESS_BOOK", "NODE_OPTIONS", "ENCLAVE_TEST_NET_LOG", "ENCLAVE_TEST_DENY_PORT"];
function publication(deployment, mode, { session = ["ENCLAVE_SESSION_DIR"] } = {}) {
  const f = path.join(tmp, `publication-${mode}-${deployment.slice(2, 10)}-${session[0]}.json`);
  fs.writeFileSync(f, JSON.stringify({ version: 1, deployment, mode, cli: ["@node", "@enclave-cli"],
    cliArgs: ["--independent", "--contract-pins", path.join(tmp, "pins.json"), "--usdc-token", r.addresses.usdc, "--rpc", r.rpcs.join(","), "--confirmations", "1"],
    passEnv: [...session, "ENCLAVE_KEY", ...TEST_ENV], owner: r.owner }));
  return f;
}
const noEnclave = () => { assert.equal(r.apiHits.length, 0); assert.equal(fs.readFileSync(netLog, "utf8").trim(), "", "no non-loopback connection"); };
const secrets = () => [KEYS.other.slice(2), KEYS.owner.slice(2), ...fs.readdirSync(env.ENCLAVE_SESSION_DIR).filter((n) => n.endsWith(".json"))
  .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(env.ENCLAVE_SESSION_DIR, n), "utf8")).pkcs8; } catch { return null; } }).filter(Boolean)];
const mine = async () => { await r.mine(); await r.mine(); };

let staged, walletHeld;
test("a vault-held STAGING publisher is published by a deploy.setConfig-only session: no wallet ceremony, only `value` changes", T, async () => {
  // the owner's one-time setup: a session scoped to deploy.setConfig, the record in its vault as staging, the publisher config
  session = await openSession(r, { sessionDir: env.ENCLAVE_SESSION_DIR, actions: ["deploy.setConfig"] });
  const create = encodeFunctionData({ abi: r.A.ledger.abi, functionName: "create", args: [r.appRef, 0, 100, 8080, "http:8080", true, "", ZERO, 0n, 100000n] });
  staged = r.createdId(await r.write(r.wc(KEYS.owner), session.vault, r.A.vault.abi, "ownerCall", [r.addresses.ledger, create]));
  await session.ownerOp({ op: "adopt", deployment: staged, environment: "staging" });
  const setCfg = encodeFunctionData({ abi: r.A.ledger.abi, functionName: "setConfig", args: [staged, JSON.stringify({ config: CONFIG })] });
  await r.write(r.wc(KEYS.owner), session.vault, r.A.vault.abi, "ownerCall", [r.addresses.ledger, setCfg]);
  await mine();
  const ownerNonce = await r.pc.getTransactionCount({ address: r.owner });
  // the release: the tool drives the real CLI (config show, config set through the session, config show again)
  const pub = loadPublication(publication(staged, "session"));
  const p = await publishRelease(pub, release.dir, { out: path.join(tmp, "plan"), env });
  assert.equal(p.state, "config-set", JSON.stringify(p));
  assert.equal(p.to, `/ipfs/${release.cid}`); assert.equal(p.from, CONFIG.value);
  assert.match(p.warnings[0], /mutable URL/);
  assert.deepEqual(p.identity, { ipnsKey: "$IPNS_ED25519_SK" });
  await mine();
  const env1 = await envelope(staged);
  assert.deepEqual(env1.config, { ...CONFIG, value: `/ipfs/${release.cid}` }, "on chain: only value changed; the key reference is the same");
  assert.equal(await r.pc.getTransactionCount({ address: r.owner }), ownerNonce, "the owner's wallet signed nothing for this release");
  for (const s of secrets()) assert.ok(!JSON.stringify(p).includes(s), "no key material in the result");
  // a repeat finds it published and sends nothing
  const again = await publishRelease(pub, release.dir, { out: path.join(tmp, "plan"), env });
  assert.equal(again.state, "already-published");
  noEnclave();
});

test("the CI path: the tool's `publish` command with the session EXPORTED into ENCLAVE_SESSION (no session directory); nothing printed", T, async () => {
  const S = await import("../sdk/sessions/dist/node.mjs");
  const store = new S.FileStore(env.ENCLAVE_SESSION_DIR);
  const exported = S.exportSessionString(await store.load(store.activeId()));
  const ciEnv = { ...env, ENCLAVE_SESSION: exported, ENCLAVE_SESSION_DIR: path.join(tmp, "empty-sessions") };
  const dist = path.join(tmp, "dist2"); fs.cpSync(path.join(tmp, "dist"), dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "js/chunks/b-BBBB.js"), "b");
  const rel2 = prepareRelease({ dist, installers: path.join(tmp, "cli"), out: path.join(tmp, "out"), base: release.dir });
  const x = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(REPO, "scripts/site-release/cli.mjs"), "publish", "--release", rel2.dir,
      "--publish", publication(staged, "session", { session: ["ENCLAVE_SESSION"] }), "--approve", rel2.cid, "--plan-out", path.join(tmp, "plan2")], { env: ciEnv });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d)); c.on("close", (code) => resolve({ code, out, err }));
  });
  assert.equal(x.code, 0, x.err + x.out);
  assert.match(x.out, new RegExp(`"state": "config-set"[^]*"to": "/ipfs/${rel2.cid}"`));
  for (const s of [...secrets(), exported]) assert.ok(!(x.out + x.err).includes(s), "no key material printed");
  await mine();
  assert.equal((await envelope(staged)).config.value, `/ipfs/${rel2.cid}`);
  noEnclave();
});

test("a WALLET-held publisher: the session cannot change it; publication is pending the owner, with the exact plan", T, async (t) => {
  walletHeld = r.createdId(await r.create(KEYS.owner));
  await r.write(r.wc(KEYS.owner), r.addresses.ledger, r.A.ledger.abi, "setConfig", [walletHeld, JSON.stringify({ config: CONFIG })]);
  await mine();
  // asking the session to do it is refused (production, wallet-held: setConfig stays the owner's), and nothing changes
  const refused = await publishRelease(loadPublication(publication(walletHeld, "session")), release.dir, { out: path.join(tmp, "plan3"), env }).catch((e) => e);
  t.diagnostic(`CLI refusal: ${refused.message}`);
  assert.match(refused.message, /^enclave config set \(session\) failed: [^]*is held by the owner's wallet 0x[0-9a-fA-F]{40}, so to a session it is a PRODUCTION[^]*the plan for the owner is /);
  await mine();
  assert.deepEqual((await envelope(walletHeld)).config, CONFIG);
  // plan mode: the publication is reported pending, the exact owner operation is written, nothing is sent
  const p = await publishRelease(loadPublication(publication(walletHeld, "plan")), release.dir, { out: path.join(tmp, "plan3"), env });
  assert.equal(p.state, "pending-owner");
  const plan = JSON.parse(fs.readFileSync(p.planFile, "utf8"));
  assert.deepEqual(plan.operations[0].argv.slice(0, 4), ["enclave", "config", "set", walletHeld]);
  assert.deepEqual(plan.operations[1].argv.slice(-3), ["--unsigned", "--from", r.owner]);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.configFile, "utf8")), { ...CONFIG, value: `/ipfs/${release.cid}` });
  await mine();
  assert.deepEqual((await envelope(walletHeld)).config, CONFIG, "plan mode sent nothing");
  // a publication file that tries to choose a signer or carry a key is refused before anything runs
  const bad = path.join(tmp, "bad.json");
  for (const [k, v, re] of [["cliArgs", ["--wallet"], /must not choose a signer/], ["cliArgs", ["--rpc", "9f".repeat(40)], /key-like/], ["token", "x", /a publication file is/]]) {
    fs.writeFileSync(bad, JSON.stringify({ ...JSON.parse(fs.readFileSync(publication(walletHeld, "plan"), "utf8")), [k]: v }));
    assert.throws(() => loadPublication(bad), re);
  }
  noEnclave();
});

test("deliver --publish: one run mirrors to the target, then publishes through the session; a pending owner step exits 3", T, async () => {
  const dist = path.join(tmp, "dist3"); fs.cpSync(path.join(tmp, "dist"), dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "js/chunks/c-CCCC.js"), "c");
  const rel3 = prepareRelease({ dist, installers: path.join(tmp, "cli"), out: path.join(tmp, "out"), base: release.dir });
  const targets = path.join(tmp, "targets.json"), root = path.join(tmp, "root");
  fs.writeFileSync(targets, JSON.stringify({ version: 1, targets: [{ name: "local", kind: "local-root", root }] }));
  const run = (pub, out) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(REPO, "scripts/site-release/cli.mjs"), "deliver", "--release", rel3.dir, "--targets", targets,
      "--approve", rel3.cid, "--publish", pub, "--plan-out", out, "--journal", path.join(tmp, "journal")], { env });
    let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d)); c.on("close", (code) => resolve({ code, out: o, err: e }));
  });
  const x = await run(publication(staged, "session"), path.join(tmp, "plan4"));
  assert.equal(x.code, 0, x.err + x.out);
  assert.ok(fs.existsSync(path.join(root, rel3.cid, "release.json")), "delivered first");
  assert.match(x.out, /"step": "publish"[^]*"state": "config-set"/);
  await mine();
  assert.equal((await envelope(staged)).config.value, `/ipfs/${rel3.cid}`);
  const y = await run(publication(walletHeld, "plan"), path.join(tmp, "plan5"));
  assert.equal(y.code, 3, "publication pending the owner"); assert.match(y.out, /"state": "pending-owner"/);
  noEnclave();
});
