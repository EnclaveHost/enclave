// rpc/snp/owner-sign/topup.mjs: the owner's ETH for a host's operator key is offered only when every RPC simulates the
// key's balance rising by exactly the amount. A key delegated (EIP-7702) to code with no payable entry refuses a plain
// transfer, and the forced transfer is PUSH20 <key> SELFDESTRUCT as the init code of a contract creation.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DELEGATION, forcedTransferData, simulateTopup } from "../rpc/snp/owner-sign/topup.mjs";

const OWNER = "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61";
const KEY = "0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB";
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");

// A Base RPC that answers eth_simulateV1 the way a node does for a delegated key: the plain transfer reverts, the
// forced one credits `credit` wei. It records the calls it was asked to simulate.
async function rpc({ credit, before = 162890534565n }) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const { id, method, params } = JSON.parse(body);
    assert.equal(method, "eth_simulateV1");
    const calls = params[0].blockStateCalls[0].calls; seen.push(calls);
    const forced = !calls[1].to && calls[1].data === forcedTransferData(KEY);
    const after = forced ? before + credit : before;
    const result = [{ calls: [
      { status: "0x1", returnData: word(before), gasUsed: "0x5f21" },
      forced ? { status: "0x1", returnData: "0x", gasUsed: "0xee1d" } : { status: "0x0", returnData: "0x", gasUsed: "0x5208", error: { code: 3, message: "execution reverted" } },
      { status: "0x1", returnData: word(after), gasUsed: "0x5f21" }] }];
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

test("the forced transfer is PUSH20 <key> SELFDESTRUCT and nothing else", () => {
  assert.equal(forcedTransferData(KEY), "0x73c9d0835cd8ebc7eae84304d9db0a76253eebe6abff");
  assert.ok(DELEGATION.test("0xef01008900baca2167873ba2f8a8bae8b4876e6396d343"));
  assert.ok(!DELEGATION.test("0x6080604052"));
});

test("a transfer is accepted only when every RPC shows the key's balance rising by exactly the amount", async () => {
  const value = "0x38d7ea4c68000", forced = { data: forcedTransferData(KEY), value };
  const a = await rpc({ credit: 10n ** 15n }), b = await rpc({ credit: 10n ** 15n }), short = await rpc({ credit: 10n ** 15n - 1n });
  try {
    assert.equal(await simulateTopup([a.url, b.url], OWNER, KEY, forced), 60957n);
    // simulated from the owner, between two reads of the key's balance, as a creation (no `to`)
    const [read, tx] = a.seen[0];
    assert.equal(tx.from, OWNER); assert.equal(tx.to, undefined); assert.equal(tx.value, value);
    assert.ok(read.data.endsWith(KEY.slice(2).toLowerCase()));
    await assert.rejects(simulateTopup([a.url, b.url], OWNER, KEY, { to: KEY, data: "0x", value }), /would revert/);
    await assert.rejects(simulateTopup([a.url, short.url], OWNER, KEY, forced), /would not rise by the amount/);
  } finally { await Promise.all([a.close(), b.close(), short.close()]); }
});
