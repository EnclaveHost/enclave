// Shared setup for the GENERATED host candidate tests: baseline windows/node/host.mjs + the pinned insertions, written to
// a temp dir, against the baseline's fake Base RPC and the REAL baseline chain.mjs. Lifecycle adapters are MOCKS.
import { BASELINE_HOST, BASE_TEST, BASE_NODE, GENERATOR_URL, DISPATCH_URL, registerCandidate } from './baseline.mjs';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { H, OLD } from './lifecycle-fixture.mjs';

process.env.NODE_OPERATOR_KEY = '0x' + '7f'.repeat(32);
process.env.NODE_PROOF_KEY = '0x' + '5a'.repeat(32);
delete process.env.ENCLAVE_NETWORK_WALLET_HOLD;
const { fakeBaseRpc, DEPLOYMENTS, CATALOG } = await import(new URL('helpers/fake-base-rpc.mjs', BASE_TEST).href);
assert.equal(DEPLOYMENTS, OLD, 'the fixture old ledger is the fake legacy ledger');
export const rpc = await fakeBaseRpc();
export const chain = await import(new URL('chain.mjs', BASE_NODE).href);
chain.addresses.deployments = DEPLOYMENTS; chain.addresses.appCatalog = CATALOG; chain.loadOperator(); chain.loadProofKey();
const { generateHostCandidate } = await import(GENERATOR_URL);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-host-candidate-'));
const candidateFile = path.join(tmp, 'host.lifecycle-candidate.mjs');
fs.writeFileSync(candidateFile, generateHostCandidate(fs.readFileSync(BASELINE_HOST, 'utf8')).source);
registerCandidate(pathToFileURL(candidateFile).href);
export const { Host } = await import(pathToFileURL(candidateFile).href);
export const { Host: BaselineHost } = await import(new URL('host.mjs', BASE_NODE).href);
export const D = await import(DISPATCH_URL);

const dirs = [tmp];
after(() => { rpc.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
export const endpoint = 'https://api.enclave.host/t/lifecycle-routing-test', HOSTID = chain.enclaveIdOf(endpoint);
export const A = H('aa'), C = H('cc');
export const version = { cid: 'bafy', version: '1', vramMb: 0, gpuGflops: 0, memMb: 512, cpuGflops: 0, createdAt: 1n, verified: true, yanked: false, ports: '', approval: 1, config: '{}' };
export const settle = () => new Promise((r) => setImmediate(r));
export const quiet = (h, keep = []) => { for (const n of ['followBook', 'enforceOff', 'ensureRegistered', 'ensurePriced', 'scanLedger', 'retireForeignRecovered']) if (!keep.includes(n)) h[n] = async () => {}; };
export const row = (rid, h, over = {}) => ({ id: rid, owner: chain.operatorAddress(), appRef: 'catalog://0x' + 'cd'.repeat(32) + '/1', ports: '', configCid: '',
  gpuMilli: 0, cpuMilli: 100, appPort: 8000, isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 1000000n, spent6: 0n,
  runner: h.enclaveId, runnerOperator: chain.operatorAddress(), leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 3600), ...over });

/** A platform host policy gate with the real gate's interface (createHostServiceGate), answers set by the test. */
export const platformGate = (P) => ({ enabled: true, hostId: HOSTID, start() {}, stop() {}, async check() { return {}; },
  serviceRefusal: () => P.service, newWorkRefusal: () => P.newWork, status: () => ({ platformHostPolicy: 'test' }) });

export async function box(Cls, dispatch = null, { platformPolicy = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-host-')); dirs.push(dir);
  const policyLog = [], checkpoints = [];
  const h = new Cls({ dir, endpoint, name: 'test', appsEnabled: true, vcpus: 8, ramGb: 16, cpuPricePerSec6: 0,
    hostAdmission: { hostId: HOSTID, refusal: async (q) => { policyLog.push(String(q?.deploymentId ?? '?').toLowerCase()); return null; } },
    checkpointBatch: async (due) => { checkpoints.push(...due.map((d) => d.id)); return [{ ids: due.map((d) => d.id) }]; },
    ...(platformPolicy ? { platformPolicy } : {}),
    ...(dispatch ? { lifecycleDispatch: dispatch } : {}) });
  h.chainReady = true; h.registered = { cpuPricePerSec6: '0' }; await h.refreshOwners();
  const spies = { consider: [], ensureApp: [] };
  const consider = h.consider.bind(h);
  h.consider = async (id, o) => { spies.consider.push(String(id).toLowerCase()); return consider(id, o); };
  h.ensureApp = async (id) => { spies.ensureApp.push(String(id).toLowerCase()); return h.records.get(id) || null; };
  return { h, spies, policyLog, checkpoints };
}
export const serve = (h) => { rpc.row.current = null; rpc.rows.current = [row(A, h), row(C, h)]; rpc.catalog.current = version; };
/** The host's own ingress for one id. Anything past the gate (app lookup) may fail in this fixture; only the gate is asserted. */
export async function ingress(h, id) {
  const r = await h.proxy(id, { method: 'GET', pathRest: '/', headers: {}, body: null }).catch((e) => ({ status: 0, thrown: e.message }));
  const body = r?.body === undefined ? '' : String(r.body);
  return { status: r?.status, platformRefused: body.includes('host_policy_refused'), lifecycleRefused: body.includes('lifecycle_refused'), body };
}
