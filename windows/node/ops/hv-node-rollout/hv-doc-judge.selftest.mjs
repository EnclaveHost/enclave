// hv-doc-judge.selftest.mjs - the positive and negative controls for hv-doc-judge.mjs's `judge`, on SYNTHETIC documents (a
// launcher key made here, as windows/vbslike/verify/wx-per-image.test.mjs does), judged by the tree given:
//   node hv-doc-judge.selftest.mjs --tree <checkout of the node commit, node_modules linked>
// A document stating the attest-time scan WITH seccomp=<S> must PASS with --expect-seccomp S and FAIL with another hash;
// one without seccomp= must FAIL (an unlisted image: judge-hv SECCOMP_UNSTATED_IMAGES); the legacy form must FAIL; and a
// pin that is not the runtime's must FAIL. Prints one line per case and exits 1 on any surprise.
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process"; import { fileURLToPath, pathToFileURL } from "node:url";

const i = process.argv.indexOf("--tree"), tree = i > 0 ? path.resolve(process.argv[i + 1]) : null;
if (!tree) { console.log("usage: hv-doc-judge.selftest.mjs --tree <checkout>"); process.exit(2); }
const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "hv-doc-judge.mjs");
const { canonical, SIGN_DOMAIN } = await import(pathToFileURL(path.join(tree, "windows/vbslike/verify/judge-hv.mjs")).href);
const { ABI2, bind2, runtimeId } = await import(pathToFileURL(path.join(tree, "isolation/contract/runtime.mjs")).href);
const CONTRACT_RS = fs.readFileSync(path.join(tree, "windows/vbslike/host/src/contract.rs"), "utf8");
const FORMAT = CONTRACT_RS.match(/pub const FORMAT_HYPERV: &str = "([^"]+)";/)[1];
const TIER = CONTRACT_RS.match(/pub const TIER_HYPERV: &str = "([^"]+)";/)[1];

const JIT = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64", cpuFeatures: "baseline", wx: "enforced", cache: "none" };
const PIN = Buffer.from(runtimeId(JIT)).toString("hex");
const APP = "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45", VM = "3f1c0f6e-0000-4000-8000-000000000044";
const IMG = "7e".repeat(32);                        // an image neither judge-hv table lists (as afa9633c)
const S = "d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66";
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const launcherKey = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");

function fixture(selfTest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvj-"));
  const spki = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  const nonce = crypto.randomBytes(32);
  const report = { format: FORMAT, tier: TIER, reportData: Buffer.concat([bind2(spki, nonce, runtimeId(JIT)), Buffer.from(APP, "hex")]).toString("hex"),
    domain: { appSha256: APP }, partition: { vmId: VM, guestImageSha256: IMG }, launcher: { key: launcherKey }, platform: { hostExcluded: false },
    boundary: "tier=T0-hv partition=hyperv-vm host_excluded=no" };
  const sig = crypto.sign(null, Buffer.concat([SIGN_DOMAIN, Buffer.from(canonical(report))]), privateKey).toString("base64");
  const doc = { format: FORMAT, tier: TIER, nonce: nonce.toString("hex"), appSha256: APP, abi: ABI2, runtime: JIT, runtimeSelfTest: selfTest,
    report: Buffer.from(JSON.stringify({ doc: report, sig })).toString("base64") };
  // guestIdentity null: hvJudge then names no image, so the full rule applies (legacy null, seccomp required)
  const view = { name: "0x" + "44".repeat(32), appId: APP, runtimeId: PIN, launcherKey, launcherVmId: VM, image: IMG, guestIdentity: null,
    transportKeySha256: crypto.createHash("sha256").update(spki).digest("hex") };
  fs.writeFileSync(path.join(dir, "view.json"), JSON.stringify(view)); fs.writeFileSync(path.join(dir, "attestation.json"), JSON.stringify(doc));
  fs.writeFileSync(path.join(dir, "spki.der"), spki); fs.writeFileSync(path.join(dir, "nonce.hex"), nonce.toString("hex") + "\n");
  return dir;
}
const run = (dir, ...a) => spawnSync(process.execPath, [TOOL, "judge", "--tree", tree, "--in", dir, ...a], { encoding: "utf8" });
let bad = 0;
function expect(name, want, r) {
  const got = r.status === 0 ? "PASS" : "FAIL", last = (r.stdout.trim().split("\n").pop() || r.stderr.trim()).slice(0, 160);
  const ok = got === want && /^(PASS|FAIL) /.test(last);    // a crash is never the expected FAIL
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "BAD "} ${name}: tool ${got} (want ${want}) | ${last}`);
}
const withSc = `exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 seccomp=${S} scope=cgroup:/dom1`;
expect("attest-time + seccomp, --expect-seccomp S", "PASS", run(fixture(withSc), "--pin", PIN, "--expect-seccomp", S));
expect("attest-time + seccomp, another expected hash", "FAIL", run(fixture(withSc), "--pin", PIN, "--expect-seccomp", "ab".repeat(32)));
expect("attest-time, NO seccomp (unlisted image)", "FAIL", run(fixture("exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 scope=cgroup:/dom1"), "--pin", PIN));
expect("the legacy form (unlisted image)", "FAIL", run(fixture("exec_pages=allowed wx=clean maps=2 scope=cgroup:/dom1"), "--pin", PIN, "--allow-unmeasured"));
expect("a pin that is not the runtime's", "FAIL", run(fixture(withSc), "--pin", "ab".repeat(32), "--expect-seccomp", S));
console.log(bad ? `SELFTEST ${bad} BAD` : "SELFTEST ALL OK");
process.exit(bad ? 1 : 0);
