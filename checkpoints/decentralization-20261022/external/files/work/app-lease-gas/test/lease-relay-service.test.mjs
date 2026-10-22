// The relay SERVICE entry (network/lease-relay-service.mjs) a relay operator would run: reviewed record by digest, a key
// file that only its owner can read, a small-float cap enforced at start; then it relays a zero-ETH host's claim and
// is reimbursed in the same transaction. Local anvil (test/helpers/b-world.mjs); fixture keys only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { startRelayService } from "../network/lease-relay-service.mjs";
import { startWorld, haveAnvil } from "./helpers/b-world.mjs";

const T = { skip: !haveAnvil && "needs anvil", timeout: 120_000 };
let W, dir, rec, digest;
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-service-"));
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) }));
  rec = path.join(dir, "record.json"); fs.writeFileSync(rec, bytes);
  digest = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
});
after(() => { W?.stop(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const keyFile = (key, mode = 0o600) => { const f = path.join(dir, `k-${crypto.randomBytes(4).toString("hex")}`); fs.writeFileSync(f, key + "\n", { mode }); fs.chmodSync(f, mode); return f; };
const base = (o) => ({ recordFile: rec, digest, rpcs: [W.rpcUrl], allowLoopbackHttp: true, maxFloatEth: "0.02", log: () => {}, ...o });

test("the relay service refuses: no digest, a wrong digest, a group/world-readable key, a float above its cap", T, async () => {
  const key = generatePrivateKey();
  await W.fund(privateKeyToAccount(key).address, 10n ** 16n);
  await assert.rejects(startRelayService(base({ digest: undefined, keyFile: keyFile(key) })), /record and its digest/);
  await assert.rejects(startRelayService(base({ digest: "sha256:" + "0".repeat(64), keyFile: keyFile(key) })), /not the reviewed/);
  await assert.rejects(startRelayService(base({ keyFile: keyFile(key, 0o644) })), /owner only/);
  await assert.rejects(startRelayService(base({ keyFile: keyFile(key), maxFloatEth: undefined })), /MAX_FLOAT/);
  await W.fund(privateKeyToAccount(key).address, 10n ** 18n);
  await assert.rejects(startRelayService(base({ keyFile: keyFile(key) })), /above its 0\.02 ETH float cap/);
});

test("within its float, the service relays a zero-ETH host's claim and is reimbursed in the same transaction", T, async () => {
  const key = generatePrivateKey(), payee = privateKeyToAccount(key).address;
  await W.fund(payee, 10n ** 16n);
  const svc = await startRelayService(base({ keyFile: keyFile(key) }));
  try {
    const info = await (await fetch(`${svc.url}/v1/info`)).json();
    assert.equal(info.payee, payee); assert.equal(info.reserve, W.addr.reserve);
    const owner = await W.owner(), id = await W.create(owner);
    await W.enable(owner, id);
    const op = await W.operator("https://relay-service.test");
    const host = B.createLeaseClient({ client: W.pc, account: op.account, reserve: W.addr.reserve, deployment: { chainId: 8453, ...W.addr },
      relays: [svc.url], allowLoopbackHttp: true, confirmations: 0 });
    const b0 = await W.pc.getBalance({ address: payee });
    const r = await host.claim(id, op.enclaveId);
    const rc = r.receipt, paid = r.verified.chargedWei;
    const b1 = await W.pc.getBalance({ address: payee });
    assert.equal(b1 - b0, paid - rc.gasUsed * rc.effectiveGasPrice, "the relay's balance moved by exactly charge minus its own gas");
    // this first claim carries the operator's one-time EIP-7702 authorization, which the published formula does not
    // charge: the relay absorbs it (round 2 measured -2.0% to -3.9%); later operations of this key do not carry it
    const cost = rc.gasUsed * rc.effectiveGasPrice, ratio = Number(paid * 10000n / cost) / 100;
    console.log(`# relay service: claim+authorization reimbursed ${ratio}% of the relay's L2 cost (anvil: no L1 fee)`);
    assert.equal(r.receipt.type, "eip7702", "the first operation carried the authorization");
    assert.ok(ratio >= 95 && ratio <= 105, `within the documented band: ${ratio}%`);
    assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
  } finally { await svc.close(); }
});
