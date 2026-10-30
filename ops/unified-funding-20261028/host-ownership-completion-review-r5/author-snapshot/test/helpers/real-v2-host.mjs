// host-authority completion r2 TEST helper (AUTHORED, NOT RUN). REAL: the generated adapter (one separate instance per witness = each
// witness's own authenticated reader), servingContextOf, DeploymentLifecycleWitness, createPermitCollector, DeploymentPermitGate,
// createIsolationLifecycleRuntime, the owned protocol journal and the durable host-authority sidecars. TEST DOUBLES, and only these:
// the guestd manager client (in-memory VMs), launch plans, readiness, the runtime boundary hold/allow acks (a mock ack is NOT the missing
// production ingress/storage/secret/compute enforcement), each witness's readiness verifier and the witness transport (in-process fetch
// instead of deployment-witness-http). The chain/finality/receipt sources are the world's labelled TEST authority.
import path from 'node:path';
import { createPermitCollector } from '../../network/deployment-permit-collector.mjs';
import { DeploymentLifecycleWitness } from '../../network/deployment-lifecycle-witness.mjs';
import { DeploymentPermitGate } from '../../network/deployment-permit-gate.mjs';
import { createIsolationLifecycleRuntime } from '../../network/deployment-isolation-runtime.mjs';
import { openLifecycleJournal } from '../../network/deployment-lifecycle-journal.mjs';
import { openHostAuthorityJournal } from '../../network/deployment-host-authority-journal.mjs';
import { servingContextOf } from '../../network/deployment-host-authority.mjs';

export const PROFILE = 'independent-host-registry-r1';
export const v2Pins = lifecycle => Object.freeze({ chainId: 8453, lifecycle, profile: PROFILE, servingPermit: { version: 2, profile: PROFILE } });

/**
 * realV2Host(w, { dir, host, now }) -> { pins, calls, vms, inventory, witnesses, runtimeFor(journal), gate() }
 * w: host-registry-world (w.adapter(), w.operator, w.witnesses, w.contracts.lifecycle). The manager state (vms) and the witness
 * journals persist across runtimeFor() calls, as they would across a host process restart; gate + runtime are rebuilt per call.
 */
export function realV2Host(w, { dir, host, now }) {
  const pins = v2Pins(w.contracts.lifecycle);
  const calls = { serve: [], fence: [], stop: [], allow: [] };
  const vms = new Map(); let seq = 0;
  const client = { async findByName(id) { return vms.get(id) ?? null; },
    async spawn(body) { const view = { id: `vm-${++seq}`, name: body.name, status: 'running' }; vms.set(body.name, view); return { view }; },
    async remove(x) { for (const [k, v] of vms) if (v.id === x || k === x) vms.delete(k); } };
  const inventory = { findByName: id => client.findByName(id) };
  const witnesses = w.witnesses.map((account, i) => {
    const reader = w.adapter();                                                 // this witness's OWN authenticated reader (real adapter)
    const authority = { async read(id) { const s = await reader.read(id); return { ...servingContextOf(pins, s), policy: s.policy }; } };
    const health = { async verify(id, h, generation) { const v = vms.get(id);   // TEST readiness verifier
      return { verified: true, deployment: id, host: h, generation, ready: !!v, validUntil: Math.floor(now() / 1000) + 60 }; } };
    return new DeploymentLifecycleWitness({ pins, account, journal: openLifecycleJournal(path.join(dir, `witness-${i}.json`)), authority, health, now,
      hostAuthorityJournal: openHostAuthorityJournal(path.join(dir, `witness-${i}-ha.json`)) });
  });
  const fetchImpl = async (url, { body }) => {                                  // TEST transport: real collector -> real witness, in process
    const i = Number(new URL(url).hostname.split('.')[0].slice(1)), req = JSON.parse(body);
    try { return { ok: true, body: [Buffer.from(JSON.stringify(await witnesses[i].permit(req.record, req.operatorSignature)))] }; }
    catch { return { ok: false, body: [] }; }
  };
  const collectPermit = createPermitCollector({ pins, account: w.operator, fetchImpl,
    endpoints: w.witnesses.map((a, i) => ({ url: `https://w${i}.witness.test/`, address: a.address })) });
  const boundaries = {
    async hold(id) { calls.fence.push(id); return { deployment: id, ingress: true, storage: true, secrets: true }; },
    async allow(id, grant) { calls.serve.push(id); calls.allow.push(grant);
      return { deployment: id, generation: grant.generation, validUntil: grant.validUntil, expiryEnforced: true, hostAuthority: grant.hostAuthority }; } };
  let gate = null;
  function runtimeFor(journal) {   // the dispatch's owned journal object is ALSO the gate/runtime protocol journal (one file, one owner)
    gate = new DeploymentPermitGate({ pins, journal, now, hostAuthority: openHostAuthorityJournal(path.join(dir, 'gate-ha.json')) });
    const rt = createIsolationLifecycleRuntime({ client, gate, journal, collectPermit, boundaries, host, now,
      plans: { async read(id) { return { verified: true, host, body: { name: id }, stagingEnforced: true }; } },
      readiness: { async verify({ deployment, generation, view }) { return { verified: true, ready: true, deployment, host, generation, instance: view.id, validUntil: now() + 60000 }; } } });
    return { ...rt, async stop(id) { calls.stop.push(id); return rt.stop(id); } };
  }
  return { pins, calls, vms, inventory, witnesses, runtimeFor, gate: () => gate };
}
