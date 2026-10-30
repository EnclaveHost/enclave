// The adapter's ABI fragments are the compiled contracts' own (forge out of the same tree), so the pinned client's readContract
// decodes exactly the live schema-16 row, the schema getter and the admin AddressBook entry; the event topics are the ones
// relay/lease-generation.mjs (and the native v3 filter) use.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { keccak256, toHex } from "viem";
import { CLAIMED, RENEWED, RELEASED } from "../relay/lease-generation.mjs";
import { LEDGER_ABI, BOOK_ABI, LEASE_TOPIC0S } from "../relay/derived-writer-authority.mjs";

const out = (c) => JSON.parse(fs.readFileSync(new URL(`../contracts/foundry/out/${c}.sol/${c}.json`, import.meta.url), "utf8")).abi;
const shape = (f) => JSON.stringify({ name: f.name, inputs: f.inputs.map((i) => i.type),
  outputs: f.outputs.map((o) => o.type + (o.components ? "(" + o.components.map((c) => `${c.name}:${c.type}`).join(",") + ")" : "")) });

test("ledger get/deploymentsSchema and book addr fragments equal the compiled ABI", () => {
  const ledger = out("EnclaveDeployments"), book = out("EnclaveAddressBook");
  for (const f of LEDGER_ABI) assert.equal(shape(f), shape(ledger.find((x) => x.type === "function" && x.name === f.name)), f.name);
  assert.equal(shape(BOOK_ABI[0]), shape(book.find((x) => x.type === "function" && x.name === "addr")));
});

test("the queried topic0s are the ABI's Claimed/Renewed/Released, in the reader's order", () => {
  const ev = Object.fromEntries(out("EnclaveDeployments").filter((x) => x.type === "event").map((e) => [e.name, e]));
  const sig = (e) => keccak256(toHex(`${e.name}(${e.inputs.map((i) => i.type).join(",")})`));
  assert.deepEqual([...LEASE_TOPIC0S], [sig(ev.Claimed), sig(ev.Renewed), sig(ev.Released)]);
  assert.deepEqual([...LEASE_TOPIC0S], [CLAIMED, RENEWED, RELEASED]);
});
