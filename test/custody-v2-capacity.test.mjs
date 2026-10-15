// custody v2 §5 item 2: a non-Enclave candidate's proof of capacity is a witness receipt naming its chip and host.
//   run: node --test test/custody-v2-capacity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { receiptData } from "../availability/evidence.mjs";
import { receiptCapacityCheck } from "../custody/v2/capacity.mjs";

const FEES = "0x87c7266543ff5839b2c20226BD9B3cd511A23641", HOST = "0x" + "4d".repeat(32), OP = "0x" + "c9".repeat(20), PAY = "0x" + "77".repeat(20);
const CHIP = "ab".repeat(64), HW = "0x" + createHash("sha256").update(Buffer.from(CHIP, "hex")).digest("hex");
const NOW = 1_800_000_000n;
async function receipt(signer, over = {}) {
  const payload = { kind: "capacity", trustMode: "operator-bootstrap", classId: "cpu", hostId: HOST, operator: OP, payoutWallet: PAY, hardwareId: HW,
                    units: "552", spareUnits: "11", spareAtSec: String(NOW), minimumRate6: "2", issuedSec: String(NOW - 7200n), expiresSec: String(NOW + 3600n), ...over };
  return { payload, signatures: [await signer.signTypedData(receiptData(payload, { chainId: 8453, contract: FEES }))] };
}
test("a candidate's capacity: a trusted witness's receipt for ITS chip and host passes; anything else is refused", async () => {
  const w = privateKeyToAccount(generatePrivateKey()), stranger = privateKeyToAccount(generatePrivateKey());
  const check = receiptCapacityCheck({ chainId: 8453, contract: FEES, witnesses: { [w.address]: "enclave-bootstrap" }, now: () => NOW });
  const ctx = { machine: { registryId: HOST }, chipIdRaw: CHIP, registry: { operator: OP, payoutWallet: PAY } };
  assert.equal((await check({ ...ctx, receipts: [await receipt(w)] })).ok, true);
  for (const [receipts, why] of [
    [[], /no capacity receipt/], [[await receipt(stranger)], /insufficient/], [[await receipt(w, { hardwareId: "0x" + "00".repeat(32) })], /another chip/],
    [[await receipt(w, { hostId: "0x" + "11".repeat(32) })], /another host/], [[await receipt(w, { payoutWallet: OP })], /payout/],
    [[await receipt(w, { expiresSec: String(NOW - 1n) })], /stale/], [[await receipt(w, { trustMode: "independent" })], /labeled/],
  ]) { const r = await check({ ...ctx, receipts }); assert.equal(r.ok, false); assert.match(r.reason, why); }
});
