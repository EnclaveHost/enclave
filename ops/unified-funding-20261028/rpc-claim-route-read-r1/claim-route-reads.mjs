// PREPARED ONLY; not executed or syntax-qualified. Root supplies process binding and outer deadline.
// Loopback GET only, exact three claims; no auth, config dump, writes or module imports from service.
import http from 'node:http';
const ids = [
  '0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c',
  '0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c',
  '0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b',
];
const LIMIT = 262144;
function scalars(o, keys) {
  const values = {}, invalid = [];
  for (const k of keys) if (Object.hasOwn(o ?? {}, k)) {
    const v = o[k];
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 1024)) values[k] = v;
    else invalid.push(k);
  }
  return {values, invalid}; // missing, null and invalid remain distinct
}
function reservation(r) {
  return {
    fields: scalars(r, ['id','instance','name','status','manager','managerEpoch','derivation','imageRole','physicalMemoryMiB','launcherVmId','vmName','cid','runtimeId','recovered','unattributed']),
    memory: scalars(r?.memory, ['appMiB','vmMiB']),
    policy: scalars(r?.policy, ['memMiB','cpuPercent','vcpus']),
    catalog: scalars(r?.catalog, ['app','version']),
    desktop: scalars(r?.desktop, ['profile','profileSha256','gpuMilli']),
  };
}
function claim(r, id) {
  if (r?.id !== id) throw Error('wrong-deployment');
  return {
    fields: scalars(r, ['id','status','appRef','claimTx','claimedAt','updatedAt','runner','leaseUntil','memMb','cpuShare','needCpuShare','gpuShare','isolationRequired']),
    isolationPresent: Object.hasOwn(r, 'isolation'),
    isolationHeldPresent: Object.hasOwn(r, 'isolationHeld'),
    isolationRetireFailedPresent: Object.hasOwn(r, 'isolationRetireFailed'),
    hasIsolation: !!r.isolation, hasIsolationHold: !!r.isolationHeld, hasRetireFailure: !!r.isolationRetireFailed,
    isolation: reservation(r.isolation),
  };
}
function health(r) {
  return {
    fields: scalars(r, ['managerEpoch','backend','canStart']),
    memory: scalars(r?.memory, ['rule','poolMiB','freeMiB','reservedMiB']),
    physicalMemory: scalars(r?.physicalMemory, ['poolMiB','allocatedMiB','freeMiB']),
    desktop: scalars(r?.desktop, ['ready','runtimeId','profileSha256','igvmSha256','controllerSha256']),
  };
}
function vms(r) {
  if (!Array.isArray(r?.vms) || r.vms.length > 128) throw Error('vm-row-bound');
  return {managerEpoch: scalars(r, ['managerEpoch']), totalRows: r.vms.length,
    matches: r.vms.filter(v => ids.includes(v.name)).map(reservation)};
}
function get(port, path) {
  return new Promise((resolve, reject) => {
    let done = false, req, timer;
    const finish = (err, value) => {
      if (done) return; done = true; clearTimeout(timer);
      if (err) { req?.destroy(); reject(err); } else resolve(value);
    };
    timer = setTimeout(() => finish(Error('deadline')), 2500);
    req = http.request({hostname:'127.0.0.1', port, path, method:'GET', agent:false}, res => {
      if (res.statusCode !== 200) return finish(Error(`http-${res.statusCode}`));
      let count=0; const chunks=[];
      res.on('data', b => {count+=b.length; if(count>LIMIT)return finish(Error('body-limit')); if(!done)chunks.push(b);});
      res.on('aborted', () => finish(Error('body-aborted')));
      res.on('error', () => finish(Error('body-error')));
      res.on('end', () => {if(done)return;try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(Error('invalid-json'));}});
    });
    req.on('error', () => finish(Error('transport-error'))); req.end();
  });
}
const out = {schema:'minipc-exact-claim-route-read/1', readOnly:true, startedAt:new Date().toISOString(), observations:[], errors:[], capacityAdmitted:false};
async function record(label, port, path, project) {
  try {out.observations.push({label,port,path,at:new Date().toISOString(),data:project(await get(port,path))});}
  catch(e){out.errors.push({label,port,path,reason:e.message});}
}
for(const id of ids)await record('claim-before',9600,`/v1/deployments/${id}`,r=>claim(r,id));
for(const port of [8091,8095,8097]){
  await record('health-before',port,'/health',health);
  await record('vms',port,'/vms',vms);
  await record('health-after',port,'/health',health);
}
for(const id of ids)await record('claim-after',9600,`/v1/deployments/${id}`,r=>claim(r,id));
out.finishedAt=new Date().toISOString();out.completeTransport=out.errors.length===0;
const text=JSON.stringify(out);if(Buffer.byteLength(text)>LIMIT)throw Error('output-limit');
process.stdout.write(text+'\n');
