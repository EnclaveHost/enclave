// The buyer's rate cap, decided on the runner side (supervisor.js) — the pure
// half: what THIS enclave charges for a deployment's shares, and whether that
// is inside the ceiling its owner signed. Driven through the PRICE_SELFTEST
// seam, same contract as SWEEP_SELFTEST/REACH_SELFTEST.
//
// Why it matters: prices are per enclave now (each publishes its own in its
// EnclaveRegistry entry), so "where does this app go when its host dies" is
// decided exactly here — by whether the next box's price for those shares
// fits under maxRate6. The ledger enforces the same two rules in claim(), so
// a disagreement between these numbers and the contract's is a reverted tx at
// best and a dark tenant at worst (EnclaveDeployments.rateCap.t.sol pins the
// contract side).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

// `price` = what this box posts for a whole node / whole card (USDC 6dp/sec)
async function verdicts(cases, price = {}) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", PRICE_SELFTEST: JSON.stringify(cases),
           SELL_CPU_PRICE6: String(price.cpu ?? 834), SELL_GPU_PRICE6: String(price.gpu ?? 1667),
           GPU_COUNT: String(price.gpu === 0 ? 0 : 1),
           REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "",
           CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const RICH = 1_000_000_000;   // a balance no case is meant to trip over

test("the price is the enclave's own, scaled by the shares and ceil'd like the ledger", async () => {
  const [full, half, tiny, cpuOnly] = await verdicts([
    { gpuMilli: 1000, cpuMilli: 1000, balance6: RICH },
    { gpuMilli: 500, cpuMilli: 250, balance6: RICH },
    { gpuMilli: 0, cpuMilli: 1, balance6: RICH },
    { gpuMilli: 0, cpuMilli: 100, balance6: RICH },
  ]);
  assert.equal(full.mine6, 2501);                    // 1667 + 834, ceil
  assert.equal(half.mine6, (1667 * 500 + 834 * 250 + 999) / 1000 | 0);
  assert.equal(tiny.mine6, 1, "a 1-milli slice still pays a whole unit/sec");
  assert.equal(cpuOnly.mine6, 84);
  for (const v of [full, half, tiny, cpuOnly]) assert.equal(v.refusal, null);
});

test("a cheaper enclave takes work the dear one may not — the failover gate", async () => {
  const shares = { gpuMilli: 0, cpuMilli: 400, balance6: RICH };
  // the owner signed up for the cheap host's price (834 * 400 / 1000 = 334)
  const cap6 = 334;
  const [cheap] = await verdicts([{ ...shares, cap6 }]);
  assert.equal(cheap.mine6, 334);
  assert.equal(cheap.refusal, null, "at the cap exactly: still ours to take");

  const [dear] = await verdicts([{ ...shares, cap6 }], { cpu: 1668, gpu: 3334 });
  assert.equal(dear.mine6, 668);
  assert.match(dear.refusal, /charges \$2\.40\/hr for those shares, above the owner's rate cap of \$1\.20\/hr/);
});

test("the publisher's fee counts against the ceiling, and says so", async () => {
  const [v] = await verdicts([{ gpuMilli: 0, cpuMilli: 100, fee6: 278, cap6: 300, balance6: RICH }]);
  assert.equal(v.mine6, 84);                          // ours: $0.30/hr
  assert.match(v.refusal, /incl\. \$1\.00\/hr publisher fee/);
  assert.match(v.refusal, /above the owner's rate cap of \$1\.08\/hr/);
  // raise the ceiling over the pair and the same work is claimable
  const [ok] = await verdicts([{ gpuMilli: 0, cpuMilli: 100, fee6: 278, cap6: 400, balance6: RICH }]);
  assert.equal(ok.refusal, null);
});

test("an uncapped record (a grandfathered import) is claimable at any price", async () => {
  const [v] = await verdicts([{ gpuMilli: 1000, cpuMilli: 1000, cap6: 0, balance6: RICH }], { cpu: 99999, gpu: 99999 });
  assert.equal(v.refusal, null);
});

test("a balance that can't buy one second HERE is not this enclave's work", async () => {
  const [broke] = await verdicts([{ gpuMilli: 0, cpuMilli: 100, cap6: 1000, balance6: 83 }]);
  assert.match(broke.refusal, /out of funded time at this enclave's price \(\$0\.30\/hr\)/);
  // one unit more and the second is affordable
  const [ok] = await verdicts([{ gpuMilli: 0, cpuMilli: 100, cap6: 1000, balance6: 84 }]);
  assert.equal(ok.refusal, null);
  // the fee is part of what must be affordable, not an extra on the side
  const [withFee] = await verdicts([{ gpuMilli: 0, cpuMilli: 100, fee6: 10, cap6: 1000, balance6: 84 }]);
  assert.match(withFee.refusal, /out of funded time/);
});
