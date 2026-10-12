// price-guide.mjs: a host's default price is the cheapest per-(GB x FLOPS) unit among the other hosts of its tier, times
// its own GB x FLOPS; a tier nobody else prices uses the default unit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceGuide, defaultPrice, rowTiers, rowUnits, DEFAULT_UNIT_PER_HOUR, perSec6Of, perHourOf } from "./price-guide.mjs";

// the live fleet of 2026-10-12, as /enclaves listed it
const METAL0 = { name: "metal0", mode: "snp", availability: { teeCpu: "amd-sev-snp", gpu: true, askCpuPricePerSec6: 834, askGpuPricePerSec6: 1667,
  nodeGflops: 540, nodeRamGb: 96, cardTflops: 214.7, cardVramGb: 62 } };
const PIXEL = { name: "pixel10-pvm-cpu", mode: "avf", tier: "pvm-cpu", availability: { askCpuPricePerSec6: 2, nodeGflops: 1.08, nodeRamGb: 2.8 } };
const NUCBOX = { name: "nucbox-k11-4", mode: "hv-node", tier: "hv-node", availability: { askCpuPricePerSec6: 12, nodeGflops: 370.3, nodeRamGb: 55 } };
const near = (a, b, m) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-9, `${m}: ${a} != ${b}`);

test("tiers come from the relay's verdicts on the row: SNP -> tee-cpu (+ tee-gpu), avf -> pvm-cpu, a Shield PC -> cpu (+ gpu)", () => {
  assert.deepEqual(rowTiers(METAL0), { cpu: "tee-cpu", gpu: "tee-gpu" });
  assert.deepEqual(rowTiers(PIXEL), { cpu: "pvm-cpu", gpu: null });
  assert.deepEqual(rowTiers(NUCBOX), { cpu: "cpu", gpu: null });
  assert.deepEqual(rowTiers({ mode: "hv-node", availability: { teeCpu: "amd-sev-snp", shielded: { vramGb: 16 } } }), { cpu: "cpu", gpu: "gpu" },
    "an hv-node's own word about a TEE never makes it one; its card sits outside any");
});

test("units are price-per-hour / (GB x FLOPS); the guide takes the cheapest per tier and leaves this box out", () => {
  const u = rowUnits(METAL0);
  near(u[0].unit, 834 * 3600 / 1e6 / (96 * 540), "metal0 CPU"); near(u[1].unit, 1667 * 3600 / 1e6 / (62 * 214.7), "metal0 card");
  const cheaper = { ...METAL0, name: "cheap", availability: { ...METAL0.availability, askCpuPricePerSec6: 400 } };
  const g = priceGuide([METAL0, cheaper, PIXEL, NUCBOX], { exclude: "nucbox-k11-4" });
  assert.equal(g["tee-cpu"].from, "cheap"); near(g["tee-cpu"].unit, 400 * 3600 / 1e6 / (96 * 540), "cheapest wins");
  assert.equal(g["pvm-cpu"].from, "pixel10-pvm-cpu");
  assert.deepEqual(g.cpu, { unit: DEFAULT_UNIT_PER_HOUR.cpu, from: null }, "nucbox is the only CPU host and it is excluded: the default");
  assert.deepEqual(g.gpu, { unit: DEFAULT_UNIT_PER_HOUR.gpu, from: null });
  assert.equal(priceGuide([NUCBOX]).cpu.from, "nucbox-k11-4", "another box would compare against it");
});

test("a default price is the unit x this box's GB x FLOPS; the defaults put a typical machine on its market price", () => {
  const g = priceGuide([METAL0, PIXEL], { exclude: "nucbox-k11-4" });
  const d = defaultPrice(g, "cpu", 55, 370.3);
  near(d.perHour, 0.0005 / 64 * 55 * 370.3, "nucbox's default"); assert.equal(d.from, null); assert.equal(d.perSec6, perSec6Of(d.perHour));
  near(defaultPrice(g, "cpu", 64, 1000).perHour, 0.5, "64 GB x 1000 GFLOPS at the CPU default: $0.0005 a GFLOPS-hour");
  near(defaultPrice(priceGuide([]), "tee-gpu", 141, 989).perHour, 0.006 * 989, "an H200 at the TEE GPU default");
  near(defaultPrice(priceGuide([]), "gpu", 80, 1000).perHour, 2, "an 80 GB, 1000 TFLOPS card at the GPU default");
  assert.equal(defaultPrice(g, "cpu", 0, 370), null); assert.equal(defaultPrice(g, "nope", 55, 370), null);
});

test("implausible or unpriced rows are not compared; prices round to whole micro-USDC a second, never zero", () => {
  const liar = { name: "liar", mode: "snp", availability: { teeCpu: "amd-sev-snp", askCpuPricePerSec6: 834, nodeGflops: 9e9, nodeRamGb: 96 } };
  const free = { name: "free", mode: "snp", availability: { teeCpu: "amd-sev-snp", askCpuPricePerSec6: 0, nodeGflops: 540, nodeRamGb: 96 } };
  assert.equal(priceGuide([liar, free])["tee-cpu"].from, null);
  assert.equal(perSec6Of(0.000001), 1); assert.equal(perSec6Of(3), 833); near(perHourOf(834), 3.0024, "834/s");
});
