/* ============================================================
   Pricing + share math. The deploy page has exactly TWO dials:
   a GPU/VRAM share and a CPU/RAM share, 0-100% each. An app's
   exact specs (VRAM, compute, RAM in the catalog) only set the
   MINIMUM shares those dials allow: spec / server spec, the
   larger of the memory and compute axes per pool, rounded up to
   the whole percent. A GPU app's CPU minimum also lifts its GPU
   minimum (a GPU app's gpuShare must be >= its cpuShare).
   Rate = gpuShare x card rate + cpuShare x node rate.

   THE SERVER SPEC IS ADOPTED LIVE from /availability — the same
   numbers the runners divide by in their own claim gate — never
   trusted from constants. The runners are authoritative: a dial
   floor computed from a card that's even slightly bigger than
   the real one sells a share below every runner's minimum, and
   that deployment is claimable by NOBODY, forever, with its
   funding unrecoverable (2026-07-14, 0xf3d976a0…: "141 GB" here
   vs the H200's probed 140.4 GiB made the console sell 91% of a
   card whose runners demand 92%). The constants below are only
   the pre-fetch fallback, and each sits AT OR BELOW the smallest
   real hardware in the fleet: a wrong fallback must over-ask
   (costs the user pennies), never under-sell.
   ============================================================ */
export const FULL_RATE = 0.0016667;        // whole-H200 USDC/sec ($6.00/hr)
export const CPU_NODE_RATE = 0.000834;     // whole CPU node USDC/sec ($3.00/hr)
export const MIN_COMPUTE_PCT = 1;    // shares are dialed in whole percent (CUDA MPS grain); 1% floor, no fixed 1/7

const FALLBACK = {
  cardVramGb: 140.4,   // H200 as PROBED under CC (nvidia-smi 143771 MiB), not the 141 datasheet
  cardTflops: 989,     // GPU compute per card (H200 FP16 dense)
  nodeVcpus: 16,       // host vCPUs on the enclave
  nodeRamGb: 64,       // host RAM GB on the enclave
  nodeGflops: 1000,    // CPU compute per node in GFLOPS (~16 vCPU; a node is ~1/1000 of a card)
};
let LIVE = null;       // last adopted /availability hardware; null until the first fetch lands

// The hardware every share/minimum divides by right now. `live` says whether
// a real /availability payload has been adopted or the fallbacks still hold.
export function serverSpec(){ return { ...FALLBACK, ...(LIVE || {}), live: !!LIVE }; }

// Adopt the fleet's hardware from an /availability payload (a single enclave's
// or the relay aggregate — both carry the same field names). Prefers the
// relay's spec* fields when present: those are fleet-wide MINIMA, the only
// safe sizing base on a mixed fleet (the plain fields describe the best box,
// and a floor computed on the biggest card under-sells on every smaller one).
// Zero/absent axes (a CPU-only fleet reports no card) keep their previous
// values so GPU math never divides by zero. Returns true when a number
// changed — callers re-render dial floors on that signal.
export function adoptServerSpec(a){
  if (!a || typeof a !== "object") return false;
  const next = { ...FALLBACK, ...(LIVE || {}) };
  let changed = false;
  for (const [key, specKey] of [
    ["cardVramGb", "specCardVramGb"], ["cardTflops", "specCardTflops"],
    ["nodeVcpus", "specNodeVcpus"], ["nodeRamGb", "specNodeRamGb"], ["nodeGflops", "specNodeGflops"],
  ]){
    const v = Number(a[specKey] != null ? a[specKey] : a[key]);
    if (Number.isFinite(v) && v > 0 && v !== next[key]){ next[key] = v; changed = true; }
  }
  if (changed || !LIVE){ LIVE = next; return true; }
  return false;
}

export const pctCeil = (x) => Math.min(100, Math.max(MIN_COMPUTE_PCT, Math.ceil(x * 100 - 1e-9)));
// v: a catalog version's exact specs (zeros = no minimum). `spec` picks the
// hardware to divide by: omitted = the adopted fleet spec (aggregate mode),
// or a specific enclave's hardware from enclaveSpecOf (target mode — the
// deploy console sizes against the box the deployment would land on).
export function minPctsOf(v, spec){
  const s = spec || serverSpec();
  const vramMb = Number(v && v.vramMb || 0), gpuGf = Number(v && v.gpuGflops || 0);
  const memMb = Number(v && v.memMb || 0), cpuGf = Number(v && v.cpuGflops || 0);
  const cpu = (memMb > 0 || cpuGf > 0) ? pctCeil(Math.max(memMb / (s.nodeRamGb * 1024), cpuGf / s.nodeGflops)) : 1;
  const gpu0 = (vramMb > 0 || gpuGf > 0) ? pctCeil(Math.max(vramMb / 1024 / s.cardVramGb, gpuGf / 1000 / s.cardTflops)) : 0;
  return { gpuPct: gpu0 > 0 ? Math.max(gpu0, cpu) : 0, cpuPct: cpu };
}
export function shareRates(gpuPct, cpuPct, spec){  // what the two dials buy on this server spec
  const s = spec || serverSpec();
  const g = Math.min(100, Math.max(0, Math.round(gpuPct)));
  const c = Math.min(100, Math.max(MIN_COMPUTE_PCT, Math.round(cpuPct)));
  return { rate: (g / 100) * FULL_RATE + (c / 100) * CPU_NODE_RATE, gpuPct: g, cpuPct: c,
           vramGb: (g / 100) * s.cardVramGb, tflops: (g / 100) * s.cardTflops,
           ramGb: (c / 100) * s.nodeRamGb, vcpus: (c / 100) * s.nodeVcpus, gflops: (c / 100) * s.nodeGflops };
}

/* ---- per-enclave targeting (the relay's /enclaves rows) ------------------ */

// One enclave row's sizing hardware: its own advertised numbers per axis, the
// fallback constants for anything it omits (old builds).
export function enclaveSpecOf(row){
  const a = (row && row.availability) || {};
  const s = { ...FALLBACK };
  for (const k of ["cardVramGb", "cardTflops", "nodeVcpus", "nodeRamGb", "nodeGflops"]){
    const v = Number(a[k]);
    if (Number.isFinite(v) && v > 0) s[k] = v;
  }
  return s;
}

// Which live enclave a deployment of `v` would land on, and the dial floors
// ON THAT BOX. Only CLAIMING enclaves count (same rule as the relay's sizing
// subset — explicit claimEnabled, with non-tunnel rows grandfathered). Among
// boxes that fit, the pick is the CHEAPEST FOR THE BUYER: the lowest minimum
// share, i.e. the biggest hardware — a share sized for it is refused by every
// smaller box's own claim gate, so the prediction stays self-consistent (a
// small box never claims a big-box-sized record). Ties mirror claim routing:
// CPU apps prefer CPU-only boxes (GPU leftovers are the graced fallback),
// then the most free pool wins. The pick is a PREDICTION, not a booking —
// the ledger is an open queue and any box at least as big may claim first —
// but shares sized for the pick are servable by it and by anything bigger.
// Returns { row, name, spec, mins, free:{gpuPct,cpuPct}, queued } — queued:
// the box fits this app but can't START it now (deploys wait on-chain) — or
// { none: "why" } when no live enclave could ever run it.
export function pickEnclaveFor(v, rows){
  const claiming = (rows || []).filter((e) => e && e.availability
    && (e.availability.claimEnabled === true || (e.availability.claimEnabled == null && !e.tunnel)));
  if (!claiming.length) return { none: "no live enclave is taking work right now" };
  const vramMb = Number(v && v.vramMb || 0), gpuGf = Number(v && v.gpuGflops || 0);
  const memMb = Number(v && v.memMb || 0), cpuGf = Number(v && v.cpuGflops || 0);
  const needsGpu = vramMb > 0 || gpuGf > 0;
  const cand = claiming.map((row) => {
    const a = row.availability, spec = enclaveSpecOf(row);
    const gpu = a.gpu === true;
    // structural fit: could this BOX ever run the app, at any share?
    const fits = (!needsGpu || (gpu && vramMb / 1024 <= spec.cardVramGb && gpuGf / 1000 <= spec.cardTflops))
              && memMb <= spec.nodeRamGb * 1024 && cpuGf <= spec.nodeGflops;
    const mins = minPctsOf(v, spec);
    const free = { gpuPct: Math.floor((a.gpuShareFree || 0) * 100), cpuPct: Math.floor((a.cpuShareFree || 0) * 100) };
    const now = fits && (!needsGpu || free.gpuPct >= mins.gpuPct) && free.cpuPct >= mins.cpuPct;
    const name = row.name || String(row.endpoint || "").replace(/^[a-z]+:\/\//, "").split(".")[0] || "enclave";
    return { row, name, spec, mins, free, gpu, fits, now };
  });
  const order = (list) => list.slice().sort((x, y) => needsGpu
    ? (x.mins.gpuPct - y.mins.gpuPct) || (y.free.gpuPct - x.free.gpuPct)
    : (x.mins.cpuPct - y.mins.cpuPct) || ((x.gpu === true) - (y.gpu === true)) || (y.free.cpuPct - x.free.cpuPct));
  const pool = cand.filter((c) => needsGpu ? c.gpu : true);
  const ready = order(pool.filter((c) => c.now));
  if (ready.length) return { ...ready[0], queued: false };
  const eventual = order(pool.filter((c) => c.fits));
  if (eventual.length) return { ...eventual[0], queued: true };
  return { none: needsGpu && !pool.some((c) => c.gpu)
    ? "this app needs a GPU and no live enclave has one"
    : "no live enclave's hardware is big enough for this app's specs" };
}
