// Console share math vs the runners' claim gate. The runners are authoritative:
// they divide an app's exact catalog specs by their PROBED hardware and refuse
// any deployment below the result (supervisor.js minSharesOf/gpuShareOf/
// cpuShareOf). A created deployment's shares are immutable and its funding is
// non-custodial accounting with no withdraw — so a console floor even 1% below
// the runners' minimum sells a deployment that is claimable by NOBODY, forever
// (2026-07-14, 0xf3d976a0…: the old hardcoded "141 GB" card vs the H200's
// probed 140.4 GiB made the console sell 91% of a card whose runner wanted 92%).
// These tests pin the two invariants that make that impossible:
//   1. the console divides by ADOPTED live hardware, exactly like the runner;
//   2. wherever the two can still diverge, the console lands ABOVE, never below.
// NOTE: tests in this file share pricing.js's adopted-spec module state and
// run in order — the fallback assertions come first, adoption after.

import { test } from "node:test";
import assert from "node:assert/strict";
import { minPctsOf, adoptServerSpec, serverSpec, shareRates, enclaveSpecOf, enclavePriceOf, pickEnclaveFor, rankEnclavesFor, leaseHostOf,
  fleetPrice, adoptFleetPrice, FALLBACK_CPU_NODE_RATE } from "../site/js/core/pricing.js";

// Reference copy of the RUNNER's minimum-share math (supervisor.js: pctCeil,
// gpuShareOf, cpuShareOf, minSharesOf with MIN_COMPUTE_PCT=1). Keep in sync.
function runnerMins(v, hw) {
  const pc = (x) => Math.min(100, Math.max(1, Math.ceil(x * 100 - 1e-9)));
  const cpu = (v.memMb || v.cpuGflops)
    ? pc(Math.max((v.memMb || 0) / (hw.nodeRamGb * 1024), (v.cpuGflops || 0) / hw.nodeGflops)) : 0;
  const gpu0 = (v.vramMb || v.gpuGflops)
    ? pc(Math.max((v.vramMb || 0) / 1024 / hw.cardVramGb, (v.gpuGflops || 0) / 1000 / hw.cardTflops)) : 0;
  return { gpuPct: gpu0 > 0 ? Math.max(gpu0, cpu) : 0, cpuPct: cpu };
}

// image-generator 1.0.2 — the version that produced the stuck deployment
const IMAGE_GEN = { vramMb: 131072, gpuGflops: 50000, memMb: 5000, cpuGflops: 5 };
const H200 = { cardVramGb: 140.4, cardTflops: 989, nodeVcpus: 16, nodeRamGb: 64, nodeGflops: 1000 };

test("fallback floors already match the live H200 (the 0xf3d976a0 regression)", () => {
  const s = serverSpec();
  assert.equal(s.live, false, "these assertions must run before any adoption");
  assert.equal(s.cardVramGb, 140.4, "fallback card must be the PROBED GiB, not the 141 datasheet");
  const m = minPctsOf(IMAGE_GEN);
  assert.deepEqual(m, { gpuPct: 92, cpuPct: 8 });   // the old 141 constant said 91 — unclaimable
  assert.deepEqual(m, runnerMins(IMAGE_GEN, H200));
});

test("adopting a live /availability payload aligns console and runner exactly", () => {
  assert.equal(adoptServerSpec({ gpu: true, ...H200 }), true);
  assert.equal(serverSpec().live, true);
  assert.deepEqual(minPctsOf(IMAGE_GEN), runnerMins(IMAGE_GEN, H200));
});

test("boundary sweep: the console floor NEVER under-sells any runner minimum", () => {
  // cards around the real fleet plus awkward probe values; specs pinned to
  // every whole-percent boundary ±1 MB — exactly where ceil math can split
  for (const card of [79.6, 131.7, 138.25, 139.95, 140.4, 140.41, 141, 143.99]) {
    const hw = { ...H200, cardVramGb: card };
    adoptServerSpec(hw);
    for (let n = 1; n <= 100; n++) {
      const edge = (n / 100) * card * 1024;
      for (const vramMb of [Math.floor(edge) - 1, Math.floor(edge), Math.floor(edge) + 1]) {
        if (vramMb <= 0) continue;
        const v = { vramMb, gpuGflops: 0, memMb: 512, cpuGflops: 0 };
        const site = minPctsOf(v), runner = runnerMins(v, hw);
        assert.ok(site.gpuPct >= runner.gpuPct && site.cpuPct >= runner.cpuPct,
          `under-sell at card=${card} vramMb=${vramMb}: site ${site.gpuPct}/${site.cpuPct} < runner ${runner.gpuPct}/${runner.cpuPct}`);
        assert.equal(site.gpuPct, runner.gpuPct, `gpu floor drift at card=${card} vramMb=${vramMb}`);
      }
    }
  }
});

test("relay spec* fleet-minima outrank the best-box fields", () => {
  // a mixed fleet: capacity view shows the big card, sizing must use the small
  adoptServerSpec({ gpu: true, cardVramGb: 150, specCardVramGb: 140.4, cardTflops: 989, specCardTflops: 989,
                    nodeVcpus: 16, nodeRamGb: 64, specNodeRamGb: 64, nodeGflops: 1000, specNodeGflops: 1000 });
  assert.equal(serverSpec().cardVramGb, 140.4);
  assert.equal(minPctsOf(IMAGE_GEN).gpuPct, 92);   // 128 GiB / 150 would have said 88
});

test("a CPU-only fleet payload cannot zero the GPU axes", () => {
  assert.equal(adoptServerSpec({ gpu: false, cardVramGb: 0, cardTflops: 0, nodeVcpus: 8, nodeRamGb: 32, nodeGflops: 500 }), true);
  const s = serverSpec();
  assert.equal(s.cardVramGb, 140.4, "absent/zero card keeps the previous value (no divide-by-zero)");
  assert.equal(s.nodeRamGb, 32);
  assert.ok(Number.isFinite(minPctsOf(IMAGE_GEN).gpuPct));
});

test("shareRates reads the adopted hardware, not constants", () => {
  adoptServerSpec({ gpu: true, ...H200 });
  const r = shareRates(92, 8);
  assert.ok(Math.abs(r.vramGb - 0.92 * 140.4) < 1e-9);
  assert.ok(Math.abs(r.ramGb - 0.08 * 64) < 1e-9);
});

/* ---- per-enclave targeting (the deploy console's "deploys to X" pick) ---- */

const row = (name, a, extra) => ({ name, endpoint: "https://" + name + ".example", availability: a, ...(extra || {}) });
const GPU_BOX = { gpu: true, claimEnabled: true, ...H200, gpuShareFree: 0.4, cpuShareFree: 0.79 };
const CPU_BOX = { gpu: false, claimEnabled: true, nodeVcpus: 16, nodeRamGb: 64, nodeGflops: 1000, gpuShareFree: 0, cpuShareFree: 0.9 };
const MC = { vramMb: 0, gpuGflops: 0, memMb: 512, cpuGflops: 10 };   // minecraft-shaped CPU app

test("pickEnclaveFor: floors come from the TARGET box, not a fleet minimum", () => {
  // the 2026-07-25 regression, per-enclave: a tiny box in the fleet must not
  // resize a CPU app that lands on the big one — the pick names the big box
  // and sizes 512 MB against ITS 64 GB (1%), never against 3 GB (17%)
  const tiny = row("metal0", { gpu: false, claimEnabled: true, nodeVcpus: 4, nodeRamGb: 3, nodeGflops: 250, cpuShareFree: 1 });
  const t = pickEnclaveFor(MC, [row("kryptos", GPU_BOX), tiny, row("big", CPU_BOX)]);
  assert.equal(t.none, undefined);
  assert.equal(t.name, "big");            // CPU-only box preferred over GPU leftovers
  assert.equal(t.mins.cpuPct, 1);         // 512 MB of 64 GB, not of 3 GB
  assert.equal(t.queued, false);
});

test("pickEnclaveFor: mirrors claim routing (CPU-only first, GPU leftovers as fallback; GPU apps by free card)", () => {
  const cpuApp = pickEnclaveFor(MC, [row("kryptos", GPU_BOX)]);
  assert.equal(cpuApp.name, "kryptos");   // no CPU-only box: GPU leftovers serve it
  const gpuApp = pickEnclaveFor(IMAGE_GEN, [row("small", { ...GPU_BOX, gpuShareFree: 0.3 }), row("kryptos", { ...GPU_BOX, gpuShareFree: 0.95 }), row("big", CPU_BOX)]);
  assert.equal(gpuApp.name, "kryptos");   // most free card wins; CPU boxes never take GPU work
});

test("pickEnclaveFor: a full box queues, a too-small fleet refuses", () => {
  const full = pickEnclaveFor(MC, [row("big", { ...CPU_BOX, cpuShareFree: 0 })]);
  assert.equal(full.name, "big");
  assert.equal(full.queued, true);        // fits the box, waits for capacity — deploys queue on-chain
  const noGpu = pickEnclaveFor(IMAGE_GEN, [row("big", CPU_BOX)]);
  assert.ok(noGpu.none && /GPU/.test(noGpu.none));
  const tooSmall = pickEnclaveFor({ memMb: 128 * 1024, cpuGflops: 0 }, [row("big", CPU_BOX)]);
  assert.ok(tooSmall.none, "an app over every box's whole node must refuse, not queue at 100%");
});

test("pickEnclaveFor: only CLAIMING enclaves count (the relay's serving rule)", () => {
  // a tunnel box without claimEnabled (the metal demo enclave) is invisible;
  // one that SAYS it claims (a Phase C seller) is a real target
  const demo = row("metal0", { gpu: false, nodeVcpus: 4, nodeRamGb: 3, nodeGflops: 250, cpuShareFree: 1 }, { tunnel: true });
  assert.ok(pickEnclaveFor(MC, [demo]).none, "a non-claiming tunnel box serves nobody");
  const seller = row("seller0", { gpu: false, claimEnabled: true, nodeVcpus: 16, nodeRamGb: 64, nodeGflops: 1000, cpuShareFree: 0.5 }, { tunnel: true });
  assert.equal(pickEnclaveFor(MC, [demo, seller]).name, "seller0");
  const hosted = row("cpu1", { gpu: false, nodeVcpus: 16, nodeRamGb: 64, nodeGflops: 1000, cpuShareFree: 0.5 });
  assert.equal(pickEnclaveFor(MC, [hosted]).name, "cpu1", "hosted boxes predate the flag and are grandfathered");
});

test("rankEnclavesFor: the dropdown's list — every host, recommended first, full ones queued at the tail", () => {
  const tiny = row("tiny", { gpu: false, claimEnabled: true, nodeVcpus: 4, nodeRamGb: 3, nodeGflops: 250, cpuShareFree: 1 });
  const full = row("bigfull", { ...CPU_BOX, cpuShareFree: 0 });
  const ranked = rankEnclavesFor(MC, [row("kryptos", GPU_BOX), tiny, full, row("big", CPU_BOX)]);
  // cheapest floor first (big 1% cpu-only, kryptos 1% gpu-leftovers, tiny 17%), full boxes tail
  assert.deepEqual(ranked.map((c) => c.name), ["big", "kryptos", "tiny", "bigfull"]);
  assert.deepEqual(ranked.map((c) => c.queued), [false, false, false, true]);
  assert.equal(ranked[0].name, pickEnclaveFor(MC, [row("kryptos", GPU_BOX), tiny, full, row("big", CPU_BOX)]).name);
  assert.equal(ranked[2].mins.cpuPct, 17);   // the user MAY pick the tiny box — at its own (17%) floor, eyes open
  // a box the app can never fit is not an option at all
  assert.ok(!rankEnclavesFor({ memMb: 8 * 1024, cpuGflops: 0 }, [tiny]).length);
});

/* ---- model volumes are placement, not just config ------------------------ */
// A volume is ATTACHED to a box (Modelwrap on the hosted fleet, dm-verity
// images on a metal box) — it is never fetched on demand. So a deployment that
// names one can only run where it lives, and the target must say so BEFORE the
// signature: the runner's own claim gate refuses the record, and a hint sent to
// a box that declines leaves the deploy sitting in the open queue.
const vol = (...names) => ({ volumes: names.map((name) => ({ name })) });
const LLM = { vramMb: 0, gpuGflops: 0, memMb: 512, cpuGflops: 10, volumes: ["qwen3.5-122b-gguf-merged"] };

test("rankEnclavesFor: only boxes carrying the requested volume are targets", () => {
  const metal = row("metal0", { gpu: false, claimEnabled: true, nodeVcpus: 4, nodeRamGb: 28, nodeGflops: 250, cpuShareFree: 1,
    ...vol("qwen3.5-122b-gguf-merged", "qwen2.5-0.5b-gguf") }, { tunnel: true });
  const kryptos = row("kryptos", { ...GPU_BOX, ...vol("qwen2.5-0.5b-gguf") });
  const ranked = rankEnclavesFor(LLM, [kryptos, metal, row("big", CPU_BOX)]);
  assert.deepEqual(ranked.map((c) => c.name), ["metal0"],
    "the bigger, cheaper boxes cannot host it — they do not carry the volume");
  // and without the volume constraint the same fleet ranks the big boxes first
  assert.equal(rankEnclavesFor({ ...LLM, volumes: [] }, [kryptos, metal, row("big", CPU_BOX)])[0].name, "big");
});

test("pickEnclaveFor: names the missing volume instead of blaming the hardware", () => {
  const kryptos = row("kryptos", { ...GPU_BOX, ...vol("qwen2.5-0.5b-gguf") });
  const t = pickEnclaveFor(LLM, [kryptos, row("big", CPU_BOX)]);
  assert.ok(t.none && /qwen3\.5-122b-gguf-merged/.test(t.none), t.none);
  assert.ok(!/big enough/.test(t.none), "the fleet has the hardware; it lacks the weights");
});

test("pickEnclaveFor: volumes split across two boxes host nothing (a deployment mounts on ONE)", () => {
  const a = row("a", { ...CPU_BOX, ...vol("v1") }), b = row("b", { ...CPU_BOX, ...vol("v2") });
  const t = pickEnclaveFor({ ...MC, volumes: ["v1", "v2"] }, [a, b]);
  assert.ok(t.none && /ONE box/.test(t.none), t.none);
  assert.equal(pickEnclaveFor({ ...MC, volumes: ["v1"] }, [a, b]).name, "a");
});

test("rankEnclavesFor: a box that advertises no volume list is not a target for volume work", () => {
  // an enclave whose /availability carries no `volumes` key cannot tell us what
  // it has; treating silence as "carries everything" is how a claim hint goes
  // to a box that declines (seen for real when a stale wasm-manager pin made
  // /health drop to its unauthenticated subset)
  const silent = row("silent", CPU_BOX);
  assert.ok(!rankEnclavesFor(LLM, [silent]).length);
  assert.equal(rankEnclavesFor({ ...LLM, volumes: [] }, [silent]).length, 1, "no volumes asked for, no constraint");
});

/* ---- the lease holder's hardware (a version change / resize, My Apps) ---- */

const RUNNER = "0x" + "ef".repeat(32);
const NOW = 1785000000000;
const leased = { runner: RUNNER, leaseUntil: Math.floor(NOW / 1000) + 1800 };
const FLEET = [{ id: RUNNER, name: "kryptos", endpoint: "https://kryptos.example", availability: GPU_BOX },
               { id: "0x" + "11".repeat(32), name: "metal0",
                 availability: { gpu: false, claimEnabled: true, nodeVcpus: 4, nodeRamGb: 3, nodeGflops: 250, cpuShareFree: 1 } }];

test("leaseHostOf: a live lease sizes on ITS box, not the fleet aggregate", () => {
  // the aggregate is the fleet MINIMUM (metal0's 3 GB node): 512 MB reads as
  // 17% there and 1% on the box actually running it, which is the only box
  // whose claim gate the switch has to pass
  adoptServerSpec({ gpu: true, ...H200, specNodeRamGb: 3, specNodeGflops: 250, specNodeVcpus: 4 });
  assert.equal(minPctsOf(MC).cpuPct, 17, "aggregate mode still over-asks (unleased work may land anywhere)");
  const hw = leaseHostOf(leased, FLEET, NOW);
  assert.equal(hw.name, "kryptos");
  assert.equal(minPctsOf(MC, hw.spec).cpuPct, 1);
  adoptServerSpec({ gpu: true, ...H200, specNodeRamGb: 64, specNodeGflops: 1000, specNodeVcpus: 16 });
});

test("leaseHostOf: nothing is pinned without a live lease in the fleet view", () => {
  assert.equal(leaseHostOf({ ...leased, leaseUntil: Math.floor(NOW / 1000) - 1 }, FLEET, NOW), null, "expired lease names an EX-runner");
  assert.equal(leaseHostOf({ runner: "0x" + "0".repeat(64), leaseUntil: Math.floor(NOW / 1000) + 1800 }, FLEET, NOW), null);
  assert.equal(leaseHostOf(leased, [], NOW), null, "runner absent from the fleet view");
  assert.equal(leaseHostOf(leased, null, NOW), null, "no fleet view at all");
  assert.equal(leaseHostOf(null, FLEET, NOW), null);
  assert.equal(leaseHostOf({ ...leased, runner: "0x" + "ef".repeat(31) }, FLEET, NOW), null, "malformed runner");
});

test("leaseHostOf: the host's own axes, unknown ones on the safe constants", () => {
  const cpuOnly = [{ id: RUNNER, name: "seller0", availability: { gpu: false, claimEnabled: true, nodeVcpus: 8, nodeRamGb: 32, nodeGflops: 500 } }];
  const hw = leaseHostOf(leased, cpuOnly, NOW);
  assert.equal(hw.spec.nodeRamGb, 32);
  assert.equal(hw.spec.cardVramGb, 140.4, "a CPU-only host reports no card: the GPU axes keep the constants, never zero");
  assert.ok(Number.isFinite(minPctsOf(IMAGE_GEN, hw.spec).gpuPct));
});

test("enclaveSpecOf: per-axis fallback for old builds", () => {
  const s = enclaveSpecOf(row("x", { gpu: true, cardVramGb: 79.6 }));
  assert.equal(s.cardVramGb, 79.6);
  assert.equal(s.nodeRamGb, 64);          // omitted axes keep the safe constants
});

/* ---- price is per enclave (rev 8) -----------------------------------------
   Each enclave posts what its whole machine costs; a deployment pays that
   fraction of whichever one claims it. So "what does this cost" is answered by
   the CHEAPEST live enclave (the box a new deployment lands on), and "what
   would a resize cost" by the box already holding the lease. Getting this
   wrong doesn't just misprice a readout: the deploy form's default rate cap
   comes from it, and a cap below what any enclave charges is a deployment
   nobody can claim. */

test("adoptFleetPrice: the fleet's cheapest posted price, with the constants as the only fallback", () => {
  const before = fleetPrice();
  assert.equal(before.live, false, "untouched, the pre-fetch constants stand");
  assert.equal(before.node, FALLBACK_CPU_NODE_RATE);

  // the relay aggregate carries the minimum over claiming enclaves
  assert.equal(adoptFleetPrice({ cheapestCpuPricePerSec6: 556, cheapestGpuPricePerSec6: 1200 }), true);
  const p = fleetPrice();
  assert.equal(p.live, true);
  assert.equal(p.node, 0.000556);
  assert.equal(p.full, 0.0012);
  assert.equal(adoptFleetPrice({ cheapestCpuPricePerSec6: 556, cheapestGpuPricePerSec6: 1200 }), false, "no change, no re-render");

  // a single enclave's own ask works too (the console can point at one box)
  assert.equal(adoptFleetPrice({ askCpuPricePerSec6: 834, askGpuPricePerSec6: 1667 }), true);
  assert.equal(fleetPrice().node, 0.000834);
  // a fleet that posts nothing leaves the last known price alone
  assert.equal(adoptFleetPrice({ enclaves: 2 }), false);
  assert.equal(fleetPrice().node, 0.000834);
});

test("shareRates prices against the enclave you name, not a platform constant", () => {
  adoptFleetPrice({ cheapestCpuPricePerSec6: 834, cheapestGpuPricePerSec6: 1667 });
  const dear = { full: 0.003334, node: 0.001668 };
  assert.equal(shareRates(0, 100).rate, 0.000834, "no price named: the fleet's cheapest");
  assert.equal(shareRates(0, 100, undefined, dear).rate, 0.001668);
  assert.equal(shareRates(50, 10).rate, 0.5 * 0.0016670 + 0.1 * 0.000834);
});

test("enclavePriceOf: a row's own posted price, the fleet's when it posts none", () => {
  adoptFleetPrice({ cheapestCpuPricePerSec6: 834, cheapestGpuPricePerSec6: 1667 });
  const priced = enclavePriceOf(row("seller0", { gpu: true, claimEnabled: true, askCpuPricePerSec6: 1668, askGpuPricePerSec6: 3334 }));
  assert.equal(priced.node, 0.001668);
  assert.equal(priced.full, 0.003334);
  const silent = enclavePriceOf(row("old", { gpu: true, claimEnabled: true }));
  assert.deepEqual(silent, { full: 0.0016670, node: 0.000834 });
});

test("rankEnclavesFor puts the CHEAPEST box for this app first, not just the biggest", () => {
  adoptFleetPrice({ cheapestCpuPricePerSec6: 834, cheapestGpuPricePerSec6: 1667 });
  // both fit the app; the big box needs a smaller share but charges much more
  const big = row("dear-big", { gpu: false, claimEnabled: true, cpuShareFree: 1, nodeRamGb: 64, nodeVcpus: 16, nodeGflops: 1000,
                                askCpuPricePerSec6: 8340 });
  const small = row("cheap-small", { gpu: false, claimEnabled: true, cpuShareFree: 1, nodeRamGb: 8, nodeVcpus: 4, nodeGflops: 500,
                                     askCpuPricePerSec6: 400 });
  const ranked = rankEnclavesFor(MC, [big, small]);
  assert.deepEqual(ranked.map((r) => r.name), ["cheap-small", "dear-big"]);
  assert.ok(ranked[0].minRate < ranked[1].minRate);
  // and with equal prices the old rule stands: the box asking for less of itself
  const evenBig = row("big", { ...big.availability, askCpuPricePerSec6: 834 });
  const evenSmall = row("small", { ...small.availability, askCpuPricePerSec6: 834 });
  assert.deepEqual(rankEnclavesFor(MC, [evenSmall, evenBig]).map((r) => r.name), ["big", "small"]);
});
