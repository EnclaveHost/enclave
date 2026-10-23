import test from "node:test";
import assert from "node:assert/strict";
import { feeFit, viemDefaultMaxFee, l1SizeArgument } from "./fee-fit.mjs";

test("viem default max fee = ceil(base x 1.2) + tip", () => {
  assert.equal(viemDefaultMaxFee(5_000_000n, 1_000_000n), 7_000_000n);
  assert.equal(viemDefaultMaxFee(5_000_001n, 0n), 6_000_002n);
});

test("root's numbers: register 50354 gas at 11 mwei does not fit 376132087579 wei", () => {
  const r = feeFit({ gas: 50354n, baseFee: 5_000_000n, tip: 1_000_000n, l1FeeUpperBound: 0n, operatorFee: 0n, balance: 376132087579n, maxFeePerGas: 11_000_000n });
  assert.equal(r.fitsAsSent, false);
  assert.equal(r.worstCaseWei, String(50354n * 11_000_000n));
  assert.equal(r.maxAffordableMaxFeePerGas, String(376132087579n / 50354n));
  assert.equal(r.landsAtCurrentBaseFee, true, "a capped 7.4 mwei fee would still land at base 5 + tip 1");
});

test("L1 and operator fees count; the size argument must cover the signed maximum", () => {
  const a = feeFit({ gas: 30000n, baseFee: 5_000_000n, tip: 1_000_000n, l1FeeUpperBound: 1_000_000_000n, operatorFee: 0n, balance: 10n ** 12n });
  assert.equal(a.worstCaseWei, String(30000n * 7_000_000n + 1_000_000_000n));
  assert.equal(a.fitsAsSent, true);
  const b = feeFit({ gas: 30000n, baseFee: 5_000_000n, tip: 1_000_000n, l1FeeUpperBound: 1_000_000_000n, operatorFee: 5n, balance: 30000n * 7_000_000n + 1_000_000_000n });
  assert.equal(b.fitsAsSent, false); assert.equal(b.shortfallWei, "5");
  assert.equal(l1SizeArgument({ unsigned: 100, signedMax: 167 }), 100);
  assert.equal(l1SizeArgument({ unsigned: 100, signedMax: 170 }), 102);
});
