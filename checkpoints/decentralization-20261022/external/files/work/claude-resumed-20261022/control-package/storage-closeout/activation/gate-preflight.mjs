// ROOT ONLY, READ-ONLY. Would the platform host policy admit this host's storage-indexer role, BEFORE anyone signs a
// descriptor? The role's own `check` verifies the descriptor first, so it cannot answer this. This uses the SAME code
// the role uses, from the pinned host-software tree: createHostServiceGate (the gate) and the role's registry read
// (quorumSnapshot + readPolicyFacts with the gate's own RPC set, book and ownership contract).
// Public chain/mirror reads only; the gate's persisted state goes to a throwaway directory that is removed; nothing
// is signed, written to the host's state or started. Prints ONE JSON line: ids, addresses, booleans, reasons.
//   node gate-preflight.mjs --host-software <dir> --endpoint https://api.enclave.host/t/<name>
//                           [--policy production|<json>] [--rpcs a,b,c] [--mirrors a,b] [--timeout-ms 30000]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k, d = undefined) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const out = (o, code) => { console.log(JSON.stringify(o)); process.exit(code); };
const hs = arg('--host-software'), ep = arg('--endpoint'), ms = Number(arg('--timeout-ms', '30000'));
if (!hs || !ep) out({ verdict: 'USAGE', why: '--host-software <dir> --endpoint <registered endpoint>' }, 2);
const imp = (rel) => import(pathToFileURL(path.join(hs, rel)).href);
const withTimeout = (p, what) => Promise.race([p, new Promise((_, no) => { const t = setTimeout(() => no(new Error(`${what} timed out after ${ms} ms`)), ms); t.unref?.(); })]);
const role = await imp('network/host-services/storage-indexer-host.mjs');
const { createHostServiceGate, hostIdOfEndpoint } = await imp('network/host-service-gate.mjs');
const endpoint = role.canonicalHostEndpoint(ep);
if (!endpoint) out({ verdict: 'REFUSED', why: 'not a registered-endpoint form (the role refuses it)' }, 1);
const p = arg('--policy', 'production');
const cfg = { platformHostPolicy: p === 'production' || p === 'off' ? p : JSON.parse(p),
  ...(arg('--rpcs') ? { platformHostPolicyRpcs: arg('--rpcs').split(',') } : {}), ...(arg('--mirrors') ? { platformHostPolicyMirrors: arg('--mirrors').split(',') } : {}) };
const hostId = hostIdOfEndpoint(endpoint);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-gate-preflight-'));
const res = { at: new Date().toISOString(), endpoint, hostId, roleSha256: null, platformPolicy: null };
try {
  const gate = createHostServiceGate({ env: role.policyEnv(cfg), chainId: 8453, endpoint, stateDir: tmp, log: (m) => console.error(m) });
  res.platformPolicy = gate.enabled ? 'on' : 'off';
  if (!gate.enabled) out({ ...res, verdict: 'NOT_ADMISSIBLE', why: 'platform host policy off: the role never runs ungated' }, 1);
  let checkError = null;
  await withTimeout(gate.check(), 'platform host policy check').catch((e) => { checkError = String(e.message || e).slice(0, 200); });
  const refusal = gate.serviceRefusal(); const st = gate.status();
  res.gate = { serving: st.serving === true, status: st.status ?? null, banned: st.banned === true, reason: st.reason ?? null, refusal, checkError };
  let row = null, registryError = null;
  try {
    const { quorumSnapshot } = await imp('network/host-policy-runtime.mjs'), { readPolicyFacts } = await imp('network/platform-host-policy.mjs');
    const rc = gate.runtime.config, snap = quorumSnapshot({ rpcs: rc.rpcs, minAgree: rc.minAgree ?? null });
    row = (await withTimeout(snap((at) => readPolicyFacts(at, { book: rc.book, hostOwnership: rc.hostOwnership, registryIds: [hostId] })), 'registry read')).hosts[hostId] ?? null;
  } catch (e) { registryError = String(e.message || e).slice(0, 200); }
  res.registry = row ? { present: true, active: row.active === true, endpointMatches: String(row.endpoint || '').replace(/\/+$/, '') === endpoint,
                         operator: String(row.operator || '').toLowerCase() || null } : { present: false, error: registryError };
  const ok = !refusal && res.gate.serving && row && row.active === true && res.registry.endpointMatches && /^0x[0-9a-f]{40}$/.test(res.registry.operator || '');
  const unknown = !ok && !st.banned && (checkError || registryError || /unreadable|undecided|unchecked/.test(String(st.status)));
  res.verdict = ok ? 'ADMISSIBLE' : unknown ? 'UNKNOWN' : 'NOT_ADMISSIBLE';
  res.why = ok ? 'the gate admits this host and its registry row is active with this endpoint: the descriptor must be signed by registry.operator'
               : unknown ? 'policy or registry not readable now (transient): never treated as admitted' : (refusal || (!row ? 'no registry row' : !row.active ? 'registry entry not active' : !res.registry.endpointMatches ? 'registry endpoint differs' : 'not serving'));
  out(res, ok ? 0 : unknown ? 3 : 1);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
