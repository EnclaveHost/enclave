// A running Shield guest is RESUMED (its own reservation credited) only when guestd holds it under exactly the record
// the spawn would send - for EVERY measured Shield model the production supervisor runs, Z-Image-Turbo included.
// Regression (2026-10-21, metal0 lease-gas activation): the lease-gas candidate was built from main, which never got the
// metal0 supervisor's Shield model table (Projects/enclave 3dfeb4c0c..2857356cd). For a Z-Image deployment its
// isolatedInference threw, considerClaim's resume credit caught that as "not the same record", and the guest's own
// reserved room then failed "no free capacity for those shares here right now"; the claim gate then held new claims
// ("own lease not yet resumed"). Through the self-test seams of the real supervisor.js:
//   - the Z-Image record the spawn derives (8 vCPUs, cpuPercent 800, >= 5760 MiB) is a pinned digest, and the held guest
//     carrying it is the same record; every other field (share, component, version, runtime, model) is NOT;
//   - the claim verdict admits Z-Image at its 10% contract minimum, refuses below it, refuses a share whose RAM cannot
//     hold the model, and refuses a new guest the pool cannot fit unless it is this deployment's own held same record;
//   - the other two models are unchanged.
// Optional evidence inputs: PROD_SUPERVISOR (the production file, image dist-sdshield-2857356cd's /app/supervisor.js)
// must derive the same digests; FROZEN_CANDIDATE_SUPERVISOR (the unrepaired candidate) must reproduce the refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");
const TIER = "snp-guest-per-app";
const quiet = { SECRET: "test-secret", INSTANCE_SELFTEST: "", POOL_SELFTEST: "", SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "",
  CFG_EDIT_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
  APP_CERT_DOMAIN: "", DNS_API: "" };
async function run(file, env) {
  const { stdout } = await pexec(process.execPath, [file], { env: { ...process.env, ...quiet, ...env } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}
const pool = (c, file = SUPERVISOR) => run(file, { ISOLATION_BACKEND: TIER, GUEST_POOL_SELFTEST: JSON.stringify(c), ISOLATION_SELFTEST: "",
  NODE_RAM_GB: "6", NODE_VCPUS: "4", NODE_GFLOPS: "250", SELL_CPU_PRICE6: "", SELL_GPU_PRICE6: "" });
const gate = (c, file = SUPERVISOR) => run(file, { ISOLATION_BACKEND: TIER, ISOLATION_SELFTEST: JSON.stringify(c), ISOLATION_RELEASE: "1",
  GUEST_POOL_SELFTEST: "" });

const Z = "z-image-turbo-q4km-sd", Q = "qwen2.5-0.5b-q8-gguf", B = "qwen3.8-27b-mtp-q4-vl-gguf";
const RT = "49".repeat(32), APP = "0x" + "ab".repeat(32);
const g = { ref: `catalog://${APP}/3`, wasmRef: "ipfs://bafkreizimagecomponent", min: { memMb: 2048 } };
// sha256 of the canonical derivation record (derivationDigest of isolationSpawnDerivation) for g, runtime RT, no ports
const PINNED = { [Z]: "a34c60a995a07e8ec95ded07c7aee766045240d4c5ffe01d66245d051dd0e870",   // policy {800, 5760, 8}
                 [Q]: "adb5b08fa3a2e7f67f757b9290c760fe30c3be070e0a88a4d065edf66312bc7b" };  // policy {100, 2048, 1}
const recordOf = (inference) => ({ recordOf: { g, runtimeId: RT, ports: [], inference } });

test("a held Z-Image guest is the same record on resume; every other field is a replacement", async () => {
  assert.equal((await pool(recordOf({ model: Z, gpuMilli: 100 }))).recordOf, PINNED[Z]);
  assert.equal((await pool(recordOf({ model: Q, gpuMilli: 70 }))).recordOf, PINNED[Q], "the 0.5B record is unchanged");
  const held = { name: "0x" + "da".repeat(32), status: "running", recordSha256: PINNED[Z], runtimeId: RT };
  const inf = { model: Z, gpuMilli: 100 };
  const r = await pool({ sameRecord: [
    { held, g, firewall: [], runtimeId: RT, inference: inf },                                          // the same guest
    { held, g, firewall: [], runtimeId: RT, inference: { model: Z, gpuMilli: 200 } },                  // another share
    { held, g: { ...g, wasmRef: "ipfs://bafkreiothercomponent" }, firewall: [], runtimeId: RT, inference: inf },
    { held, g: { ...g, ref: `catalog://${APP}/4` }, firewall: [], runtimeId: RT, inference: inf },     // another version
    { held, g: { ...g, min: { memMb: 8192 } }, firewall: [], runtimeId: RT, inference: inf },         // another policy
    { held: { ...held, runtimeId: "4a".repeat(32) }, g, firewall: [], runtimeId: RT, inference: inf }, // another runtime
    { held, g, firewall: ["http:8080"], runtimeId: RT, inference: inf },                              // another port
    { held, g, firewall: [], runtimeId: RT, inference: { model: Q, gpuMilli: 100 } },                 // another model
    { held, g, firewall: [], runtimeId: RT, inference: null },                                         // not inference
    { held: { ...held, recordSha256: PINNED[Q] }, g, firewall: [], runtimeId: RT, inference: inf },   // another record
  ] });
  assert.deepEqual(r.sameRecord, [true, false, false, false, false, false, false, false, false, false]);
});

const GUESTD = { backend: TIER, supports: { gpu: true, release: true, secrets: false, egress: false, config: false, ports: false } };
const POOL = { budget: { memMiB: 90112, cpuPct: 2400 }, allocated: { memMiB: 0, cpuPct: 0 }, free: { memMiB: 75000, cpuPct: 1900 },
               guests: 0, overcommitted: false, perGuest: { floorMiB: 1024, runtimeMiB: 384, unitOverheadMiB: 768 } };
const manager = { ...GUESTD, inference: { models: [Q, B, Z], modelFloorsMiB: { [Z]: 6144 }, cardFreeBytes: 31 * 2 ** 30 }, pool: POOL };
const clean = { require: TIER, manager, gpuMilli: 100, config: "", appConfigCid: "", hasSecrets: false, firewall: [], volumes: [Z],
  isPublic: true, waf: null, policy: { cpuPercent: 100, memMiB: 2048, vcpus: 1 }, cpuMilli: 500, listed: "listed" };
const tight = { ...POOL, free: { memMiB: 4000, cpuPct: 700 } };   // not room for an 8-vCPU Z-Image guest on its own

test("the claim verdict admits Z-Image as production does, and never over capacity or under its RAM", async () => {
  const r = await gate({ verdicts: [
    clean,                                                                                   // 0 admitted
    { ...clean, gpuMilli: 90 },                                                              // 1 under the 10% minimum
    { ...clean, manager: { ...manager, inference: { ...manager.inference, models: [Q, B] } } }, // 2 model not released here
    { ...clean, manager: { ...manager, pool: tight } },                                      // 3 a new guest that does not fit
    { ...clean, manager: { ...manager, pool: tight }, held: { status: "running", reserved: { memMiB: 7680, cpuPct: 800 } },
      heldSameRecord: true },                                                                // 4 its OWN held guest: resumed
    { ...clean, manager: { ...manager, pool: { ...tight, free: { memMiB: 0, cpuPct: 0 } } },
      held: { status: "running", reserved: { memMiB: 1024, cpuPct: 100 } }, heldSameRecord: false }, // 5 a replacement
    { ...clean, cpuMilli: 50 },                                                              // 6 a share whose RAM cannot hold it
    { ...clean, manager: { ...manager, inference: { ...manager.inference, modelFloorsMiB: {} } } },  // 7 unbudgeted
  ], derive: [{ catalogRef: g.ref, wasmRef: g.wasmRef, memMb: 2048, runtimeId: RT, ports: [], inference: { model: Z, gpuMilli: 100 } }] });
  assert.equal(r.verdicts[0], null, String(r.verdicts[0]));
  assert.match(r.verdicts[1], /10% for Z-Image/);
  assert.match(r.verdicts[2], /Shield model release is not ready/);
  assert.ok(r.verdicts[3], "a new Z-Image guest the pool cannot fit is refused");
  assert.equal(r.verdicts[4], null, String(r.verdicts[4]));
  assert.ok(r.verdicts[5], "a replacement still needs real room");
  assert.match(r.verdicts[6], /requires 5760 MiB/, "purchased RAM is enforced for Z-Image too");
  assert.match(r.verdicts[7], /no model RAM requirement/);
  assert.deepEqual(r.derive[0].policy, { cpuPercent: 800, memMiB: 5760, vcpus: 8 });
  assert.equal(r.derive[0].derivation, "enclave-catalog-bundle/4");
});

test("the 0.5B and 27B models are judged exactly as before", async () => {
  const r = await gate({ verdicts: [
    { ...clean, volumes: [Q], gpuMilli: 60, manager: { ...manager, inference: { ...manager.inference, modelFloorsMiB: { [Q]: 8192 } } } },
    { ...clean, volumes: [B], gpuMilli: 400, manager: { ...manager, inference: { ...manager.inference, modelFloorsMiB: { [B]: 73728 } } } },
    { ...clean, volumes: ["llama-70b"], gpuMilli: 500 },
  ] });
  assert.match(r.verdicts[0], /at least 7% for 0\.5B/);
  assert.match(r.verdicts[1], /50% for 27B/);
  assert.match(r.verdicts[2], /requires a supported model/);
});

test("evidence: production's own supervisor derives the same records", { skip: !process.env.PROD_SUPERVISOR }, async () => {
  for (const [model, gm] of [[Z, 100], [Q, 70]])
    assert.equal((await pool(recordOf({ model, gpuMilli: gm }), process.env.PROD_SUPERVISOR)).recordOf, PINNED[model], model);
});

test("evidence: the frozen candidate reproduces the refusal", { skip: !process.env.FROZEN_CANDIDATE_SUPERVISOR }, async () => {
  const f = process.env.FROZEN_CANDIDATE_SUPERVISOR;
  const r = await gate({ verdicts: [clean], derive: [{ catalogRef: g.ref, wasmRef: g.wasmRef, memMb: 2048, runtimeId: RT, ports: [],
    inference: { model: Z, gpuMilli: 100 } }] }, f);
  assert.match(r.verdicts[0], /requires a supported model/, "isolatedInference throws for Z-Image: the resume credit's try/catch makes it false");
  assert.deepEqual(r.derive[0].policy, { cpuPercent: 100, memMiB: 2048, vcpus: 1 }, "no Z-Image guest shape");
  assert.notEqual((await pool(recordOf({ model: Z, gpuMilli: 100 }), f)).recordOf, PINNED[Z], "so it can never match production's held record");
});
