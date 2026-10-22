// Regression for the proposed LeaseReader chain-id memo (proposed/lease-reader-chainid-memo.patch), LOCAL, mock clients only.
// What it must show:
//   1. the ORIGINAL reader (src-6bef, the 6bef/cfb6 source) sends eth_chainId to EVERY RPC on EVERY agreed() call
//      (the redundancy; negative control);
//   2. the PATCHED reader asks each client's chain id once, then only its head, and the answer is unchanged;
//   3. a wrong chain is still refused on first use (fail closed), and a client that turns wrong is refused at the recheck;
//   4. the 2-distinct-peer agreement rule is unchanged (one client alone never answers).
//   READER=original|patched node --test test/chainid-memo.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const which = process.env.READER || "patched";
// EXPECT=patched with READER=original is the negative control: the original must FAIL the once-per-client check
const expect = process.env.EXPECT || which;
const { LeaseReader } = await import(which === "original" ? "../src-6bef/network/lease-reader.mjs" : "../proposed-tree/network/lease-reader.mjs");
const BOOK = "0x" + "11".repeat(20);

function client(name, { chainId = 8453, head = 1000n } = {}) {
  const c = { name, chainId, calls: { chainId: 0, head: 0, block: 0 } };
  c.getChainId = async () => { c.calls.chainId++; return c.chainId; };
  c.getBlockNumber = async () => { c.calls.head++; return head; };
  c.getBlock = async ({ blockNumber }) => { c.calls.block++; return { number: blockNumber, hash: "0x" + "ab".repeat(32), timestamp: BigInt(Math.floor(Date.now() / 1000)) }; };
  return c;
}
const reader = (clients) => new LeaseReader({ clients, addressBook: BOOK, confirmations: 1, deadlineMs: 5000 });
const read = async () => ({ value: 42 });

test("agreed() answers identically; chain id requests per call", async () => {
  const cs = [client("a"), client("b"), client("c")];
  const r = reader(cs);
  for (let i = 0; i < 3; i++) assert.equal((await r.agreed(read)).value, 42);
  const asked = cs.map((c) => c.calls.chainId);
  if (expect === "original") assert.ok(asked.every((n) => n === 3), `original asks every call: ${asked}`);
  else assert.deepEqual(asked, [1, 1, 1], "patched: once per client");
  assert.ok(cs.every((c) => c.calls.head === 3), "the head is still read on every call");
});

test("a wrong chain is refused on first use (it never counts as a peer)", async () => {
  const cs = [client("a"), client("b", { chainId: 1 }), client("c", { chainId: 1 })];
  await assert.rejects(reader(cs).agreed(read), /quorum/);                // one right peer alone never answers
});

test("a client that turns wrong is refused at the recheck", async () => {
  const cs = [client("a"), client("b"), client("c")];
  const r = reader(cs);
  await r.agreed(read);
  cs[1].chainId = 1; cs[2].chainId = 1;
  if (which === "patched") r.chainRecheckMs = 0;                         // the recheck is due
  await assert.rejects(r.agreed(read), /quorum/);
});
