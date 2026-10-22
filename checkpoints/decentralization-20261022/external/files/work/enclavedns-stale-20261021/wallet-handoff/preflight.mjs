// READ-ONLY preflight of the EnclaveDNS 0.1.5 release (no key, no signature, no upload, nothing sent):
//   - the frozen artifact: size, sha256 and the CID its own UnixFS import yields (site-upload.mjs frozenWasm, unchanged);
//   - the plan and its sha256 (the value root approves);
//   - every pin (incl. the vault's code, owner, factory and STAGING hold) and the publish pre-state at one anchor on both
//     providers (startCheck);
//   - publish -> upgrade simulated as ONE eth_simulateV1 bundle on both providers, each step's post-state checked;
//   - the receipt providers answer chain 8453; the gateway's current answer for the CID (HEAD only, informational).
//   node preflight.mjs > preflight.json
import { DNS } from "./trust.mjs";
import { buildHandoffPlan } from "./handoff-plan.mjs";
import { startCheck, simulateSequence } from "./chain.mjs";
import { frozenWasm } from "../../site-host-live-publish/handoff/site-upload.mjs";
import { clientsFor } from "../../lease-gas-wallet-signing/rpc-clients.mjs";

const out = { at: new Date().toISOString(), readOnly: true };
const step = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { error: String(e?.shortMessage || e?.message || e).slice(0, 400) }; out.failed = [...(out.failed || []), k]; } };
const { plan, sha256 } = buildHandoffPlan(DNS);
out.plan = { sha256: "sha256:" + sha256, appRefAfter: plan.appRefNext };
await step("artifact", () => { const { bytes } = frozenWasm(DNS); return { bytes: bytes.length, sha256: DNS.wasm.sha256, cid: DNS.expectedCid, importsToPinnedCid: true }; });
const clients = clientsFor(DNS.rpcs);
await step("start", () => startCheck({ t: DNS, plan, clients }));
await step("sequence", () => simulateSequence({ t: DNS, plan, clients }));
await step("receiptProviders", async () => Object.fromEntries(await Promise.all(clientsFor(DNS.receiptRpcs).map(async (c) => [new URL(c.transport.url).hostname, Number(await c.getChainId())]))));
await step("gatewayHead", async () => { const r = await fetch(DNS.upload.carUrl(DNS.expectedCid), { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(20000) }); return { status: r.status, note: "informational: 200 = the CID is already retrievable; the upload step verifies the CAR either way" }; });
out.ok = !out.failed;
console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
process.exit(out.ok ? 0 : 1);
