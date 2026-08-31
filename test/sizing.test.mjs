// Share SIZING on heterogeneous hardware (supervisor.js minSharesOf +
// gpuRouting), driven through the SIZING_SELFTEST seam — same contract as
// POOL_SELFTEST/SWEEP_SELFTEST.
//
// Why this exists (2026-08-31, eyesoff-ai 0x9eb4e600 on metal0). A deployment
// stores its shares as FRACTIONS of one card and one node, resolved against
// whichever box it was created for. eyesoff-ai declares 50 GB of VRAM, which on
// the H200 it was sized for is 36% of a card — so 36% is what it bought and
// what the ledger holds forever. metal0 then joined the claiming fleet with a
// 6.5 GB shielded card, where the SAME 36% is 2.3 GB.
//
// Three things then had to go wrong together, and did:
//   1. pctCeil clamped the requirement at 100%, so "this app needs 7.7 of my
//      cards" came out as "needs 1 card" — a number metal0 could satisfy.
//   2. gpuOptional collapsed the GPU floor to 0 outright, so the requirement
//      was not merely wrong, it was absent.
// The box accepted work no share it can sell could run.
//
// The volume figure corrects the GPU floor only. It is deliberately NOT added
// to the CPU floor: on cores the weights are mmap'd page cache charged to the
// NODE, not the share (wasm_manager._nn_budgets), and billing them twice would
// refuse deployments the box serves perfectly well.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function size(c) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", SIZING_SELFTEST: JSON.stringify(c),
           POOL_SELFTEST: "", SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "",
           ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

// eyesoff-ai 1.0.38 exactly as the catalog carries it
const EYESOFF = { vramMb: 51200, gpuGflops: 320000, memMb: 4096, cpuGflops: 10, gpuOptional: true };
const QWEN38_GB = 25.94;                                  // the volume its config names
const H200   = { cardVramGb: 140.4, cardTflops: 989 };    // kryptos
const METAL0 = { cardVramGb: 6.5, cardTflops: 42.7 };     // the shielded RTX 3070

test("the dial that was bought: 36% is what an H200 makes of a 50 GB app", async () => {
  const r = await size({ ...H200, isGpu: true, min: EYESOFF, gpuMilli: 360, cpuMilli: 120 });
  assert.equal(r.gpuShare, 0.36, "this is where the immutable 36% came from");
  assert.equal(r.onGpu, true);
  assert.equal(r.below, false, "on the hardware it was sized for, the record is servable");
});

test("the same fraction on a 6.5 GB card: the requirement is stated, not clamped", async () => {
  const r = await size({ ...METAL0, isGpu: true, min: EYESOFF, gpuMilli: 360, cpuMilli: 120 });
  assert.equal(r.gpuShare, 7.7, "7.69 whole cards - the honest measure, above 1 on purpose");
  assert.match(r.unmet, /needs 7\.7x this box's whole card \(6\.5 GB/);
  assert.equal(r.onGpu, false, "no share of this card can run it");
  // the clamp is what made this indistinguishable from "one whole card", which
  // is why even a deployment dialled at the full 1.0 used to sail through
  const full = await size({ ...METAL0, isGpu: true, min: EYESOFF, gpuMilli: 1000, cpuMilli: 120 });
  assert.equal(full.onGpu, false, "100% of a 6.5 GB card is still 7.7x short");
});

test("gpuOptional decides what to DO about the requirement, it does not erase it", async () => {
  const soft = await size({ ...METAL0, isGpu: true, min: EYESOFF, gpuMilli: 360, cpuMilli: 120 });
  assert.equal(soft.gpuFloor, 0, "publisher said cores are acceptable: no GPU dial forced");
  assert.equal(soft.gpuShare, 7.7, "but the box still knows what the card would have to be");
  assert.equal(soft.asCpuFallback, true, "so it falls back, deliberately and on the record");
  assert.equal(soft.refusal, null);

  // without the publisher's flag the same app is simply not this box's work
  const hard = await size({ ...METAL0, isGpu: true, min: { ...EYESOFF, gpuOptional: false },
                            gpuMilli: 360, cpuMilli: 120 });
  assert.equal(hard.asCpuFallback, false);
  assert.match(hard.refusal, /GPU work this enclave cannot serve/);
  assert.match(hard.refusal, /the version declares the card required/);
});

test("the owner's envelope may waive their own dial, never the publisher's requirement", async () => {
  // gpu.optional on the deployment envelope + a version that DOES declare a
  // card: the owner cannot sign away what the publisher stated it needs
  const r = await size({ ...METAL0, isGpu: true, min: { ...EYESOFF, gpuOptional: false },
                         gpuMilli: 360, cpuMilli: 120, envelopeOptional: true });
  assert.match(r.refusal, /GPU work this enclave cannot serve/);
  // the same envelope over a version that declares NO card is honoured — but
  // only where something is actually unmet. On a CPU-only box there is no card
  // to buy, and the owner's flag is exactly the licence to run on cores.
  const ok = await size({ ...METAL0, isGpu: false, min: { memMb: 4096, cpuGflops: 10 },
                          gpuMilli: 360, cpuMilli: 120, envelopeOptional: true });
  assert.equal(ok.refusal, null);
  assert.equal(ok.asCpuFallback, true);
  // and where nothing is unmet the question never arises: a GPU box just hands
  // over the slice the deployment bought, whether or not the app asked for it
  const moot = await size({ ...METAL0, isGpu: true, min: { memMb: 4096, cpuGflops: 10 },
                            gpuMilli: 360, cpuMilli: 120, envelopeOptional: true });
  assert.equal(moot.onGpu, true);
  assert.equal(moot.asCpuFallback, false);
  assert.equal(moot.unmet, null);
});

test("a volume never inflates the CPU floor - the node is charged, not the share", async () => {
  // The symmetry this must NOT have. On cores the weights are mmap'd page cache
  // the platform charges to the NODE: wasm_manager's ggml budget is node RAM
  // "independent of share", and a 4% tenant may legitimately map a 17 GB GGUF.
  // Adding the volume to this floor would refuse deployments the box then
  // serves perfectly well - the mistake that comment already records.
  const blind = await size({ ...METAL0, isGpu: true, min: EYESOFF, gpuMilli: 360, cpuMilli: 120 });
  const seen  = await size({ ...METAL0, isGpu: true, volGb: QWEN38_GB, min: EYESOFF,
                             gpuMilli: 360, cpuMilli: 120 });
  assert.equal(seen.needCpu, blind.needCpu, "26 GB of weights move the CPU floor not at all");
  assert.equal(seen.needCpu, 0.07, "the app's own declaration is the whole CPU floor");
  assert.equal(seen.below, false);
});

test("the CPU floor is the same whether the card or the cores carry the model", async () => {
  const onCard  = await size({ ...H200, isGpu: true, volGb: QWEN38_GB, min: EYESOFF,
                               gpuMilli: 360, cpuMilli: 120 });
  const onCores = await size({ ...METAL0, isGpu: true, volGb: QWEN38_GB, min: EYESOFF,
                               gpuMilli: 360, cpuMilli: 120 });
  assert.equal(onCard.onGpu, true);
  assert.equal(onCores.onGpu, false, "7.7x the card: it falls back to cores");
  assert.equal(onCard.needCpu, onCores.needCpu, "routing changes, the share floor does not");
  assert.equal(onCard.needCpu, 0.07);
});

test("a volume corrects an under-declared card figure but never invents one", async () => {
  // publisher declared 8 GB; the volume its config names is 26 GB
  const under = { vramMb: 8192, gpuGflops: 0, memMb: 4096, cpuGflops: 0 };
  const bare = await size({ ...H200, isGpu: true, min: under, gpuMilli: 100, cpuMilli: 100 });
  const withVol = await size({ ...H200, isGpu: true, volGb: QWEN38_GB, min: under,
                               gpuMilli: 100, cpuMilli: 100 });
  assert.equal(bare.gpuShare, 0.06, "8 GB of a 140.4 GB card");
  assert.equal(withVol.gpuShare, 0.19, "26 GB of it — the config outranks the stale declaration");

  // a version that declared NO card is asking for cores; a volume must not
  // turn every CPU-only LLM app into card-bound work
  const cpuOnly = await size({ ...METAL0, isGpu: true, volGb: QWEN38_GB,
                               min: { vramMb: 0, gpuGflops: 0, memMb: 4096, cpuGflops: 0 },
                               gpuMilli: 0, cpuMilli: 500 });
  assert.equal(cpuOnly.gpuShare, 0, "no declared card plus a volume is still no card");
  assert.equal(cpuOnly.needCpu, 0.07, "and the CPU floor stays the app's own declaration");
  assert.equal(cpuOnly.below, false);
});

test("a CPU-only enclave reaches the same verdict by the same route", async () => {
  const r = await size({ ...METAL0, isGpu: false, volGb: QWEN38_GB, min: EYESOFF,
                         gpuMilli: 360, cpuMilli: 120 });
  assert.equal(r.unmet, "this enclave has no card");
  assert.equal(r.asCpuFallback, true, "soft GPU: cores are acceptable");
  assert.equal(r.needCpu, 0.07);
  assert.equal(r.below, false);
});
