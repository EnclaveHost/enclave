// supervisor.js isolationEncVolumesRefusal / isolationClaimVerdict for encrypted volumes on the per-app SNP tier, through
// the ISOLATION_SELFTEST seam (the same contract as isolation-claim-gate.test.mjs).
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
const vol = (o = {}) => ({ name: "docs", endpoint: "https://s3.example.com", bucket: "b", ...o });
const cfg = (...v) => JSON.stringify({ encVolumes: v });
const sup = { encVolumes: true, directBootstrap: true };

test("encVolumes: capability, release and guest memory decide; nothing else changes", async () => {
  const cases = [
    { config: "", supports: {}, released: false, policy: { memMiB: 128 }, want: null },
    { config: JSON.stringify({ other: 1 }), supports: {}, released: false, policy: { memMiB: 128 }, want: null },
    { config: JSON.stringify({ encVolumes: [] }), supports: {}, released: false, policy: { memMiB: 128 }, want: null },
    { config: cfg(vol()), supports: {}, released: true, policy: { memMiB: 4096 }, want: /carries them/ },
    { config: cfg(vol()), supports: sup, released: false, policy: { memMiB: 4096 }, want: /carries them/ },
    // the default 1024 MiB volume: 1024 + 1 + 16 = 1041, plus 128 for the runtime and app
    { config: cfg(vol()), supports: sup, released: true, policy: { memMiB: 1168 }, want: /need 1041 MiB/ },
    { config: cfg(vol()), supports: sup, released: true, policy: { memMiB: 1169 }, want: null },
    { config: cfg(vol({ maxMb: 64 }), vol({ name: "b", maxMb: "32" })), supports: sup, released: true, policy: { memMiB: 128 + 66 + 33 }, want: null },
    { config: cfg(vol({ maxMb: 64 }), vol({ name: "b", maxMb: "32" })), supports: sup, released: true, policy: { memMiB: 128 + 66 + 32 }, want: /need 99 MiB/ },
    // (64 MiB -> 66 MiB of tmpfs: 64+1+64/64; 32 -> 33)
    // a malformed cap counts as the default (the guest's parser refuses it at launch)
    { config: cfg(vol({ maxMb: "lots" })), supports: sup, released: true, policy: { memMiB: 1000 }, want: /need 1041 MiB/ },
  ];
  const out = await seam({ encVolumes: cases.map(({ want, ...c }) => c) });
  cases.forEach((c, i) => {
    if (c.want === null) assert.equal(out.encVolumes[i], null, `case ${i}: ${out.encVolumes[i]}`);
    else assert.match(String(out.encVolumes[i]), c.want, `case ${i}`);
  });
});

test("the claim verdict refuses encVolumes on a manager without the capability, before a lease is taken", async () => {
  const POOL = { budget: { memMiB: 32768, cpuPct: 800 }, allocated: { memMiB: 0, cpuPct: 0 }, free: { memMiB: 32768, cpuPct: 800 },
                 guests: 0, overcommitted: false, perGuest: { floorMiB: 1024, runtimeMiB: 384, unitOverheadMiB: 768 } };
  const base = { require: "snp-guest-per-app", gpuMilli: 0, appConfigCid: "", hasSecrets: false, firewall: [], volumes: [], isPublic: true,
                 waf: null, policy: { memMiB: 2048, cpuPercent: 100, vcpus: 1 }, cpuMilli: 1000, listed: "unlisted", guestBootstrap: true };
  const mgr = (s) => ({ backend: "snp-guest-per-app", supports: { gpu: false, secrets: false, config: false, ports: false, directBootstrap: true, ...s }, pool: POOL });
  const out = await seam({ verdicts: [
    { ...base, manager: mgr({}), config: cfg(vol({ maxMb: 64 })) },
    { ...base, manager: mgr({ encVolumes: true }), config: cfg(vol({ maxMb: 64 })) },
    { ...base, manager: mgr({ encVolumes: true }), config: cfg(vol()), policy: { ...base.policy, memMiB: 512 } },
  ] });
  assert.match(String(out.verdicts[0]), /encrypted volumes/);
  assert.ok(!/encrypted volumes/.test(String(out.verdicts[1])), String(out.verdicts[1]));
  assert.match(String(out.verdicts[2]), /guest memory/);
});
