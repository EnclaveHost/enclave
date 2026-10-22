// PROVE with the real candidate network-enroll a9729786 (installed by the control apply) that the post-cutover config + the challengeReplica
// block added by the real edit helper 4d9c231e needs NO extra privacy-agent restart and is kept byte-equal; negative controls: the block
// after walletAdmission is re-ordered (one restart); the OLD live enroll 2d97a0e1 drops the block (why the control apply is a prerequisite).
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { execFileSync } from "node:child_process"; import assert from "node:assert/strict"; import { createHash } from "node:crypto";
const A = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."); const sha = (b) => createHash("sha256").update(b).digest("hex");
const RPC5 = ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co", "https://base-public.nodies.app", "https://base.drpc.org", "https://mainnet.base.org"];
const block = fs.readFileSync(path.join(A, "inputs/challengeReplica.json")); assert.equal(sha(block), "2b644d22c3fe1517fcca13fd01c07363cd0f5f5a65ea7f16fb466d958d0b62ad");
async function scenario(enrollFile, mutate) {
  const { createNetworkEnroll, baseConfig } = await import(path.join(A, "enroll-tree/windows/node", enrollFile));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "enroll-ch-")); const agentDir = path.join(d, "network"), binDir = path.join(d, "bin"); fs.mkdirSync(agentDir, { recursive: true });
  const policyFile = path.join(d, "policy.json"); fs.writeFileSync(policyFile, JSON.stringify({ cpu: { runtimeId: "r" } })); const W = path.join(agentDir, "wallet-admission.json");
  const common = { agentDir, binDir, nodeBinary: path.join(d, "node.exe"), operatorKeyFile: "k", runner: "0x" + "ab".repeat(32), endpoint: "e", relayBase: "https://relay.example", policyFile,
                   tpmBinary: "t", tpmSha256: "s", addressBook: "0xab214342d5A490150A4A977063A2f88E21F80907", enclaveNetwork: { checkers: ["0x" + "12".repeat(20)] } };
  const id = "0x" + "cd".repeat(32); const c = baseConfig({ ...common, chainRpc: RPC5 }); c.enclaveNetwork.paceMbps = 50; c.enclaveNetwork.walletAdmission = { file: W };   // the cutover's render: walletAdmission LAST
  c.apps.push({ deploymentId: id, names: [id.slice(2, 10) + ".app.enclave.host"], expectedFile: path.join(agentDir, id, "expected.json"), internetMode: "enclave-network", publishToMirror: true });
  const cf = path.join(agentDir, "privacy-config.json"); fs.writeFileSync(cf, JSON.stringify(c, null, 2) + "\n");
  let restarts = 0; const logs = []; const en = createNetworkEnroll({ agentDir, binDir, runner: common.runner, relayBase: common.relayBase, config: { ...common, chainRpc: RPC5, walletAdmission: { file: W } },
    rows: async () => [], version: async () => null, vms: async () => [], fetch: async () => ({ ok: false }), restartAgent: async () => { restarts++; }, log: (m) => logs.push(m) });
  await en.pass(); const baseline = restarts;                                     // the post-cutover config is stable
  mutate(cf, d); const edited = fs.readFileSync(cf, "utf8");
  await en.pass(); await en.pass();
  const after = JSON.parse(fs.readFileSync(cf, "utf8"));
  const r = { baselineRestarts: baseline, restarts: restarts - baseline, blockKept: JSON.stringify(after.enclaveNetwork.challengeReplica) === JSON.stringify(JSON.parse(block)),
              lastKeys: Object.keys(after.enclaveNetwork).slice(-2), bytesUnchanged: fs.readFileSync(cf, "utf8") === edited, chainRpc5: JSON.stringify(after.chain.rpc) === JSON.stringify(RPC5) };
  fs.rmSync(d, { recursive: true, force: true }); return r;
}
const viaHelper = (cf, d) => { const bf = path.join(d, "b.json"), o = path.join(d, "o.json"); fs.writeFileSync(bf, block);
  execFileSync(process.execPath, [path.join(A, "inputs/edit-privacy-config.mjs"), cf, o, bf, sha(fs.readFileSync(cf)), sha(block)], { stdio: ["ignore", "pipe", "pipe"] }); fs.renameSync(o, cf); };
const afterWallet = (cf) => { const c = JSON.parse(fs.readFileSync(cf, "utf8")); c.enclaveNetwork.challengeReplica = JSON.parse(block); fs.writeFileSync(cf, JSON.stringify(c, null, 2) + "\n"); };
const res = {
  candidateViaHelper: await scenario("network-enroll.mjs", viaHelper),
  negativeAfterWalletAdmission: await scenario("network-enroll.mjs", afterWallet),
  negativeOldLiveEnroll2d97: await scenario("network-enroll.live-2d97.mjs", viaHelper) };
const a = res.candidateViaHelper; assert.deepEqual([a.baselineRestarts, a.restarts, a.blockKept, a.bytesUnchanged, a.chainRpc5], [0, 0, true, true, true]); assert.deepEqual(a.lastKeys, ["challengeReplica", "walletAdmission"]);
const b = res.negativeAfterWalletAdmission; assert.equal(b.restarts, 1, "the wrong order is a section switch: one restart"); assert.deepEqual(b.lastKeys, ["challengeReplica", "walletAdmission"]);
const c = res.negativeOldLiveEnroll2d97; assert.ok(!c.blockKept && c.restarts >= 1, "the old enroll drops the block and restarts");
console.log(JSON.stringify({ passed: 3, results: res }));
