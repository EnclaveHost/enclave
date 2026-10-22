// supervisor.js isolationModelVolumesRefusal / isolatedInference / isolationClaimVerdict for general model volumes on
// the per-app SNP tier, through the ISOLATION_SELFTEST seam (the same contract as isolation-encvol-gate.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");
async function seam(c, backend = "snp-guest-per-app") {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", ISOLATION_BACKEND: backend, ISOLATION_SELFTEST: JSON.stringify(c), ISOLATION_RELEASE: "",
           INSTANCE_SELFTEST: "", POOL_SELFTEST: "", SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", CFG_EDIT_SELFTEST: "",
           ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}
const VOLS = [{ name: "qwen-a", backend: "ggml", kind: "model" }, { name: "data-b", backend: "none", kind: "model" },
              { name: "qwen2.5-0.5b-q8-gguf", backend: "ggml", kind: "inference" }];
const mgr = (s = {}, volumes = VOLS) => ({ supports: { modelVolumes: true, nnPreload: true, ...s }, volumes });

test("model volumes: the release, the table, the host's store and the ggml preload decide; none attached changes nothing", async () => {
  const cases = [
    { volumes: [], manager: null, released: false, want: null },
    { volumes: ["", " "], manager: null, released: false, want: null },
    { volumes: ["qwen-a"], manager: mgr(), released: false, want: /release or owner-committed config/ },
    { volumes: ["qwen-a"], manager: mgr({ modelVolumes: false }), released: true, want: /carries no measured model-volume table/ },
    { volumes: ["qwen-a", "llama-70b"], manager: mgr(), released: true, want: /doesn't carry: llama-70b/ },
    // the Shield inference model is not a general model volume, whatever the host lists for inference
    { volumes: ["qwen2.5-0.5b-q8-gguf"], manager: mgr(), released: true, want: /doesn't carry: qwen2\.5-0\.5b-q8-gguf/ },
    { volumes: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], manager: mgr(), released: true, want: /at most 8/ },
    { volumes: ["qwen-a"], manager: mgr({ nnPreload: false }), released: true, want: /no measured wasi-nn ggml preload/ },
    { volumes: ["data-b"], manager: mgr({ nnPreload: false }), released: true, want: null },
    { volumes: [" qwen-a ", "data-b", "qwen-a"], manager: mgr(), released: true, want: null },
  ];
  const out = await seam({ modelVolumes: cases.map(({ want, ...c }) => c) });
  cases.forEach((c, i) => {
    if (c.want === null) assert.equal(out.modelVolumes[i], null, `case ${i}: ${out.modelVolumes[i]}`);
    else assert.match(String(out.modelVolumes[i]), c.want, `case ${i}`);
  });
});

test("the Shield GPU path is unchanged: only a GPU share is inference, with its two models", async () => {
  const out = await seam({ inference: [
    { gpuMilli: 0, volumes: ["qwen-a"] },
    { gpuMilli: 100, volumes: ["qwen2.5-0.5b-q8-gguf"] },
    { gpuMilli: 100, volumes: ["qwen-a"] },
    { gpuMilli: 400, volumes: ["qwen3.8-27b-mtp-q4-vl-gguf"] },
  ] });
  assert.equal(out.inference[0], null, "a CPU deployment's volumes are model volumes, not inference");
  assert.deepEqual(out.inference[1], { model: "qwen2.5-0.5b-q8-gguf", gpuMilli: 100 });
  assert.match(out.inference[2].error, /supported model/);
  assert.match(out.inference[3].error, /50% for 27B/);
});

test("the claim verdict refuses model volumes before a lease is taken, and admits them with the capability", async () => {
  const POOL = { budget: { memMiB: 32768, cpuPct: 800 }, allocated: { memMiB: 0, cpuPct: 0 }, free: { memMiB: 32768, cpuPct: 800 },
                 guests: 0, overcommitted: false, perGuest: { floorMiB: 1024, runtimeMiB: 384, unitOverheadMiB: 768 } };
  const base = { require: "snp-guest-per-app", gpuMilli: 0, appConfigCid: "", hasSecrets: false, firewall: [], isPublic: true,
                 waf: null, policy: { memMiB: 2048, cpuPercent: 100, vcpus: 1 }, cpuMilli: 1000, listed: "unlisted", guestBootstrap: true,
                 config: JSON.stringify({ volumes: ["qwen-a"] }) };
  const m = (s, volumes = VOLS) => ({ backend: "snp-guest-per-app", supports: { gpu: false, secrets: false, config: false, ports: false, directBootstrap: true, ...s },
                                       pool: POOL, volumes });
  const out = await seam({ verdicts: [
    { ...base, volumes: ["qwen-a"], manager: m({}) },
    { ...base, volumes: ["qwen-a"], manager: m({ modelVolumes: true, nnPreload: true }) },
    { ...base, volumes: ["qwen-a"], manager: m({ modelVolumes: true, nnPreload: true }, []) },
  ] });
  assert.match(String(out.verdicts[0]), /model-volume table/);
  assert.ok(!/model volume/.test(String(out.verdicts[1])), String(out.verdicts[1]));
  assert.match(String(out.verdicts[2]), /doesn't carry: qwen-a/);
});
