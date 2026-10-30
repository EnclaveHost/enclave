// windows/node/price-guide.mjs -- what a host charges by default, from what the network already charges.
//
// A host posts ONE price for its whole machine (askCpuPricePerSec6) and one for its whole card (askGpuPricePerSec6 /
// askShieldedPricePerSec6); a deployment pays the share it leases. Machines differ in size, so those raw prices do not
// compare. They are compared per unit of capacity: USDC per hour per (memory GB x compute), where compute is GFLOPS for a
// CPU and TFLOPS for a card (Steven, 2026-10-12: "per GB x GFLOP/TFLOP"). A box's DEFAULT price is the cheapest such unit
// among the other hosts of its security tier, times its own GB x FLOPS. A tier with no other priced host uses a default
// unit (DEFAULT_UNIT_PER_HOUR). The owner can override either price in the tray.
//
// Tiers: cpu (no CPU TEE: an Enclave Shield PC), tee-cpu (AMD SEV-SNP / Intel TDX), pvm-cpu (a phone's protected VM),
// gpu (a card outside any TEE, e.g. a Shield PC's), tee-gpu (a card inside a confidential VM). Rows are the relay's
// /enclaves list; every figure in them is the host's own word, so implausible ones are left out of the comparison.

export const TIERS = ["cpu", "tee-cpu", "pvm-cpu", "gpu", "tee-gpu"];
const CONFIDENTIAL_CPU = new Set(["amd-sev-snp", "intel-tdx"]);
// Default units, USDC per hour per (GB x GFLOPS) for a CPU, per (GB x TFLOPS) for a card: a market price per unit of
// compute, spread over a typical machine's memory so that machine lands exactly on that market price.
//   cpu      $0.0005 per GFLOPS-hour (about a cloud vCPU) on a 64 GB machine
//   pvm-cpu  $0.0005 per GFLOPS-hour on an 8 GB phone
//   tee-cpu  $0.003 per GFLOPS-hour (the hosted SEV fleet's $3/hr for 1000 GFLOPS) on a 64 GB machine
//   gpu      $0.002 per TFLOPS-hour (about a rented H100) on an 80 GB card
//   tee-gpu  $0.006 per TFLOPS-hour (the hosted fleet's $6/hr H200) on a 141 GB card
export const DEFAULT_UNIT_PER_HOUR = Object.freeze({
  "cpu": 0.0005 / 64, "pvm-cpu": 0.0005 / 8, "tee-cpu": 0.003 / 64, "gpu": 0.002 / 80, "tee-gpu": 0.006 / 141,
});
const MAX_GB = 4096, MAX_GFLOPS = 1e6, MAX_TFLOPS = 1e5;   // beyond any one host: a figure like that is not compared
const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
export const perHourOf = (perSec6) => pos(perSec6) * 3600 / 1e6;
/** USDC per hour -> the registry's integer micro-USDC per second (at least 1: a posted price is never zero). */
export const perSec6Of = (perHour) => Math.max(1, Math.round(pos(perHour) / 3600 * 1e6));

/** A row's tiers: { cpu: tier, gpu: tier | null }. The mode and the CPU TEE are the relay's verdicts on the row. */
export function rowTiers(row) {
  const a = (row && row.availability) || {};
  const mode = String(row?.mode || ""), tier = String(row?.tier || row?.lane || "");
  const cpu = mode === "avf" || tier === "pvm-cpu" ? "pvm-cpu" : CONFIDENTIAL_CPU.has(String(a.teeCpu || "")) && mode !== "hv-node" ? "tee-cpu" : "cpu";
  const shielded = a.shielded && pos(a.shielded.vramGb) > 0;
  const gpu = shielded ? "gpu" : a.gpu === true ? (cpu === "tee-cpu" ? "tee-gpu" : "gpu") : null;
  return { cpu, gpu };
}

/** The capacity a row prices: { cpu: { gb, flops }, gpu: { gb, flops } | null } (flops: GFLOPS, TFLOPS). */
export function rowCapacity(row) {
  const a = (row && row.availability) || {};
  const sh = a.shielded || {};
  const cpu = { gb: pos(a.nodeRamGb), flops: pos(a.nodeGflops) };
  const gb = pos(sh.vramGb) || pos(a.cardVramGb), tflops = pos(sh.cardTflops) || pos(a.cardTflops);
  return { cpu, gpu: gb && tflops ? { gb, flops: tflops } : null };
}

/** A row's unit prices: [{ tier, unit, name }] for its CPU and its card, where it posts a price and plausible figures. */
export function rowUnits(row) {
  const a = (row && row.availability) || {};
  const t = rowTiers(row), c = rowCapacity(row), out = [];
  const name = String(row?.name || "");
  const cpuHr = perHourOf(a.askCpuPricePerSec6);
  if (cpuHr && c.cpu.gb && c.cpu.flops && c.cpu.gb <= MAX_GB && c.cpu.flops <= MAX_GFLOPS)
    out.push({ tier: t.cpu, unit: cpuHr / (c.cpu.gb * c.cpu.flops), name });
  const gpuHr = perHourOf(a.askShieldedPricePerSec6) || perHourOf(a.askGpuPricePerSec6);
  if (t.gpu && gpuHr && c.gpu && c.gpu.gb <= MAX_GB && c.gpu.flops <= MAX_TFLOPS)
    out.push({ tier: t.gpu, unit: gpuHr / (c.gpu.gb * c.gpu.flops), name });
  return out;
}

/**
 * priceGuide(rows, { exclude }) -> { [tier]: { unit, from } }: the cheapest unit in each tier among the rows (the host
 * named `exclude` - this box - left out), `from` naming the host it came from, or null for the default unit.
 */
export function priceGuide(rows, { exclude = "" } = {}) {
  const guide = Object.fromEntries(TIERS.map((t) => [t, { unit: DEFAULT_UNIT_PER_HOUR[t], from: null }]));
  for (const row of Array.isArray(rows) ? rows : []) {
    if (exclude && String(row?.name || "") === exclude) continue;
    for (const u of rowUnits(row)) {
      const g = guide[u.tier];
      if (g && (g.from === null || u.unit < g.unit)) guide[u.tier] = { unit: u.unit, from: u.name || "another host" };
    }
  }
  return guide;
}

/** A default price: { perHour, perSec6, unit, from, tier } for `gb` GB x `flops` FLOPS in `tier`. Null when unsized. */
export function defaultPrice(guide, tier, gb, flops) {
  const g = guide && guide[tier];
  if (!g || !(pos(gb) && pos(flops))) return null;
  const perHour = g.unit * pos(gb) * pos(flops);
  return { perHour, perSec6: perSec6Of(perHour), unit: g.unit, from: g.from, tier };
}
