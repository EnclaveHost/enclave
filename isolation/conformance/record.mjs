// record.mjs: the normalized conformance record one platform produces for ONE bundle set, and the rules
// that compare two of them (isolation/contract/RUNTIME.md rule 8: "essentially the same app build works
// everywhere" is a claim about behaviour, not about vectors agreeing).
//
// Both drivers fill the same shape from the SHARED verifier's outputs (isolation/m2/judge.mjs checkRuntime
// through client.mjs on Linux and windows/vbslike/verify/judge-hv.mjs on Windows) and the app's own answers;
// nothing here re-parses a document. The comparator then says, per field, MUST-MATCH (a difference is a
// finding) or PLATFORM (a difference is expected and is stated, never smoothed over).
export const RECORD_VERSION = "enclave-conformance-record/1";

export function emptyRecord(platform) {
  return {
    version: RECORD_VERSION, platform, tier: null, format: null, abi: null,
    image: { sha256: null, kernelSha256: null },
    backend: {},            // what vouches: { measurement } on SNP, { launcherKey, imageSha256 } on Windows
    bundles: {},            // label -> { appId, bytes }
    attest: {},             // label -> { verdict, abi, runtime, selfTest, appIdInReport, bindingOk }
    app: {},                // label -> { hello, echoBytes, echoIntact }
    negatives: {},          // name -> outcome string (MUST-MATCH: the same refusal on both)
    provenance: {},         // name -> which layer produced an outcome (PLATFORM: may differ)
    lifecycle: {},          // name -> boolean or string
    timings: {},            // name -> ms; plus `contention`, a free-text statement of what else was running
    notes: [],
  };
}

// MUST-MATCH: a difference is a finding.
export const MUST_MATCH = [
  ["bundles.*.appId", "the same bundle bytes have the same identity everywhere"],
  ["bundles.*.bytes", "the same bundle bytes"],
  ["attest.*.appIdInReport", "report_data[32:64] is the app ID on both, taken from the bundle's bytes"],
  ["attest.*.abi", "both state the same ABI"],
  ["attest.*.runtime", "the runtime identities are both jit/x86_64 today: a difference in name, version, features, wx or cache is a finding, not a tolerance"],
  ["attest.*.bindingOk", "the ABI/2 binding verifies under the stated identity on both"],
  ["app.*.hello", "the same request gets the same answer, byte for byte"],
  ["app.*.echoIntact", "a large body survives the relay on both"],
  ["negatives.*", "refusals and rejections are the same on both"],
  ["lifecycle.*", "destroy leaves nothing, a crash is retired once, the neighbour is unaffected, on both"],
];
// PLATFORM: expected to differ; reported, never treated as a pass by omission.
export const PLATFORM = [
  ["platform", "linux SNP guest vs Windows HCS child partition"],
  ["tier", "T1 (hardware report) vs T0-hv (launcher-signed, host not excluded)"],
  ["format", "the report format follows the tier"],
  ["attest.*.verdict", "attested (AMD chain) vs monitor-signed (a launcher key the caller chose to trust)"],
  ["attest.*.selfTest", "the W^X scan scope may differ by domain layout"],
  ["backend", "what vouches differs: a launch measurement vs a launcher key and an image hash"],
  ["image.kernelSha256", "the Linux guest kernel differs from the WSL kernel the partitions boot"],
  ["provenance.*", "which layer refused or ended something may differ (the launcher's contract mirror before a partition exists, or the in-guest monitor); the outcome must not"],
  ["timings.*", "never compared: stated with their contention"],
];

function get(o, path) {
  return path.split(".").reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), o);
}
function keysAt(a, b, prefix) {
  const ka = Object.keys(get(a, prefix) || {}), kb = Object.keys(get(b, prefix) || {});
  return [...new Set([...ka, ...kb])].sort();
}
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/** compare(a, b) -> { ok, findings: [{path, a, b, why}], differences: [{path, a, b, why}], checked: n } */
export function compare(a, b) {
  const findings = [], differences = [];
  let checked = 0;
  for (const [pat, why] of MUST_MATCH) {
    const [head, tail] = pat.split(".*");
    if (tail === undefined) {
      checked++;
      if (!same(get(a, pat), get(b, pat))) findings.push({ path: pat, a: get(a, pat), b: get(b, pat), why });
      continue;
    }
    for (const k of keysAt(a, b, head)) {
      const p = `${head}.${k}${tail}`;
      checked++;
      const va = get(a, p), vb = get(b, p);
      if (va === undefined || vb === undefined) findings.push({ path: p, a: va, b: vb, why: "present on one platform only: " + why });
      else if (!same(va, vb)) findings.push({ path: p, a: va, b: vb, why });
    }
  }
  for (const [pat, why] of PLATFORM) {
    const [head, tail] = pat.split(".*");
    const paths = tail === undefined ? [pat] : keysAt(a, b, head).map((k) => `${head}.${k}${tail}`);
    for (const p of paths) {
      const va = get(a, p), vb = get(b, p);
      if (!same(va, vb)) differences.push({ path: p, a: va, b: vb, why });
    }
  }
  return { ok: findings.length === 0, findings, differences, checked };
}
