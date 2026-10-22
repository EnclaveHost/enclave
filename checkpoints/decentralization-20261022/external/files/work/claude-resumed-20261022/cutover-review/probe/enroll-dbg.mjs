// rpc-integrated: PROVE with the real candidate network-enroll.mjs (a9729786) that the cutover's rendered privacy config needs no
// second privacy-agent restart, and that the unrepaired render (943a) would cause one. RPC lists come from the exact RPCS expression of
// candidate chain.mjs (86c81124) applied to the launcher's BASE_RPCS values; the render is the helper's own $js text run by node.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { execFileSync } from "node:child_process"; import assert from "node:assert/strict";
const root = "/home/steven/Documents/Codex/2026-10-18/wo/work/claude-resumed-20261022/cutover-review/rpc-integrated";
const { createNetworkEnroll, baseConfig } = await import(path.join(root, "enroll-tree/windows/node/network-enroll.mjs"));
const chainSrc = fs.readFileSync(path.join(root, "enroll-tree/windows/node/chain.mjs"), "utf8");
const stmt = chainSrc.match(/const RPCS = \(process\.env\.BASE_RPCS[\s\S]*?\.filter\(Boolean\);/)[0];
const rpcUrls = (BASE_RPCS) => new Function("process", stmt + "; return [...RPCS];")({ env: { BASE_RPCS } });
const helperJs = (file) => { const t = fs.readFileSync(file, "utf8"); const i = t.indexOf('$js = "'); const lines = [];
  for (const l of t.slice(i).split("\n")) { lines.push(l); if (!l.trimEnd().endsWith("+")) break; }
  return [...lines.join("\n").matchAll(/"([^"]*)"/g)].map((x) => x[1]).join(""); };
const L5 = "https://base-rpc.publicnode.com,https://base.gateway.tenderly.co,https://base-public.nodies.app,https://base.drpc.org,https://mainnet.base.org";
const L12 = "https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org";
const RPC5 = rpcUrls(L5), RPC3 = rpcUrls(L12); assert.equal(RPC5.length, 5); assert.equal(RPC3.length, 3);
const results = {};
async function scenario(name, { renderWith, chainRpc, wallet, cfgOverride }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "enroll-eq-")); const agentDir = path.join(d, "network"), binDir = path.join(d, "bin"); fs.mkdirSync(agentDir, { recursive: true });
  const policyFile = path.join(d, "policy.json"); fs.writeFileSync(policyFile, JSON.stringify({ cpu: { runtimeId: "r" } }));
  const W = path.join(agentDir, "wallet-admission.json");
  const common = { agentDir, binDir, nodeBinary: path.join(d, "node.exe"), operatorKeyFile: path.join(d, "k"), runner: "0x" + "ab".repeat(32), endpoint: "e", relayBase: "https://relay.example",
                   policyFile, tpmBinary: "t", tpmSha256: "s", addressBook: "0xab214342d5A490150A4A977063A2f88E21F80907", enclaveNetwork: { checkers: ["0x" + "12".repeat(20)] } };
  const id = "0x" + "cd".repeat(32); const cfg0 = baseConfig({ ...common, chainRpc: RPC3 });
  cfg0.apps.push({ deploymentId: id, names: [id.slice(2, 10) + ".app.enclave.host"], expectedFile: path.join(agentDir, id, "expected.json"), internetMode: "enclave-network", publishToMirror: true });
  const cfgFile = path.join(agentDir, "privacy-config.json"); fs.writeFileSync(cfgFile, JSON.stringify(cfgOverride ? cfgOverride(cfg0) : cfg0, null, 2));
  if (renderWith) { const out = cfgFile + ".edit"; execFileSync(process.execPath, ["-e", helperJs(renderWith), cfgFile, out, W, (chainRpc || RPC5).join(",")]); fs.renameSync(out, cfgFile); }
  let restarts = 0; const logs = [];
  const en = createNetworkEnroll({ agentDir, binDir, runner: common.runner, relayBase: common.relayBase, config: { ...common, chainRpc, ...(wallet ? { walletAdmission: { file: W } } : {}) },
    rows: async () => [], version: async () => null, vms: async () => [], fetch: async () => ({ ok: false }), restartAgent: async () => { restarts++; }, log: (m) => logs.push(m) });
  if (process.env.DBG === name) console.log("DBG", name, JSON.stringify(JSON.parse(fs.readFileSync(cfgFile,"utf8")).chain), JSON.stringify(chainRpc), renderWith); await en.pass(); await en.pass(); if (process.env.DBG === name) console.log("DBGLOG", JSON.stringify(logs));
  results[name] = { restarts, chainLog: logs.filter((l) => l.startsWith("chain RPCs now")).length, sectionLog: logs.filter((l) => l.includes("network configuration changes")).length };
  fs.rmSync(d, { recursive: true, force: true }); return results[name];
}
const NEW = path.join(root, "helper/node-hold-cutover.ps1"), BASE = path.join(root, "base/node-hold-cutover.ps1");
// 0 the fixture is a normalized, stable production shape: the old node (3 RPCs, no hold) restarts nothing
assert.deepEqual(await scenario("baselineOldNode", { chainRpc: RPC3 }), { restarts: 0, chainLog: 0, sectionLog: 0 });
// 1 THE CUTOVER: rendered by the rpc-integrated helper, read by the new node (5 RPCs, hold on): NO second restart
assert.deepEqual(await scenario("cutoverRendered", { renderWith: NEW, chainRpc: RPC5, wallet: true }), { restarts: 0, chainLog: 0, sectionLog: 0 });
// 2 NEGATIVE CONTROL: the unrepaired 943a render + the repaired launcher's 5 RPCs: network-enroll switches chain.rpc and restarts ONCE
assert.deepEqual(await scenario("negative943aRender", { renderWith: BASE, chainRpc: RPC5, wallet: true }), { restarts: 1, chainLog: 1, sectionLog: 0 });
// 3 NEGATIVE CONTROL: the same 5 in another order is a different JSON string: a restart (why the helper pins the order)
assert.deepEqual(await scenario("negativeOrder", { renderWith: NEW, chainRpc: [...RPC5].reverse(), wallet: true }), { restarts: 1, chainLog: 1, sectionLog: 0 });
// 4 REVERT: the original config bytes + the restored launcher's 3 RPCs + no hold: nothing restarts
assert.deepEqual(await scenario("revertRestored", { chainRpc: RPC3 }), { restarts: 0, chainLog: 0, sectionLog: 0 });
console.log(JSON.stringify({ passed: 5, rpc5: RPC5, results }));
