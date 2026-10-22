// Independent secrets CRUD and custody through the REAL CLI (cli/enclave.mjs, or the built bundle: ENCLAVE_CLI_ENTRY) as a
// subprocess: owner reads go to REAL custodians (createCustodianV2 behind the real router) over HTTPS at the endpoints
// the committee names on chain, writes through the CLI's quorum writer to the REAL EnclaveSecretVaultV2 on anvil
// (test/helpers/owner-read-cli-world.mjs). Every CLI process runs under the network guard: only loopback is reachable.
//   1  full CRUD with the owner-read opt-in            2  the opt-in is off by default and changed explicitly
//   3  two editors on one key (A pending, B reads the old revision): B is refused before signing or reverts at the
//      vault's revision guard; nothing is lost; the re-run merges
//   4  a ledger transfer: every owner read refused until the new owner claims and opts in
//   5  failures: one custodian down still reads (t = 2 of 3); two down fail closed; paused refuses
//   6  ONE invocation: an external signer's --from ADDRESS (before `custody`) AND custody migrate --from FILE
// Values are asserted absent from every output except `secrets ls --show`. Synthetic custodians, no SEV-SNP hardware.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hexToBytes, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as v2 from "../custody/v2/protocol.mjs";
import { VAULT_V2_ABI } from "../custody/v2/chain.mjs";
import { ownerReadCliWorld, haveTools, CHAIN } from "./helpers/owner-read-cli-world.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.ENCLAVE_CLI_ENTRY ? path.resolve(process.env.ENCLAVE_CLI_ENTRY) : path.join(REPO, "cli", "enclave.mjs");
const GUARD = pathToFileURL(path.join(REPO, "test/helpers/cli-network-guard.mjs")).href;
const options = { skip: !haveTools && "needs anvil and openssl", timeout: 300000 };
// anvil's published dev account #5: the external signer's wallet (a SECOND anvil plays the wallet)
const SIGNER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const SNP = { v: 1, appId: "a7".repeat(32), images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "cd".repeat(32) }],
              minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
let W, tmp, netLog, rules;
before(async () => {
  if (!haveTools) return;
  W = await ownerReadCliWorld();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-secrets-"));
  netLog = path.join(tmp, "net.log"); fs.writeFileSync(netLog, "");
  rules = path.join(tmp, "snp.json"); fs.writeFileSync(rules, JSON.stringify(SNP));
});
after(() => { W?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
const file = (name, content) => { const p = path.join(tmp, name); fs.writeFileSync(p, content, { mode: 0o600 }); return p; };

function cli(key, args, { pre = [], rpcs = null, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "--independent", "--contract-pins", W.pins, "--usdc-token", "0x" + "c3".repeat(20), "--rpc", (rpcs || W.rpcs).join(","),
      "--confirmations", "1", "--max-block-age", "600", "--max-fee-gwei", "1000", ...pre, ...args],
      { env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ...(key ? { ENCLAVE_KEY: key } : {}), NODE_EXTRA_CA_CERTS: W.caFile,
        NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => p.kill("SIGKILL"), 240000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err, all: out + err }); });
  });
}
const ok = (r) => assert.equal(r.code, 0, r.all);
const vaultState = async (id) => {
  const [owner, policyRev, secretRev, committeeId, paused, ruleBytes] = await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "policyOf", args: [id] });
  const [, , data] = await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "bundleOf", args: [id] });
  return { owner: owner.toLowerCase(), policyRev, secretRev, committeeId, paused, rules: ruleBytes, data };
};
/** the stored values, opened with the committee's known secret (the test's truth, independent of the CLI) */
const stored = async (id) => {
  const s = await vaultState(id);
  if (s.data === "0x") return {};
  return v2.decryptBundle({ S: v2.parseBundle(hexToBytes(s.data)).Rp.multiply(W.a0),
    label: v2.labelOf({ chainId: CHAIN, vault: W.vault, id, secretRev: s.secretRev, committeeId: W.indCid }), bundle: hexToBytes(s.data) }).env;
};
const noNet = () => assert.equal(fs.readFileSync(netLog, "utf8").trim(), "", "no non-loopback connection was attempted");

test("1: full CRUD through the real CLI: create with --owner-read on, ls names, ls --show, --json, set merges, rm removes one, --replace, clear --yes", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner.address);
  let r = await cli(owner.key, ["custody", "set", id, "API_KEY=alpha-secret", "DB_URL=postgres://beta", "--rules", rules, "--committee", W.indCid, "--no-config", "--owner-read", "on"]);
  ok(r); assert.match(r.out, /owner read: ENABLED/); assert.ok(!/alpha-secret|beta/.test(r.all), "values are never printed by set");
  r = await cli(owner.key, ["secrets", "ls", id]);
  ok(r); assert.match(r.out, /API_KEY {2}\(12 bytes; --show to reveal\)/); assert.match(r.out, /DB_URL/); assert.ok(!/alpha-secret|beta/.test(r.all));
  r = await cli(owner.key, ["secrets", "ls", id, "--show"]);
  ok(r); assert.match(r.out, /API_KEY=.?alpha-secret/); assert.match(r.out, /DB_URL=.?postgres:\/\/beta/);
  r = await cli(owner.key, ["--json", "secrets", "ls", id]);
  ok(r); const j = JSON.parse(r.out.slice(r.out.indexOf("{")));
  assert.deepEqual(j.names.sort(), ["API_KEY", "DB_URL"]); assert.ok(!JSON.stringify(j).includes("alpha-secret"), "--json without --show prints names only");
  ok(await cli(owner.key, ["secrets", "set", id, "EXTRA=gamma", "--no-config"]));
  assert.deepEqual(await stored(id), { API_KEY: "alpha-secret", DB_URL: "postgres://beta", EXTRA: "gamma" }, "set KEY merges");
  ok(await cli(owner.key, ["secrets", "rm", id, "API_KEY", "--no-config"]));
  assert.deepEqual(await stored(id), { DB_URL: "postgres://beta", EXTRA: "gamma" }, "rm removes exactly that key");
  ok(await cli(owner.key, ["secrets", "set", id, "ONLY=delta", "--replace", "--no-config"]));
  assert.deepEqual(await stored(id), { ONLY: "delta" });
  r = await cli(owner.key, ["secrets", "clear", id, "--no-config"]);
  assert.notEqual(r.code, 0); assert.match(r.all, /re-run with --yes/);
  ok(await cli(owner.key, ["secrets", "clear", id, "--no-config"], { pre: ["--yes"] }));   // the global --yes, written before the command, confirms
  assert.deepEqual(await stored(id), {});
  noNet();
});

test("2: owner read is off by default (secrets ls refused, nothing released); --owner-read on is an explicit, visible policy change", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner.address);
  let r = await cli(owner.key, ["custody", "set", id, "K=v-default", "--rules", rules, "--committee", W.indCid, "--no-config"]);
  ok(r); assert.match(r.out, /owner read: disabled/);
  const hits0 = W.custodians.reduce((a, c) => a + c.hits, 0);
  r = await cli(owner.key, ["secrets", "ls", id]);
  assert.notEqual(r.code, 0); assert.match(r.all, /do not allow an owner read \(ownerRead is not true\)/);
  assert.equal(W.custodians.reduce((a, c) => a + c.hits, 0), hits0, "refused before any custodian was asked");
  const before = await vaultState(id);
  r = await cli(owner.key, ["custody", "set", id, "K=v-default", "--owner-read", "on", "--no-config"]);
  ok(r); assert.match(r.out, /owner read: ENABLED/);
  assert.notEqual((await vaultState(id)).rules, before.rules, "the rules now carry the opt-in");
  r = await cli(owner.key, ["secrets", "ls", id, "--show"]);
  ok(r); assert.match(r.out, /K=.?v-default/);
});

test("3: two editors on one key: the stale write is refused (before signing, or at the vault's revision guard), the other's change survives, and the re-run merges", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner.address);
  ok(await cli(owner.key, ["custody", "set", id, "BASE=1", "--rules", rules, "--committee", W.indCid, "--no-config", "--owner-read", "on"]));
  // The same owner key on two machines: editor A's write is PENDING (mining paused) when editor B reads revision N and
  // signs with the next pending nonce; both are mined in one block in nonce order, so B's write expects a revision A
  // already replaced.
  const rev0 = (await vaultState(id)).secretRev, nonce0 = await W.pub.getTransactionCount({ address: owner.address });
  for (const m of W.modes) { m.value = "delay-send"; m.delayMs = 0; m.held = 0; }   // counts broadcasts, forwards at once
  // the world mines on a 1 s interval (automine off): stopping the interval leaves broadcasts pending
  await W.pub.request({ method: "evm_setIntervalMining", params: [0] });
  let rb;
  try {
    const a = cli(owner.key, ["secrets", "set", id, "FROM_A=a", "--no-config"]);
    const waitPending = async (n, what) => {
      const t0 = Date.now();
      while (await W.pub.getTransactionCount({ address: owner.address, blockTag: "pending" }) < nonce0 + n) {
        if (Date.now() - t0 > 90000) throw new Error(`timed out waiting for ${what}`);
        await new Promise((ok_) => setTimeout(ok_, 200));
      }
    };
    await waitPending(1, "A's broadcast");
    const b = cli(owner.key, ["secrets", "set", id, "FROM_B=b", "--no-config"]);
    // B either signs (nonce0 + 1, against revision rev0) and broadcasts, or its own checks refuse before signing
    const bDone = b.then((x) => { rb = x; });
    const t0 = Date.now();
    while (rb === undefined && await W.pub.getTransactionCount({ address: owner.address, blockTag: "pending" }) < nonce0 + 2 && Date.now() - t0 < 90000) await new Promise((ok_) => setTimeout(ok_, 200));
    await W.pub.request({ method: "evm_setIntervalMining", params: [1] });
    ok(await a);
    await bDone;
  } finally {
    await W.pub.request({ method: "evm_setIntervalMining", params: [1] });
    for (const m of W.modes) m.value = "ok";
  }
  assert.notEqual(rb.code, 0, "B is refused, not silently overwriting A");
  const bHash = (rb.all.match(/transaction reverted: (0x[0-9a-f]{64})/) || [])[1];
  if (bHash) {
    // B signed against revision rev0 and was mined after A: the vault's revision guard reverted it
    const rc = await W.pub.getTransactionReceipt({ hash: bHash }), tx = await W.pub.getTransaction({ hash: bHash });
    assert.equal(rc.status, "reverted"); assert.equal(tx.nonce, nonce0 + 1, "B used the next nonce once");
    const why = await W.pub.call({ account: tx.from, to: tx.to, data: tx.input, blockNumber: rc.blockNumber }).then(() => "", (e) => String(e?.message || e) + JSON.stringify(e?.cause?.data ?? e?.data ?? ""));
    assert.match(why, new RegExp(toFunctionSelector("StaleRevision(uint64,uint64)").slice(2) + "|StaleRevision"), "the revert is the vault's StaleRevision guard: " + why.slice(0, 300));
    console.log("# test 3 path: B signed against the stale revision and the vault reverted it (StaleRevision)");
  } else {
    // B's simulation already saw A's pending write: refused before signing, nothing sent
    assert.match(rb.all, /refusing to send: the transaction would revert|StaleRevision|gas estimate.*revert/s, rb.all);
    assert.equal(await W.pub.getTransactionCount({ address: owner.address }), nonce0 + 1, "B sent nothing");
    console.log("# test 3 path: B refused before signing (its simulation saw A's pending write)");
  }
  const s = await vaultState(id);
  assert.equal(s.secretRev, rev0 + 1n, "exactly one write landed");
  assert.deepEqual(await stored(id), { BASE: "1", FROM_A: "a" }, "A's change survives; B's stale write changed nothing");
  ok(await cli(owner.key, ["secrets", "set", id, "FROM_B=b", "--no-config"]));
  assert.deepEqual(await stored(id), { BASE: "1", FROM_A: "a", FROM_B: "b" }, "B's re-run merges onto A's");
});

test("4: a ledger transfer: the old and the new owner are refused every owner read until the new owner claims and opts in", options, async () => {
  const owner = await W.acct(), next = await W.acct(), id = await W.dep(owner.address);
  ok(await cli(owner.key, ["custody", "set", id, "OLD=secret-old", "--rules", rules, "--committee", W.indCid, "--no-config", "--owner-read", "on"]));
  await W.setLedgerOwner(id, next.address);
  let r = await cli(owner.key, ["secrets", "ls", id]);
  assert.notEqual(r.code, 0); assert.match(r.all, /the ledger moved this deployment/);
  r = await cli(next.key, ["secrets", "ls", id]);
  assert.notEqual(r.code, 0); assert.match(r.all, /the ledger moved this deployment .*custody claim/);
  ok(await cli(next.key, ["custody", "claim", id]));
  const c = await vaultState(id);
  assert.deepEqual([c.owner, c.paused, c.data], [next.address.toLowerCase(), true, "0x"], "claimed: paused, the old bundle destroyed");
  ok(await cli(next.key, ["custody", "set", id, "NEW=secret-new", "--rules", rules, "--no-config", "--owner-read", "on"]));
  ok(await cli(next.key, ["custody", "resume", id]));
  r = await cli(next.key, ["secrets", "ls", id, "--show"]);
  ok(r); assert.match(r.out, /NEW=.?secret-new/); assert.ok(!r.all.includes("secret-old"));
});

test("5: failures: one custodian down still reads (t = 2 of 3); two down fail closed with no value; paused refuses", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner.address);
  ok(await cli(owner.key, ["custody", "set", id, "K=fail-case", "--rules", rules, "--committee", W.indCid, "--no-config", "--owner-read", "on"]));
  W.custodians[0].up = false;
  try {
    let r = await cli(owner.key, ["secrets", "ls", id, "--show"]);
    ok(r); assert.match(r.out, /K=.?fail-case/); assert.match(r.out, /read from 2 custodian share\(s\)/);
    W.custodians[1].up = false;
    r = await cli(owner.key, ["secrets", "ls", id, "--show"]);
    assert.notEqual(r.code, 0); assert.match(r.all, /insufficient custodians|no custodian issued/); assert.ok(!r.all.includes("fail-case"));
  } finally { W.custodians[0].up = true; W.custodians[1].up = true; }
  ok(await cli(owner.key, ["custody", "pause", id]));
  let r = await cli(owner.key, ["secrets", "ls", id]);
  assert.notEqual(r.code, 0); assert.match(r.all, /paused/);
  ok(await cli(owner.key, ["custody", "resume", id]));
  ok(await cli(owner.key, ["secrets", "ls", id]));
});

test("6: one invocation carries the signer's --from ADDRESS and custody migrate --from FILE; nothing private is printed", options, async () => {
  // the wallet: a second anvil holding the dev key, reached ONLY as --signer (the CLI never sees the key)
  const { spawn: sp } = await import("node:child_process");
  const port = 30000 + Math.floor(Math.random() * 20000);
  const wallet = sp("anvil", ["--port", String(port), "--silent", "--chain-id", String(CHAIN)], { stdio: "ignore" });
  try {
    const signerUrl = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) { try { await fetch(signerUrl, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); break; } catch { await new Promise((ok_) => setTimeout(ok_, 100)); } }
    const from = privateKeyToAccount(SIGNER_KEY).address;
    await W.fund(from);
    const id = await W.dep(from);
    const pass = file("pass.txt", "correct horse battery staple\n"), sealed = path.join(tmp, "values.enc");
    ok(await cli(null, ["custody", "seal-export", "--id", id, "--in", file("values.env", "MIG_A=migrated-alpha\nMIG_B=migrated-beta\n"), "--out", sealed, "--passphrase-file", pass]));
    // the scoped --from after `custody migrate` is ONE: a second is refused precisely, before anything is read or sent
    let r = await cli(null, ["custody", "migrate", id, "--from", sealed, "--signer", signerUrl, "--from", from]);
    assert.notEqual(r.code, 0); assert.match(r.all, /`custody migrate` takes ONE --from after the command: the export file it migrates/);
    // the established placement: the signer's wallet before `custody`, the export file after `custody migrate`
    r = await cli(null, ["custody", "migrate", id, "--from", sealed, "--passphrase-file", pass, "--rules", rules, "--committee", W.indCid, "--no-config", "--owner-read", "on"],
      { pre: ["--signer", signerUrl, "--from", from] });
    ok(r);
    assert.match(r.out, /migrating 2 value\(s\) from .*values\.enc: MIG_A, MIG_B/);
    assert.match(r.all, /read back at agreed block/);
    for (const secret of ["migrated-alpha", "migrated-beta", SIGNER_KEY.slice(2), "correct horse"]) assert.ok(!r.all.includes(secret), "nothing private is printed");
    const s = await vaultState(id);
    assert.equal(s.owner, from.toLowerCase(), "the signer's wallet wrote the policy");
    assert.deepEqual(await stored(id), { MIG_A: "migrated-alpha", MIG_B: "migrated-beta" });
    // and the owner read works for that wallet through the signer too (EIP-712 OwnerRead signed by the wallet)
    r = await cli(null, ["secrets", "ls", id], { pre: ["--signer", signerUrl, "--from", from] });
    ok(r); assert.match(r.out, /MIG_A/); assert.ok(!r.all.includes("migrated-alpha"));
  } finally { try { wallet.kill("SIGKILL"); } catch {} }
});
