// Issues work/cli-final-parity/ledger17-client-readiness.json ONLY when every named log shows a passing run
// (node:test "# fail 0" with "# pass N" > 0, and the memory guard's exit=0). Hashes are computed from the files.
// usage: node make-readiness.mjs   (cwd: work/cli-final-parity)
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const C = path.resolve("."), W = path.resolve(C, "..");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const runs = JSON.parse(fs.readFileSync(path.join(C, "readiness-runs.json"), "utf8"));   // [{ name, log, guard, entry, tests }]
const evidence = [];
for (const r of runs) {
  const log = fs.readFileSync(path.join(C, r.log), "utf8"), guard = fs.readFileSync(path.join(C, r.guard), "utf8");
  const pass = Number((log.match(/^# pass (\d+)$/m) || [])[1] || 0), fail = Number((log.match(/^# fail (\d+)$/m) || [])[1] ?? NaN);
  const guardOk = /\[memory-guard\] exit=0\b/.test(guard);
  if (!(pass > 0 && fail === 0 && guardOk)) { console.error(`NOT ISSUED: ${r.name} did not pass (pass ${pass}, fail ${fail}, guard ok ${guardOk})`); process.exit(1); }
  evidence.push({ ...r, pass, fail, logSha256: sha(path.join(C, r.log)) });
}
const T = (f) => path.join(C, "tree", f);
const files = ["supervisor.js", "cli/enclave.mjs", "cli/independent.mjs", "cli/independent-signer.mjs", "cli/custody-independent.mjs",
  "network/lease-reader.mjs", "network/management-auth.mjs", "addressbook.js", "test/lease17-release.test.mjs", "test/cli-move-lease17.test.mjs",
  "test/fixtures/lease17-candidate.json", "test/helpers/cli-independent-rig.mjs", "test/helpers/move-release-rig.mjs"];
const out = {
  format: "enclave-ledger17-client-readiness/v1",
  issuedBy: "claude (CLI final parity worker)",
  issuedAt: new Date().toISOString(),
  scope: "client readiness for ledger rev 17 (work/lease-generation-interface.txt, work/ledger17-migration-interface.txt gate G4): "
    + "the supervisor and the independent CLI in candidate work/cli-final-parity/tree. NOT an activation: nothing deployed, signed or pinned.",
  ledgerCandidate: {
    source: "work/lease-generation-candidate/src/EnclaveDeployments.sol", sourceSha256: sha(path.join(W, "lease-generation-candidate/src/EnclaveDeployments.sol")),
    externalAbiSha256: sha(path.join(W, "lease-generation-candidate/out/EnclaveDeployments.external-abi.json")),
    testedArtifacts: "test/fixtures/lease17-candidate.json (verbatim build output; per-file hashes inside)",
  },
  clientFiles: Object.fromEntries(files.map((f) => [f, sha(T(f))])),
  bundle: { file: "tree/cli/dist/enclave.mjs", sha256: sha(T("cli/dist/enclave.mjs")) },
  patches: Object.fromEntries(fs.readdirSync(path.join(C, "patches")).filter((f) => f.endsWith(".patch")).map((f) => [`patches/${f}`, sha(path.join(C, "patches", f))])),
  supports: [
    "deploymentsSchema() read at the SAME pinned block as the lease row; schema 15/16 behave exactly as before (rev-16 control: release(id), leaseOf never called)",
    "schema >= 17: leaseOf(id) cross-checked against get(id) at that block; the release intent records schema and generation",
    "release sent as releaseLease(id, runner, generation) to the intent's OWN ledger; never release(id) on >= 17 (an intent without a generation closes unnamed-not-resent)",
    "a re-claim at an IDENTICAL leaseUntil (same key, same runner) is told apart by generation: the old intent resolves gone, nothing is sent",
    "another operator's claim, renew (generation kept), refund of the unused tail",
    "an intent pending on the old ledger resolves there and is never re-sent to the new ledger (pins changed)",
    "claim / lapsed re-claim / re-acquire record LeaseOpened's generation",
    "CLI: same-operator move only when schema >= 17 AND guardedReleaseOnly(sourceOperator) at one agreed block; host guarded-release on|off is an explicit operator transaction",
    "management gateway and auth (network/lease-reader.mjs, network/management-auth.mjs) accept schema 17",
  ],
  notCovered: [
    "embedded copies of network/lease-reader.mjs: windows/node/host-admission.bundle.mjs and the relay network-runtime bundle need their owners' rebuilds",
    "a running supervisor whose address book (book polling) repoints 'deployments' mid-run: same code path as the pin change (ledger-moved), not separately exercised",
    "hosts still running a pre-rev-17 supervisor: an operator must not turn guarded-release on until every host on that key runs this supervisor",
    "measured control (94116) supervisor changes are not integrated in this candidate",
  ],
  evidence,
};
fs.writeFileSync(path.join(C, "ledger17-client-readiness.json"), JSON.stringify(out, null, 2) + "\n");
console.log("issued", path.join(C, "ledger17-client-readiness.json"), sha(path.join(C, "ledger17-client-readiness.json")));
