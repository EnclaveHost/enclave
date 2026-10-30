// STATIC checks of what prepare.py wrote (run `python3 prepare.py [--accept-unpinned]` first). Text only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const STAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const UF = join(STAGE, "..");
const SOURCE = join(UF, "..", "source");
const PIN = "457e86472adce2f1fdd2dfa82759578a56f7d72f0c5e5ee18e53999a26d0682d";
const OWNER_PIN = "a1c98a799799217bdd3804210f000ff951c60038401448e19e875952157e5301";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const src = readFileSync(join(SOURCE, "relay", "sessions.mjs"), "utf8");
const owner = readFileSync(join(UF, "relay-owner-r2", "patched", "relay", "sessions.mjs"), "utf8");
const patched = readFileSync(join(STAGE, "patched", "relay", "sessions.mjs"), "utf8");
const MINE = /^\/\/ >>> host-queue-r1[^\n]*\n(?:(?!\/\/ <<< host-queue-r1\n)[^\n]*\n)*?\/\/ <<< host-queue-r1\n/gm;
const FUNDING = /^[ \t]*\/\/ >>> funding-r2[^\n]*\n(?:(?![ \t]*\/\/ >>> )[^\n]*\n)*?[ \t]*\/\/ <<< funding-r2\n/gm;

function originalClass(text) {
  const s = text.indexOf("export class TxQueue {\n");
  const e = text.indexOf("\n}\n", s) + 3;
  assert.ok(s > 0 && e > s);
  return text.slice(s, e);
}

test("inputs: the pinned original, and relay-owner-r2's reviewed copy is that original plus funding-r2 blocks", () => {
  assert.equal(sha(readFileSync(join(SOURCE, "relay", "sessions.mjs"))), PIN);
  assert.equal(sha(Buffer.from(owner)), OWNER_PIN);
  assert.equal(owner.replace(FUNDING, ""), src);
  assert.ok(!src.includes("host-queue-r1") && !owner.includes("host-queue-r1"));
});

test("exactly two marked blocks; restoring the ORIGINAL TxQueue class from the pinned source gives relay-owner-r2's copy", () => {
  const blocks = patched.match(MINE) ?? [];
  assert.equal(blocks.length, 2, "header + TxQueue");
  assert.ok(blocks[0].startsWith("// >>> host-queue-r1 PATCHED COPY"));
  assert.ok(blocks[1].startsWith("// >>> host-queue-r1 TxQueue"));
  let i = 0;
  const restored = patched.replace(MINE, () => (i++ === 0 ? "" : originalClass(src)));
  assert.equal(restored, owner);
  assert.equal(restored.replace(FUNDING, ""), src, "and from there, the pinned original");
});

test("the replacement keeps the host's construction, lane, pending-nonce source and fee cap; adds no key or signer", () => {
  const block = (patched.match(MINE) ?? [])[1];
  assert.equal(patched.split("  const queue = new TxQueue({ pc, wc, account, journal, log, alert, maxTipWei });\n").length - 1, 1);
  for (const need of [
    "    const p = this.chain.then(() => this._send(item));\n    this.chain = p.catch(() => {});\n",
    'const onChain = await this.pc.getTransactionCount({ address: this.account.address, blockTag: "pending" });',
    "let fees = await cappedFees(this.pc, this.maxTipWei);",
    "maxFeePerGas: fees.maxFeePerGas * 125n / 100n + 1n",
    "hash = await this.wc.sendTransaction({ account: this.account, chain: this.wc.chain, to, data, gas, nonce,",
  ]) assert.equal(block.split(need).length - 1, 1, need);
  for (const banned of ["privateKey", "signTransaction", "sendRawTransaction", "createWalletClient", "waitForTransactionReceipt",
    "setInterval", "while (true)", "for (;;)"]) assert.ok(!block.includes(banned), `the block mentions ${banned}`);
  // _done is reached only with a receipt _canonical returned
  const calls = block.match(/this\._done\(rec, [^)]*\)/g);
  assert.deepEqual(calls, ["this._done(rec, mined)", "this._done(rec, seen.receipt)", "this._done(rec, o.receipt)"]);
  assert.ok(block.includes("return (await this._observe(hashes)).receipt ?? null;"));
});

test("the funding route and ABI are relay-owner-r2's patched copies byte for byte; imports resolve to the read-only source", () => {
  for (const f of ["funding-route.mjs", "funding-abi.mjs"])
    assert.equal(readFileSync(join(STAGE, "patched", "relay", f), "utf8"), readFileSync(join(UF, "relay-owner-r2", "patched", "relay", f), "utf8"), f);
  for (const f of ["sessions-abi.mjs", "snp-verify.mjs"])
    assert.equal(realpathSync(join(STAGE, "patched", "relay", f)), realpathSync(join(SOURCE, "relay", f)));
  assert.equal(realpathSync(join(STAGE, "patched", "node_modules")), realpathSync(join(SOURCE, "node_modules")));
  assert.ok(!readlinkSync(join(STAGE, "patched", "node_modules")).startsWith("/"), "relative link");
});

test("the manifest records the pins, the replaced bytes and every output", () => {
  const m = JSON.parse(readFileSync(join(STAGE, "generated", "PREPARE-MANIFEST.json"), "utf8"));
  assert.equal(m.source["relay/sessions.mjs"], PIN);
  assert.equal(m.inputs["relay-owner-r2/patched/relay/sessions.mjs"], OWNER_PIN);
  assert.equal(m.replaced["TxQueue (original class bytes)"], sha(Buffer.from(originalClass(src))));
  assert.equal(m.outputs["patched/relay/sessions.mjs"], sha(readFileSync(join(STAGE, "patched", "relay", "sessions.mjs"))));
});
