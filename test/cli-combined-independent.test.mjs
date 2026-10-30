// The combined independent CLI (work/cli-combined-integration-interface.txt): the features that arrived as separate glue
// patches, driven through ONE real cli/enclave.mjs (or the built bundle: ENCLAVE_CLI_ENTRY) as a subprocess. Real local
// chain: the cli-independent rig (anvil, chain 8453; the real ledger, the deployed schema-4 registry and the pinned
// session factory; three JSON-RPC origins). Every CLI process runs under the network guard, which refuses and logs any
// non-loopback connection; the log must stay empty and the stand-in Enclave API unhit.
//   - login: a session grant approved by the owner's own wallet and opened by a separate gas payer; resume; account;
//     top-up-link; logout. Then the signature hand-back: the owner only signs, and the CLI's gas key submits.
//   - host: the plan-driven lifecycle through `enclave host` (patch 01). The supervisor environment carries the key FILE and
//     the plan's RPCs (patches 02/03). `check` reads the rig chain through the quorum, and never reports ready (the control
//     attestation is UNKNOWN).
//   - dispatch: custody and signer now dispatch; secrets stays refused, naming the pending owner read.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { haveTools, startRig, KEYS } from "./helpers/cli-independent-rig.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.ENCLAVE_CLI_ENTRY ? path.resolve(process.env.ENCLAVE_CLI_ENTRY) : path.join(REPO, "cli", "enclave.mjs");
const GUARD = pathToFileURL(path.join(REPO, "test/helpers/cli-network-guard.mjs")).href;
const FRONTEND = "https://owner-reviewed.example";
const skip = haveTools();
const T = skip ? { skip, timeout: 240000 } : { timeout: 240000 };
let r, tmp, pinsFile, netLog, sessionDir, S;

before(async () => {
  if (skip) return;
  r = await startRig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-combined-"));
  pinsFile = path.join(tmp, "pins.json"); fs.writeFileSync(pinsFile, JSON.stringify(r.pins));
  netLog = path.join(tmp, "net.log"); fs.writeFileSync(netLog, "");
  sessionDir = path.join(tmp, "sessions");
  S = await import("../sdk/sessions/dist/node.mjs");
});
after(async () => { if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const independent = () => ["--independent", "--contract-pins", pinsFile, "--usdc-token", r.addresses.usdc, "--rpc", r.rpcs.join(","), "--confirmations", "1"];
async function cli(args, { key = KEYS.owner, env = {} } = {}) {
  await r.mine(); await r.mine();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...independent(), ...args], { cwd: tmp, env: {
      PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, "conf"), ENCLAVE_SESSION_DIR: sessionDir,
      ...(key ? { ENCLAVE_KEY: key } : {}), ENCLAVE_API_BASE: r.apiOrigin, ENCLAVE_ADDRESS_BOOK: "0x" + "ab".repeat(20),
      NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_TEST_DENY_PORT: String(r.apiPort), ...env } });
    let out = "", err = "";
    const killer = setTimeout(() => { err += "\n[test: CLI killed after 180 s]"; p.kill("SIGKILL"); }, 180000);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err, all: out + err }); });
  });
}
const noEnclave = () => {
  assert.equal(r.apiHits.length, 0, "the stand-in Enclave API was never called");
  assert.equal(fs.readFileSync(netLog, "utf8").trim(), "", "no non-loopback connection was attempted");
};
const linkOf = (text) => { const m = /https:\/\/owner-reviewed\.example\/grant#\S+/.exec(text); assert.ok(m, text); return m[0]; };
/** what the owner's frontend does with the link: decode it, check the key against the grant */
function grantOf(link) {
  const g = S.decodeGrantRequest(link.split("#")[1]);
  assert.equal(S.keyHashOf(BigInt(g.x), BigInt(g.y)).toLowerCase(), String(g.grant.sessionKey).toLowerCase(), "the link's key is the grant's key");
  return g.grant;
}
/** no private key of the login (PKCS#8) or wallet appears in any file the CLI wrote */
function noKeyMaterial(dir) {
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, String(f));
    if (!fs.statSync(p).isFile() || /\.key$|\.pkcs8$/.test(p)) continue;
    const t = fs.readFileSync(p, "utf8");
    for (const k of Object.values(KEYS)) assert.ok(!t.includes(k.slice(2)), `${p} holds a wallet key`);
  }
}

test("login: the owner's own wallet approves the printed grant, a separate payer opens it, the CLI adopts exactly it; account, top-up-link, logout", T, async () => {
  const owner = privateKeyToAccount(KEYS.owner);
  const a = await cli(["login", "--frontend", FRONTEND, "--owner", owner.address, "--no-wait"]);
  assert.equal(a.code, 0, a.all);
  assert.match(a.out, /check code [0-9A-F]{4}-[0-9A-F]{4}/);
  const link = linkOf(a.out);
  assert.ok(!/PRIVATE|pkcs8/i.test(link), "the link carries no key");
  const grant = grantOf(link);
  // the owner's frontend: the owner signs as the account, and ANOTHER wallet pays the gas
  const prep = await S.prepareSessionOpen({ publicClient: r.pc, factory: r.addresses.factory, owner, chainId: 8453, grant });
  const rc = await r.pc.waitForTransactionReceipt({ hash: await r.wc(KEYS.other).sendTransaction({ to: prep.to, data: prep.data }) });
  assert.equal(rc.status, "success");
  const b = await cli(["login", "--frontend", FRONTEND, "--resume", "--wait-minutes", "1"]);
  assert.equal(b.code, 0, b.all);
  assert.match(b.out, new RegExp(`signed in: session 0x[0-9a-f]{64} of ${owner.address.toLowerCase()}`));
  const acct = await cli(["account"]);
  assert.equal(acct.code, 0, acct.all);
  assert.match(acct.out, new RegExp(`account: ${owner.address.toLowerCase()}`)); assert.match(acct.out, /\(live\)/);
  const top = await cli(["session", "top-up-link", "--amount", "3", "--frontend", FRONTEND]);
  assert.equal(top.code, 0, top.all);
  assert.match(top.out, /https:\/\/owner-reviewed\.example\/sessions#topup=0x[0-9a-fA-F]{40}:0x[0-9a-f]{64}:3000000/);
  const out = await cli(["logout"]);
  assert.equal(out.code, 0, out.all);
  assert.match(out.out, /STILL LIVE on chain: .*session terminate/);
  noKeyMaterial(sessionDir);
  noEnclave();
});

test("login hand-back: another account only signs the grant; the CLI checks it on chain and its OWN gas key submits", T, async () => {
  const account = privateKeyToAccount(KEYS.other), gasKey = KEYS.deployer;
  const a = await cli(["login", "--frontend", FRONTEND, "--owner", account.address, "--switch-account", "--no-wait"], { key: gasKey });
  assert.equal(a.code, 0, a.all);
  const grant = grantOf(linkOf(a.out));
  const vault = await S.vaultAddress(r.pc, r.addresses.factory, account.address);
  const sig = await account.signTypedData(S.grantTypedData(8453, vault, grant));
  const gasBefore = await r.pc.getTransactionCount({ address: privateKeyToAccount(gasKey).address });
  const accountBefore = await r.pc.getTransactionCount({ address: account.address });
  // the gas payer is asked to confirm; --yes is that confirmation in a non-interactive run
  const b = await cli(["--yes", "login", "--frontend", FRONTEND, "--owner-signature", sig, "--wait-minutes", "1"], { key: gasKey });
  assert.equal(b.code, 0, b.all);
  assert.match(b.out, new RegExp(`signed in: session 0x[0-9a-f]{64} of ${account.address.toLowerCase()}`));
  assert.equal(await r.pc.getTransactionCount({ address: privateKeyToAccount(gasKey).address }), gasBefore + 1, "the CLI's gas key sent exactly the open");
  assert.equal(await r.pc.getTransactionCount({ address: account.address }), accountBefore, "the account itself sent nothing");
  noEnclave();
});

test("host: init/install/run/check through `enclave host` with the plan's quorum; key FILE and BASE_RPCS; check is never ready", T, async () => {
  const dir = path.join(tmp, "host"), units = path.join(tmp, "units");
  const init = ["host", "init", "--dir", dir, "--public-url", "https://host.example.org", "--repo", "example/enclave", "--release-id", "a".repeat(64),
    "--gateways", "http://203.0.113.5:8189", "--guest-mem-mib", "4096", "--guest-cpus", "2", "--supervisor-port", "1", "--attestation-url", "http://127.0.0.1:9/rad"];
  const i = await cli(init);
  assert.equal(i.code, 0, i.all);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "host-plan.json"), "utf8") || "null"); assert.ok(plan, i.all);
  assert.equal(plan.authorities.contractPins, pinsFile, "init recorded THIS invocation's pins");
  assert.deepEqual(plan.authorities.rpcs, r.rpcs, "and its RPC quorum");
  assert.equal(plan.supervisor.path, path.join(REPO, "supervisor.js"), "the default supervisor is this checkout's (bundled or not)");
  const keyText = fs.readFileSync(path.join(dir, "operator.key"), "utf8").trim();
  const dry = await cli(["host", "install", "--dir", dir, "--unit-dir", units]);
  assert.equal(dry.code, 0, dry.all);
  assert.match(dry.out, /REGISTRY_PRIVATE_KEY_FILE='[^']*\/operator\.key'/); assert.ok(!/REGISTRY_PRIVATE_KEY=/.test(dry.out));
  assert.ok(dry.out.includes(`BASE_RPCS='${r.rpcs.join(",")}'`), dry.out);
  assert.ok(!dry.all.includes(keyText.replace(/^0x/, "")), "the operator key is never printed");
  const ap = await cli(["host", "install", "--dir", dir, "--unit-dir", units, "--apply"]);
  assert.equal(ap.code, 0, ap.all);
  assert.equal((fs.statSync(path.join(dir, "supervisor.env")).mode & 0o777).toString(8), "600");
  assert.ok(!fs.readFileSync(path.join(dir, "supervisor.env"), "utf8").includes(keyText.replace(/^0x/, "")), "the key stays in operator.key");
  const run = await cli(["host", "run", "--dir", dir, "--component", "supervisor", "--dry-run"]);
  assert.equal(run.code, 0, run.all);
  assert.match(run.out, /SECRET='<redacted>'/); assert.match(run.out, /REGISTRY_PRIVATE_KEY_FILE=/);
  const chk = await cli(["host", "check", "--dir", dir, "--unit-dir", units, "--json"]);
  assert.ok([3, 4].includes(chk.code), `check exits 3 (not ready) or 4 (unknown), never 0: ${chk.code}\n${chk.all}`);
  let rows; try { rows = JSON.parse(chk.out.slice(chk.out.indexOf("{"))).rows; } catch { assert.fail(`check --json printed no JSON:\n${chk.all}`); }
  const att = rows.find((x) => x.item === "control attestation");
  assert.equal(att.status, "unknown", "a configured attestation URL is UNKNOWN, not ready");
  assert.equal(rows.find((x) => x.item === "installed units").status, "ready", "the installed environment matches the plan exactly");
  const bad = await cli(["host", "frobnicate"]);
  assert.notEqual(bad.code, 0); assert.match(bad.all, /independent mode offers host init \| build \| install \| run \| check \| referral/);
  noEnclave();
});

test("dispatch: custody, secrets and signer reach their commands; secrets is the owner read, stopped at the vault pin; --signer-mode needs --independent", T, async () => {
  // secrets is routed to the owner read (cli/custody-independent.mjs cmdSecretsIndependent), never the hosted relay: these rig
  // pins carry no secretVaultV2, so it stops at the exact pin refusal before any chain read, signature or custodian request
  const sec = await cli(["secrets", "ls", "0x" + "11".repeat(32)]);
  assert.notEqual(sec.code, 0);
  assert.match(sec.all, /independent custody needs a pinned EnclaveSecretVaultV2: a reviewed --profile, or --contract-pins naming secretVaultV2/);
  assert.doesNotMatch(sec.all, /not available in independent mode/);
  noEnclave();
  // custody runs its own pin check (these rig pins carry no secretVaultV2), not the old blanket refusal
  const cus = await cli(["custody", "status", "0x" + "11".repeat(32)]);
  assert.notEqual(cus.code, 0); assert.doesNotMatch(cus.all, /not available in independent mode/);
  const sig = await cli(["signer", "list"]);
  assert.equal(sig.code, 0, sig.all);
  const hosted = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "--signer-mode", "sign", "ls"], { cwd: tmp, env: { PATH: process.env.PATH, HOME: tmp, NODE_OPTIONS: `--import=${GUARD}`,
      ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_API_BASE: r.apiOrigin } });
    let all = ""; p.stdout.on("data", (d) => (all += d)); p.stderr.on("data", (d) => (all += d)); p.on("close", (code) => resolve({ code, all }));
  });
  // r8 (P8): the CLI's one stray-flag refusal names EVERY independent-only flag, now including --chain-verifier
  // (cli/enclave.mjs configureIndependent); the exact full line, anchored, still proves --signer-mode alone is refused
  assert.notEqual(hosted.code, 0);
  assert.match(hosted.all, /^error: --quorum, --confirmations, --max-block-age, --usdc-token, --max-fee-gwei, --signer-mode and --chain-verifier apply to independent mode: add --independent$/m);
  noEnclave();
});
