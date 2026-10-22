// `enclave --independent … secrets ls|set|rm|clear` and `custody set --owner-read on|off` (cli/custody-independent.mjs),
// in-process with the CLI's REAL quorum chain and writer, against the REAL vault on anvil and REAL custodians behind the
// real router (test/helpers/owner-read-rig.mjs). Synthetic custodians (no SEV-SNP hardware).
//   run: node --test --test-concurrency=1 test/custody-secrets-cli-independent.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hexToBytes, bytesToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as v2 from "../custody/v2/protocol.mjs";
import { VAULT_V2_ABI } from "../custody/v2/chain.mjs";
import { canonicalRules } from "../custody/rules.mjs";
import { cmdCustodyIndependent, cmdSecretsIndependent } from "../cli/custody-independent.mjs";
import { ownerReadWorld, haveAnvil, CHAIN } from "./helpers/owner-read-rig.mjs";

const options = { skip: !haveAnvil && "needs Foundry's anvil", timeout: 300000 };
let W, Q;
before(async () => { if (haveAnvil) { W = await ownerReadWorld(); Q = await W.quorum(); } });
after(() => W?.stop());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "custody-secrets-cli-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const file = (name, content, mode = 0o600) => { const p = path.join(tmp, name); fs.writeFileSync(p, content, { mode }); return p; };
const SNP = { v: 1, appId: "a7".repeat(32), images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "cd".repeat(32) }],
              minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
function flags(rest, { bool = [], val = [] }) {
  const f = { _: [] };
  for (let i = 0; i < rest.length; i++) { const a = rest[i];
    if (bool.includes(a)) f[a.slice(2)] = true; else if (val.includes(a)) f[a.slice(2)] = rest[++i]; else if (a.startsWith("--")) f[a.slice(2)] = true; else f._.push(a); }
  return f;
}
const kv = (pairs, f) => { const set = {}; const add = (l) => { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l); if (!m) throw new Error(`not KEY=VALUE: ${l}`); set[m[1]] = m[2]; };
  for (const p of pairs) add(p); if (f) for (const l of fs.readFileSync(f, "utf8").split("\n")) if (l.trim()) add(l.trim()); return set; };
async function run(cmd, key, args, { send = Q.send, json = false } = {}) {
  const lines = [], out = { json: null };
  await (cmd === "secrets" ? cmdSecretsIndependent : cmdCustodyIndependent)([...args], { flags, say: (m) => lines.push(m), jout: (o) => { out.json = o; }, json,
    short: (x) => x.slice(0, 10), warn: () => {}, readFile: (p) => fs.readFileSync(p, "utf8"), env: {}, loadKey: () => key, secretsKv: kv,
    chain: Q.chain, trust: Q.trust, send, post: W.post });
  return { lines, json: out.json, text: lines.join("\n") };
}
const vaultState = async (id) => {
  const [owner, policyRev, secretRev, committeeId, paused, rules] = await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "policyOf", args: [id] });
  const [, , data] = await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "bundleOf", args: [id] });
  return { owner: owner.toLowerCase(), policyRev, secretRev, paused, rules, data };
};
const opened = (id, secretRev, data) => v2.decryptBundle({ S: v2.parseBundle(hexToBytes(data)).Rp.multiply(W.a0),
  label: v2.labelOf({ chainId: CHAIN, vault: W.vault, id, secretRev, committeeId: W.indCid }), bundle: hexToBytes(data) }).env;

test("full CRUD from the CLI: create with --owner-read on (stated), ls names, ls --show values, set KEY merges, rm KEY removes only it, set --replace, clear", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner), rules = file("snp.json", JSON.stringify(SNP));
  let r = await run("custody", owner, ["set", id, "A=1", "B=two", "--rules", rules, "--committee", W.indCid, "--no-config", "--owner-read", "on"]);
  assert.match(r.text, /owner read: ENABLED/);
  assert.equal((await run("custody", owner, ["status", id], { json: true })).json.ownerRead, true);
  r = await run("secrets", owner, ["ls", id]);
  assert.match(r.text, /A {2}\(1 bytes; --show to reveal\)/); assert.match(r.text, /B {2}\(3 bytes/); assert.ok(!r.text.includes("two"), "no value without --show");
  r = await run("secrets", owner, ["ls", id, "--show"]);
  assert.match(r.text, /^A="1"$/m); assert.match(r.text, /^B="two"$/m);
  r = await run("secrets", owner, ["set", id, "C=3", "B=2"]);
  assert.match(r.text, /stored; 3 value\(s\) now .*: A, B, C/); assert.ok(!r.text.includes("=2") && !r.text.includes('"2"'), "set prints names, never values");
  let s = await vaultState(id);
  assert.deepEqual(opened(id, s.secretRev, s.data), { A: "1", B: "2", C: "3" }, "merged: A kept, B replaced, C added");
  assert.equal(s.rules, bytesToHex(canonicalRules({ ...SNP, ownerRead: true })), "the rules are untouched by a secrets edit");
  r = await run("secrets", owner, ["rm", id, "A"]);
  s = await vaultState(id);
  assert.deepEqual(opened(id, s.secretRev, s.data), { B: "2", C: "3" }, "only A removed");
  await assert.rejects(run("secrets", owner, ["rm", id, "NOPE"]), /not stored: NOPE/);
  const j = await run("secrets", owner, ["ls", id], { json: true });
  assert.deepEqual(j.json.names, ["B", "C"]); assert.equal(j.json.env, undefined);
  r = await run("secrets", owner, ["set", id, "ONLY=x", "--replace", "--no-config"]);
  s = await vaultState(id);
  assert.deepEqual(opened(id, s.secretRev, s.data), { ONLY: "x" }, "--replace writes exactly the given map");
  await assert.rejects(run("secrets", owner, ["clear", id]), /re-run with --yes/);
  await run("secrets", owner, ["clear", id, "--yes"]);
  s = await vaultState(id);
  assert.equal(s.data, "0x");
  await assert.rejects(run("secrets", owner, ["ls", id]), /no secrets are stored/);
});

test("ownerRead off (the default): secrets ls is refused; --owner-read on later is an explicit, visible policy change", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner), rules = file("snp2.json", JSON.stringify(SNP));
  const r = await run("custody", owner, ["set", id, "A=1", "--rules", rules, "--committee", W.indCid, "--no-config"]);
  assert.match(r.text, /owner read: disabled/);
  const before = await vaultState(id);
  assert.equal(before.rules, bytesToHex(canonicalRules(SNP)), "no ownerRead key: the old bytes exactly");
  assert.equal((await run("custody", owner, ["status", id], { json: true })).json.ownerRead, false);
  await assert.rejects(run("secrets", owner, ["ls", id]), /do not allow an owner read/);
  await assert.rejects(run("secrets", owner, ["set", id, "B=2"]), /do not allow an owner read/);
  // a later explicit opt-in re-encodes the rules with the key, and only then can the owner read
  await run("custody", owner, ["set", id, "A=1", "--no-config", "--owner-read", "on"]);
  assert.equal((await vaultState(id)).rules, bytesToHex(canonicalRules({ ...SNP, ownerRead: true })));
  assert.deepEqual((await run("secrets", owner, ["ls", id], { json: true })).json.names, ["A"]);
  // and an explicit opt-out removes the capability again
  await run("custody", owner, ["set", id, "A=1", "--no-config", "--owner-read", "off"]);
  await assert.rejects(run("secrets", owner, ["ls", id]), /do not allow an owner read/);
});

test("two CLI editors: the second's write is refused at the vault's revision guard, and its re-run merges onto the first's change", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner), rules = file("snp3.json", JSON.stringify(SNP));
  await run("custody", owner, ["set", id, "A=1", "--rules", rules, "--committee", W.indCid, "--no-config", "--owner-read", "on"]);
  // editor 2 reads; before it sends, editor 1 completes its own edit
  const racing = async (acct, call) => { await run("secrets", owner, ["set", id, "B=2"]); return Q.send(acct, call); };
  await assert.rejects(run("secrets", owner, ["set", id, "C=3"], { send: racing }), /would revert/);
  let s = await vaultState(id);
  assert.deepEqual(opened(id, s.secretRev, s.data), { A: "1", B: "2" }, "editor 1's change stands; editor 2 wrote nothing");
  await run("secrets", owner, ["set", id, "C=3"]);
  s = await vaultState(id);
  assert.deepEqual(opened(id, s.secretRev, s.data), { A: "1", B: "2", C: "3" }, "nothing was lost");
});

test("paused, transferred, another wallet, a separate gas payer", options, async () => {
  const owner = await W.acct(), stranger = await W.acct(), id = await W.dep(owner), rules = file("snp4.json", JSON.stringify(SNP));
  await run("custody", owner, ["set", id, "A=1", "--rules", rules, "--committee", W.indCid, "--no-config", "--owner-read", "on"]);
  await assert.rejects(run("secrets", stranger, ["ls", id]), /belongs to 0x[0-9a-f]{40}; this wallet is/);
  // a separate payer: the owner signs, the payer pays (the merge still reads first)
  const payerKey = generatePrivateKey(), payer = privateKeyToAccount(payerKey); await W.fund(payer);
  const r = await run("secrets", owner, ["set", id, "P=paid", "--payer-key", file("payer.key", payerKey)]);
  assert.match(r.text, /stored; 2 value\(s\) now/);
  // paused: no read (owner included), but a clear still works
  await run("custody", owner, ["pause", id]);
  await assert.rejects(run("secrets", owner, ["ls", id]), /paused/);
  await assert.rejects(run("secrets", owner, ["rm", id, "A"]), /paused/);
  await run("custody", owner, ["resume", id]);
  assert.deepEqual((await run("secrets", owner, ["ls", id], { json: true })).json.names, ["A", "P"]);
  // transfer: the ledger moves the deployment; the old owner can neither read nor edit
  await W.setLedgerOwner(id, stranger.address);
  await assert.rejects(run("secrets", owner, ["ls", id]), /the ledger moved this deployment/);
  await assert.rejects(run("secrets", stranger, ["ls", id]), /the ledger moved this deployment/);
});
