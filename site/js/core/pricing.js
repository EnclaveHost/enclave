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
/* PRICE IS PER ENCLAVE, adopted live like the hardware. Each enclave posts
   what its whole machine costs (askCpu/askGpuPricePerSec6 in /availability,
   its EnclaveRegistry entry on-chain) and a deployment pays that fraction of
   whichever one claims it — so the number to SHOW is the cheapest connected
   enclave's, and the number to CHARGE is the target box's. The constants below
   are only the pre-fetch fallback (the hosted fleet's long-standing prices);
   adoptFleetPrice replaces them with the live floor. */
export const FALLBACK_FULL_RATE = 0.0016667;      // whole card USDC/sec ($6.00/hr)
export const FALLBACK_CPU_NODE_RATE = 0.000834;   // whole node USDC/sec ($3.00/hr)
let PRICE = null;   // { full, node } USDC/sec, cheapest live enclave; null until adopted
// Current prices. `live` says whether a real /availability payload set them.
export function fleetPrice(){
  return { full: PRICE?.full ?? FALLBACK_FULL_RATE, node: PRICE?.node ?? FALLBACK_CPU_NODE_RATE, live: !!PRICE };
}
// Adopt the CHEAPEST posted price from an /availability payload: the relay
// aggregate carries cheapest*PricePerSec6 (min over claiming enclaves), a
// single enclave carries its own ask*. Absent on a fleet that predates posted
// prices — the fallbacks then stand. Returns true when a number changed.
export function adoptFleetPrice(a){
  if (!a || typeof a !== "object") return false;
  const per = (x) => { const v = Number(x); return Number.isFinite(v) && v > 0 ? v / 1e6 : 0; };
  const full = per(a.cheapestGpuPricePerSec6 ?? a.askGpuPricePerSec6);
  const node = per(a.cheapestCpuPricePerSec6 ?? a.askCpuPricePerSec6);
  if (!node) return false;                       // no live price: keep what we have
  const next = { full: full || PRICE?.full || FALLBACK_FULL_RATE, node };
  const changed = !PRICE || PRICE.full !== next.full || PRICE.node !== next.node;
  PRICE = next;
  return changed;
}
// Back-compat aliases for call sites that read a plain number. These follow
// the adopted price, so a module that imported them once still shows the
// current one only if it re-reads via fleetPrice() — prefer that.
export const FULL_RATE = FALLBACK_FULL_RATE;
export const CPU_NODE_RATE = FALLBACK_CPU_NODE_RATE;
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
// What the two dials buy on this server spec, and cost per second. `price`
// pins a specific enclave's posted rates ({full, node} USDC/sec, e.g. from
// enclavePriceOf(row)); omitted = the cheapest live enclave, which is what a
// new deployment lands on.
export function shareRates(gpuPct, cpuPct, spec, price){
  const s = spec || serverSpec();
  const p = price || fleetPrice();
  const g = Math.min(100, Math.max(0, Math.round(gpuPct)));
  const c = Math.min(100, Math.max(MIN_COMPUTE_PCT, Math.round(cpuPct)));
  return { rate: (g / 100) * p.full + (c / 100) * p.node, gpuPct: g, cpuPct: c,
           vramGb: (g / 100) * s.cardVramGb, tflops: (g / 100) * s.cardTflops,
           ramGb: (c / 100) * s.nodeRamGb, vcpus: (c / 100) * s.nodeVcpus, gflops: (c / 100) * s.nodeGflops };
}

/* ---- per-enclave targeting (the relay's /enclaves rows) ------------------ */

// One enclave row's POSTED price ({full, node} USDC/sec): what it charges for
// a whole card / whole node. A row that posts nothing falls back to the fleet
// price, so callers always have a number to show.
export function enclavePriceOf(row){
  const a = (row && row.availability) || {};
  const f = fleetPrice();
  const per = (x, fb) => { const v = Number(x); return Number.isFinite(v) && v > 0 ? v / 1e6 : fb; };
  return { full: per(a.askGpuPricePerSec6, f.full), node: per(a.askCpuPricePerSec6, f.node) };
}

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

// The model volumes a deployment asks for, off the spec object: `v.volumes`,
// which specOf() fills from the version's approved config and the deploy
// console overrides with the picker's live ticks (an edited config can change
// them before signing). Absent/empty = no volume constraint.
// An enclave row's display name: the relay's `name` field, else the host part
// of its endpoint (tunnel:// rows carry a routing key, not a hostname).
export const nameOf = (row) => (row && row.name)
  || String((row && row.endpoint) || "").replace(/^[a-z]+:\/\//, "").split(".")[0] || "enclave";

export function volsWanted(v){
  const list = Array.isArray(v && v.volumes) ? v.volumes : [];
  return [...new Set(list.map((x) => String((x && x.name) || x || "")).filter(Boolean))];
}
// Does this enclave row advertise every one of them? A row with no `volumes`
// field at all carries none — an enclave that cannot tell us what it has cannot
// be targeted for work that needs a specific volume.
export function hasVolumes(a, want){
  if (!want.length) return true;
  const have = new Set(((a && a.volumes) || []).map((x) => String((x && x.name) || x || "")));
  return want.every((n) => have.has(n));
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
// EVERY live enclave that could host `v`, ranked: ready boxes first (in the
// preference order above), then structurally-fitting-but-full ones (a deploy
// sized for those queues). Each entry: { row, name, spec, mins, free, gpu,
// queued }. The deploy surfaces render this as the target dropdown — the
// head is the recommended pick, any entry is a valid user choice.
export function rankEnclavesFor(v, rows){
  const claiming = (rows || []).filter((e) => e && e.availability && (e.serving != null
    ? e.serving === true   // the relay's explicit verdict (rows since 2026-07-25) outranks the local rule
    : (e.availability.claimEnabled === true || (e.availability.claimEnabled == null && !e.tunnel))));
  const vramMb = Number(v && v.vramMb || 0), gpuGf = Number(v && v.gpuGflops || 0);
  const memMb = Number(v && v.memMb || 0), cpuGf = Number(v && v.cpuGflops || 0);
  const needsGpu = vramMb > 0 || gpuGf > 0;
  const wantVols = volsWanted(v);
  const cand = claiming.map((row) => {
    const a = row.availability, spec = enclaveSpecOf(row);
    const gpu = a.gpu === true;
    // structural fit: could this BOX ever run the app, at any share?
    // Model volumes are PER-BOX, like the card: they are attached to an enclave,
    // not fetched on demand, so a box that doesn't carry every volume this
    // deployment asks for can never run it — its own claim gate refuses the
    // record (supervisor considerClaim). Targeting it anyway would send the
    // claim hint to a box that declines, and the deploy would sit in the open
    // queue waiting for whichever box does carry them.
    const fits = (!needsGpu || (gpu && vramMb / 1024 <= spec.cardVramGb && gpuGf / 1000 <= spec.cardTflops))
              && memMb <= spec.nodeRamGb * 1024 && cpuGf <= spec.nodeGflops
              && hasVolumes(a, wantVols);
    const mins = minPctsOf(v, spec);
    const free = { gpuPct: Math.floor((a.gpuShareFree || 0) * 100), cpuPct: Math.floor((a.cpuShareFree || 0) * 100) };
    const now = fits && (!needsGpu || free.gpuPct >= mins.gpuPct) && free.cpuPct >= mins.cpuPct;
    const name = nameOf(row);
    // what running THIS app on THIS box costs per second at its minimum
    // shares: the box's own posted price times the share its hardware forces.
    // Big-and-dear can beat small-and-cheap, so the ranking compares money.
    const price = enclavePriceOf(row);
    const minRate = shareRates(mins.gpuPct, mins.cpuPct, spec, price).rate;
    return { row, name, spec, mins, free, gpu, fits, now, price, minRate };
  }).filter((c) => c.fits && (needsGpu ? c.gpu : true));
  // CHEAPEST FIRST, in money — then the old tiebreaks (smallest minimum share,
  // CPU boxes before GPU leftovers for CPU work, most free pool)
  const order = (list) => list.slice().sort((x, y) => (x.minRate - y.minRate) || (needsGpu
    ? (x.mins.gpuPct - y.mins.gpuPct) || (y.free.gpuPct - x.free.gpuPct)
    : (x.mins.cpuPct - y.mins.cpuPct) || ((x.gpu === true) - (y.gpu === true)) || (y.free.cpuPct - x.free.cpuPct)));
  return [...order(cand.filter((c) => c.now)).map((c) => ({ ...c, queued: false })),
          ...order(cand.filter((c) => !c.now)).map((c) => ({ ...c, queued: true }))];
}

// The box a deployment's shares are ALREADY judged against: the enclave
// holding its lease. That runner applies an owner's version change / resize in
// place and gates it on ITS OWN card and node (supervisor minSharesOf), so
// once a lease exists the fleet-wide aggregate is the wrong ruler in both
// directions - it is the SMALLEST box on every axis (over-asks: a version this
// deployment can run reads as unaffordable), while the relay's best-box
// /v1/pricing numbers under-ask on any smaller runner.
// `d` is the ledger record (runner bytes32 + leaseUntil), `rows` the relay's
// /enclaves table, whose row `id` IS that runner. Returns { row, name, spec }
// or null when nothing is pinned - no live lease (the next claim may come from
// any box, so the aggregate's over-ask is right again), an unknown runner, or
// no fleet view at all.
const ZERO_B32 = "0x" + "0".repeat(64);
export function leaseHostOf(d, rows, nowMs){
  const runner = String((d && d.runner) || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(runner) || runner === ZERO_B32) return null;
  if (!(Number(d.leaseUntil) * 1000 > (nowMs == null ? Date.now() : nowMs))) return null;
  const row = (rows || []).find((e) => String((e && e.id) || "").toLowerCase() === runner);
  if (!row || !row.availability) return null;
  return { row, name: row.name || String(row.endpoint || "").replace(/^[a-z]+:\/\//, "").split(".")[0] || "its enclave",
           spec: enclaveSpecOf(row), price: enclavePriceOf(row) };
}

export function pickEnclaveFor(v, rows){
  const claiming = (rows || []).filter((e) => e && e.availability
    && (e.availability.claimEnabled === true || (e.availability.claimEnabled == null && !e.tunnel)));
  if (!claiming.length) return { none: "no live enclave is taking work right now" };
  const ranked = rankEnclavesFor(v, rows);
  if (ranked.length) return ranked[0];
  const needsGpu = Number(v && v.vramMb || 0) > 0 || Number(v && v.gpuGflops || 0) > 0;
  // Say which of the two constraints actually bit. "No enclave is big enough"
  // is a lie about a fleet that has the hardware and lacks the weights, and the
  // fix differs per case: attach the volume, pick another model, or resize.
  const wantVols = volsWanted(v);
  const missing = wantVols.filter((n) => !claiming.some((e) => hasVolumes(e.availability, [n])));
  if (missing.length) return { none: `no live enclave carries the model volume ${missing.join(" or ")}` };
  const carriers = wantVols.length ? claiming.filter((e) => hasVolumes(e.availability, wantVols)) : claiming;
  if (!carriers.length)
    return { none: `no single live enclave carries all of ${wantVols.join(" + ")} (a deployment mounts its volumes on ONE box)` };
  // The volumes exist on a box; that box just can't run this app. Name it —
  // otherwise the reader blames the fleet for hardware it does have, on some
  // OTHER box that hasn't got the model.
  if (wantVols.length && carriers.length !== claiming.length){
    const who = carriers.length <= 3 ? carriers.map(nameOf).join(", ") : `${carriers.length} enclaves`;
    return { none: needsGpu && !carriers.some((e) => e.availability.gpu === true)
      ? `this app needs a GPU, and ${who} — the only enclave${carriers.length > 1 ? "s" : ""} carrying ${wantVols.join(" + ")} — ${carriers.length > 1 ? "have" : "has"} none`
      : `${who} carr${carriers.length > 1 ? "y" : "ies"} ${wantVols.join(" + ")}, but ${carriers.length > 1 ? "none has" : "its hardware is not"} big enough for this app's specs` };
  }
  return { none: needsGpu && !claiming.some((e) => e.availability.gpu === true)
    ? "this app needs a GPU and no live enclave has one"
    : "no live enclave's hardware is big enough for this app's specs" };
}
