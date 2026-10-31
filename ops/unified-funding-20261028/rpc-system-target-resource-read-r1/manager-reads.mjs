// PREPARED ONLY. No execution or syntax qualification in this chat.
// Run only on minipc through the coordinator's bounded, identity-pinned reader.
import http from 'node:http';

const startedAt = new Date().toISOString();
const LIMIT = 262144;
const pick = (o, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(o ?? {}, k)).map(k => [k, o[k]]));
function rows(xs, project) {
  if (!Array.isArray(xs) || xs.length > 128) throw new Error('invalid-or-overlimit-rows');
  return xs.map(project);
}
function get(port, path) {
  return new Promise((resolve, reject) => {
    let done = false, req, timer;
    const finish = (err, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (err) { req?.destroy(); reject(err); } else resolve(value);
    };
    timer = setTimeout(() => finish(new Error('deadline')), 2500);
    req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', agent: false }, res => {
      if (res.statusCode !== 200) return finish(new Error(`http-${res.statusCode}`));
      let total = 0; const chunks = [];
      res.on('data', b => {
        total += b.length;
        if (total > LIMIT) return finish(new Error('body-limit'));
        if (!done) chunks.push(b);
      });
      res.on('aborted', () => finish(new Error('body-aborted')));
      res.on('error', () => finish(new Error('body-error')));
      res.on('end', () => {
        if (done) return;
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(new Error('invalid-json')); }
      });
    });
    req.on('error', () => finish(new Error('transport-error')));
    req.end();
  });
}
const memKeys = ['rule','poolMiB','reservedMiB','known','freeMiB','vmMiB','vmOverheadMiB'];
function health(h) {
  const m = h.memory;
  return {
    ...pick(h, ['managerEpoch','backend','canStart']),
    vmScope: pick(h.vmScope, ['prefix','marker']),
    memory: m == null ? null : {
      ...pick(m, memKeys),
      unknownCount: Array.isArray(m.unknown) ? m.unknown.length : null,
      reservationsPresent: Object.hasOwn(m, 'reservations'),
      reservations: m.reservations === undefined ? null : rows(m.reservations, r => pick(r, ['id','name','status','appMiB','vmMiB'])),
    },
    physicalMemory: h.physicalMemory == null ? null : pick(h.physicalMemory, ['poolMiB','allocatedMiB','freeMiB']),
  };
}
function vmList(x) {
  return { managerEpoch: x.managerEpoch ?? null, vms: rows(x.vms, r => ({
    ...pick(r, ['id','name','status','recovered','unattributed']),
    memory: pick(r.memory, ['appMiB','vmMiB']),
  })) };
}
function nodeState(x) {
  return { deployments: rows(x.deployments, r => ({
    ...pick(r, ['id','status','memMb','cpuShare','needCpuShare','isolationRequired']),
    hasIsolation: !!r.isolation, isolationHeld: !!r.isolationHeld,
    isolationRetireFailed: !!r.isolationRetireFailed,
    isolation: pick(r.isolation, ['id','name','manager','managerEpoch']),
  })), availability: pick(x.availability, ['isolation','ramMb','ramMbFree','capacity','running']) };
}
const result = { schema: 'minipc-manager-reservations-read/1', startedAt, readOnly: true,
  nodePortBasis: '9600 installer default; must bind to current node listener before accepting',
  observations: [], errors: [], capacityAdmitted: false };
async function record(label, port, path, project) {
  try { result.observations.push({ label, port, path, at: new Date().toISOString(), data: project(await get(port, path)) }); }
  catch (e) { result.errors.push({ label, port, path, reason: e.message }); }
}
// Known installed manager endpoints from 2026-10-29 evidence; not port discovery.
await record('node-before', 9600, '/v1/host/state', nodeState);
for (const port of [8091, 8095, 8097]) {
  await record('manager-before', port, '/health', health);
  await record('manager-vms', port, '/vms', vmList);
  await record('manager-after', port, '/health', health);
}
await record('node-after', 9600, '/v1/host/state', nodeState);
result.finishedAt = new Date().toISOString();
result.completeTransport = result.errors.length === 0;
// Completeness of transport is NOT freshness/ownership/growth/admission proof.
const out = JSON.stringify(result);
if (Buffer.byteLength(out) > LIMIT) throw new Error('sanitized-output-limit');
process.stdout.write(out + '\n');
