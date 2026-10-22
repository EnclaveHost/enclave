// SHIELD HARDWARE CANARY driver (work/shield-hardware-canary/plan.json). Talks ONLY to the staged canary manager on
// 127.0.0.1:<port> (VM scope enclave-canary-); never to the production manager (8091) or node. Uses the COMMITTED code of
// the staged bundle (--control <bundle>\control) for everything it judges.
// Every command requires --canary-dir <stage>. Mutations also require --apply and the exact recorded step approval.
// --control may only name the stage bundle's control directory.
//   node canary.mjs scope   --port 18091 [--direct-sha <64 hex>]           the scope proof: no production VM is visible
//   node canary.mjs body    --control C --deployment 0x.. --pins F --rpcs A,B[,C] --gateways G[,..] --ipfs I[,..]
//                           --direct-rid <64 hex> --direct-sha <64 hex> --legacy-rid <64 hex> --out spawn.json
//                           read-only chain + storage reads: the node's own materialize() for a TEST deployment
//   node canary.mjs spawn   --port 18091 --body spawn.json
//   node canary.mjs observe --port 18091 --id <id>                         status, image role/hash, package hash, console head, custody asks
//   node canary.mjs answer  --port 18091 --id <id> --control C --key <scratch key file> --endpoint https://<test origin>
//                           (run AS SYSTEM: proves the key's ACL and the callback path) a TEST signature, never an operator's
//   node canary.mjs delete  --port 18091 --id <id>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { PORT, loadStage, requireApproval, assertScope, withJournal, planSpawn, bindVm, ownRecord, stagedControl, scratchCallbackKey } from "./guard.mjs";

const argv = process.argv.slice(2), cmd = argv[0];
const arg = (k, d = undefined) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : d; };
const port = Number(arg("port", "18091"));
if (port !== PORT) throw new Error(`only the dedicated canary port ${PORT} is permitted`);
if (!arg("canary-dir")) throw new Error("--canary-dir is required");
const dir = path.resolve(arg("canary-dir"));
const stage = loadStage(dir);
const base = `http://127.0.0.1:${port}`;
const controlRoot = () => stagedControl(stage, arg("control"));
const control = (rel) => import(pathToFileURL(path.join(controlRoot(), rel)).href);
const get = async (p) => { const r = await fetch(base + p, { signal: AbortSignal.timeout(15000) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const out = (o) => console.log(JSON.stringify(o, null, 1));
const checkedScope = async () => {
  const h = await get("/health"), v = await get("/vms");
  if (h.status !== 200 || v.status !== 200) throw new Error("canary inventory could not be read");
  assertScope(h.body, v.body, stage);
  return { h, v };
};
const approve = (step) => requireApproval(dir, step, argv.includes("--apply"));
const inspectOwned = async (record) => {
  const result = await get(`/vms/${record.id}`);
  if (result.status !== 200) throw new Error(`creation ${record.id} is unresolved (HTTP ${result.status}); no deletion or retry was attempted`);
  bindVm(record, result.body);
  // Read the actual partition, not just a claim made by the HTTP listener.
  const proof = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(path.dirname(fileURLToPath(import.meta.url)), "assert-vm.ps1"),
    "-VmId", record.vmId, "-VmName", record.vmName, "-RecordId", record.id,
    "-Deployment", record.deployment, "-InstanceId", record.instanceId], { encoding: "utf8", timeout: 20000 });
  const parsed = JSON.parse(proof.replace(/^\uFEFF/, "").trim());
  if (parsed.verified !== true || parsed.vmId.toLowerCase() !== record.vmId.toLowerCase() || parsed.recordId !== record.id)
    throw new Error("Hyper-V identity verification failed");
  return result.body;
};

if (cmd === "scope") {
  const { h, v } = await checkedScope();
  const vms = Array.isArray(v.body?.vms) ? v.body.vms : [];
  const foreign = vms.filter((x) => !String(x.vmName || x.handle?.name || "").startsWith("enclave-canary-"));
  const direct = h.body?.images?.shieldDirect;
  const ok = h.status === 200 && foreign.length === 0 && (!arg("direct-sha") || direct?.igvmSha256 === arg("direct-sha"));
  out({ ok, inventory: h.body?.inventory ?? null, records: vms.length, foreign: foreign.map((x) => x.vmName ?? x.id), shieldDirect: direct ?? null,
        directBootstrap: h.body?.supports?.directBootstrap ?? null });
  process.exit(ok ? 0 : 1);
}
if (cmd === "body") {
  await checkedScope();
  const { createShieldStartup, startupImages } = await control("windows/node/shield-startup.mjs");
  const { quorumReader, rpcClients } = await control("windows/node/host-identity.mjs");
  const { cidFetcher } = await control("windows/vbslike/manager/fetchcid.mjs");
  const chain = await control("windows/node/chain.mjs");
  const pins = JSON.parse(fs.readFileSync(arg("pins"), "utf8"));
  const reader = quorumReader({ clients: await rpcClients(String(arg("rpcs")).split(",")) });
  const script = path.join(controlRoot(), "windows/node/fetch-cid.py");
  const fetchers = String(arg("ipfs")).split(",").map((gateway) => cidFetcher({ script, python: arg("python", "python"), gateway }));
  const fetchComponent = async (cid) => { let last; for (const f of fetchers) { try { return await f(cid); } catch (e) { last = e; } } throw last; };
  const images = startupImages({ ENCLAVE_ISOLATION_DIRECT_RUNTIME_ID: arg("direct-rid"), ENCLAVE_ISOLATION_DIRECT_IMAGE_SHA256: arg("direct-sha") });
  const authority = createShieldStartup({ reader, pins: pins.contracts ?? pins, gateways: String(arg("gateways")).split(","), fetchComponent,
    abis: { DEP_ABI: chain.DEP_ABI, CATALOG_ABI: chain.CATALOG_ABI }, log: (m) => console.error(m), ...images });
  const manager = (await get("/health")).body;
  const v = await authority.materialize(arg("deployment"), { manager, runtimeId: arg("legacy-rid"), needLease: false });
  if (!v.ok) { out({ ok: false, input: v.input, why: v.why, unknown: v.unknown }); process.exit(1); }
  fs.writeFileSync(arg("out"), JSON.stringify({ ...v.spawn, name: arg("deployment") }));
  out({ ok: true, startup: { sha256: v.startup.sha256, appId: v.startup.appId, runtimeId: v.startup.runtimeId, imageRole: v.startup.imageRole, secretsMode: v.startup.secretsMode } });
  process.exit(0);
}
if (cmd === "spawn") {
  approve("spawn");
  await checkedScope();
  await withJournal(dir, stage, async (journal, save) => {
    const body = JSON.parse(fs.readFileSync(arg("body"), "utf8"));
    const record = planSpawn(journal, body);
    save(); // Durable intent BEFORE sending: a lost response cannot create an unrecorded VM.
    const r = await fetch(base + "/vms", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, id: record.id }), signal: AbortSignal.timeout(300000) });
    const b = await r.json().catch(() => null);
    out({ status: r.status, id: record.id, state: b?.status ?? null, reason: b?.reason ?? b?.error ?? null });
    if (!r.ok) throw new Error(`spawn did not confirm success; intent ${record.id} retained for reconciliation`);
    await inspectOwned(record); save();
  });
  process.exit(0);
}
if (cmd === "observe") {
  await checkedScope();
  const v = await withJournal(dir, stage, async (journal, save) => {
    const vm = await inspectOwned(ownRecord(journal, arg("id"))); save(); return vm;
  });
  out({ id: v.id, name: v.name, status: v.status, reason: v.reason, imageRole: v.imageRole, igvmSha256: v.igvmSha256, bootstrapSha256: v.bootstrapSha256,
        runtimeId: v.runtimeId, appId: v.appId, guest: v.guest ?? null, awaitingCustodyAuth: v.awaitingCustodyAuth ?? null, launcherVmId: v.launcherVmId ?? null });
  process.exit(0);
}
if (cmd === "answer") {
  approve("answer");
  await checkedScope();
  await withJournal(dir, stage, async (journal, save) => { await inspectOwned(ownRecord(journal, arg("id"))); save(); });
  // AS SYSTEM: the scratch key is read through the SAME check the node applies (owner + DACL); the signature is a throwaway
  // key's, so custodians would refuse it - this proves the transport, the callback and the ACL, not a release.
  const { readCustodyCallbackKey } = await control("windows/vbslike/manager/custody-key-file.mjs");
  const { custodyCallbackHeader, CUSTODY_CALLBACK_HEADER } = await control("windows/vbslike/manager/custody-transport.mjs");
  // viem from the staged bundle's own control tree, as the node resolves it
  const { createRequire } = await import("node:module");
  const { generatePrivateKey, privateKeyToAccount } = await import(pathToFileURL(createRequire(path.join(controlRoot(), "windows/node/agent.mjs")).resolve("viem/accounts")).href);
  const key = readCustodyCallbackKey(scratchCallbackKey(stage, arg("key")));
  const v = (await get(`/vms/${arg("id")}`)).body || {};
  const q = (v.awaitingCustodyAuth || [])[0];
  if (!q) { out({ ok: false, why: "no pending custody request on this partition" }); process.exit(1); }
  const signer = privateKeyToAccount(generatePrivateKey());
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = await signer.signMessage({ message: `enclave canary TEST signature (not an operator's) ${q.binding} ${expiry}` });
  const p = `/vms/${v.id}/custody-auth`, body = JSON.stringify({ request: q.request, binding: q.binding, endpoint: arg("endpoint"), sig, expiry });
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", [CUSTODY_CALLBACK_HEADER]: custodyCallbackHeader(key, { path: p, body }) }, body, signal: AbortSignal.timeout(15000) });
  out({ ok: r.ok, status: r.status, answered: q.request, deployment: q.id, vault: q.vault, keyBytes: key.length });
  process.exit(r.ok ? 0 : 1);
}
if (cmd === "delete") {
  approve("delete");
  await checkedScope();
  await withJournal(dir, stage, async (journal, save) => {
    const record = ownRecord(journal, arg("id"));
    await inspectOwned(record); save();
    const r = await fetch(`${base}/vms/${record.id}`, { method: "DELETE", signal: AbortSignal.timeout(180000) });
    out({ status: r.status, id: record.id, body: await r.json().catch(() => null) });
    if (!r.ok) throw new Error("deletion was not confirmed; journal retained");
    record.state = "deleted"; save();
  });
  process.exit(0);
}
console.error("usage: node canary.mjs scope|body|spawn|observe|answer|delete ...  (see the header)");
process.exit(2);
