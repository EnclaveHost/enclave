// A loopback-only composite manager for a separately scoped desktop manager.
// This does not grant secret release, verify attestation, or terminate app TLS.
// Existing partitions and their original manager retain transport custody.
//
// permit r1 (SOURCE ONLY): protected per-app instances live in the LEGACY manager under the pp + 32-hex namespace.
// Their routes (/control/hello, /control/session, POST /protected/vms, POST /protected/vms/<pp id>/{permit,hold},
// and guestd-control/1-authenticated GET /health, GET|DELETE /vms/<pp id>) are forwarded with the EXACT path, the
// exact body bytes and the x-guestd-* headers, and the answer comes back with its exact bytes and its
// x-guestd-response-mac. This router holds no pairing key and authenticates nothing: the manager verifies the request
// MAC and signs its answer, and the client verifies that signature end to end. A protected stage still passes this
// router's serialized capacity admission and append-only launch latch, exactly like a legacy spawn.
import {createHash, randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {cpuForShare,CPU_UNITS_PER_VCPU,validCpuPool} from './cpu-share.mjs';
import {appMemoryForShare} from '../manager/memory-share.mjs';
import {desktopVmMemMiB} from '../manager/desktop-memory.mjs';
import {derive,COMPONENT_PREAMBLE} from '../manager/derive.mjs';
import {refuseUnsupported} from '../manager/server.mjs';
import {inferenceRefusal} from '../manager/shield-profile.mjs';
import {validateDesktopRecord} from '../manager/desktop-derive.mjs';
import {desktopSpawnRefusal} from '../manager/desktop-admission.mjs';
import {type1VmMemMiB} from '../manager/wmi-launcher.mjs';

export const NATIVE_ID = /^nd[0-9a-f]{32}$/;
export const PROTECTED_ID = /^pp[0-9a-f]{32}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const V8 = 'enclave-catalog-bundle/8';
const LIVE = new Set(['starting', 'running']);
const AUTH_HEADERS = ['x-guestd-session','x-guestd-seq','x-guestd-mac'];
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const error = (message, status=503) => Object.assign(new Error(message), {status});
const natural = (x, label) => {if (!Number.isSafeInteger(x) || x < 0) throw error(`unknown ${label}`); return x;};
export const authenticated = (headers={}) => AUTH_HEADERS.some(k=>headers[k]!==undefined);
export function routePath(raw) {
  if(typeof raw!=='string'||!raw.startsWith('/')||raw.startsWith('//')||raw.length>2048)throw error('unknown manager route',404);
  const p=new URL(raw,'http://127.0.0.1').pathname.replace(/\/+$/,'')||'/';
  if(p==='/health'||p==='/vms'||p==='/router/reconcile')return {path:p};
  // permit r1: exact protected/control routes only; no query, no encoding, no trailing slash, no alias
  if(p.startsWith('/control/')||p.startsWith('/protected/')||p==='/protected'){
    if(raw!==p)throw error('protected and control routes take no query, encoding or alias',400);
    if(p==='/control/hello'||p==='/control/session')return {path:p,control:true,role:'legacy',raw:true};
    if(p==='/protected/vms')return {path:p,stage:true,role:'legacy',raw:true};
    const q=/^\/protected\/vms\/(pp[0-9a-f]{32})\/(permit|hold)$/.exec(p);
    if(q)return {path:p,id:q[1],role:'legacy',protectedOp:q[2],raw:true};
    throw error('unknown manager route',404);
  }
  const m=/^\/vms\/([^/]+)(\/custody-auth)?$/.exec(p);
  if(!m)throw error('unknown manager route',404);
  let id;try{id=decodeURIComponent(m[1]);}catch{throw error('invalid instance encoding',400);}
  return {path:p,id,role:routeFor(id),custody:!!m[2]};
}
export const routeFor = id => {
  if (typeof id !== 'string' || !ID.test(id)) throw error('invalid instance id',400);
  if (id.startsWith('nd') && !NATIVE_ID.test(id)) throw error('invalid native namespace',400);
  if (id.startsWith('pp') && !PROTECTED_ID.test(id)) throw error('invalid protected namespace',400);
  return NATIVE_ID.test(id) ? 'native' : 'legacy';
};

// The latch survives process death and an ambiguous POST outcome. A restart is
// NOT reconciliation: operators must reconcile the backend before clearing it.
export class LaunchJournal {
  static initialize(file) {
    const initial={seq:0,previous:null,state:'observed',record:{schema:'enclave-router-journal/1'}};
    const fd=fs.openSync(file,'wx',0o600);
    try {fs.writeFileSync(fd,JSON.stringify({...initial,digest:hash(initial)})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    // Lost initialization is fail-closed: production startup NEVER creates a
    // missing journal. Existing entries are appended and flushed, never unlinked.
    if(process.platform!=='win32'){const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
  }
  constructor(file) {this.file=file;this.read();}
  read() {
    let st,raw;
    try {
      st=fs.lstatSync(this.file);
      const parent=fs.lstatSync(path.dirname(this.file));
      if(!parent.isDirectory() || parent.isSymbolicLink() || (process.platform!=='win32' && (parent.uid!==process.getuid() || (parent.mode & 0o077)!==0)))throw Error('journal directory permissions');
      if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1 || st.size<1 || st.size>1048576)throw Error('invalid journal file');
      if(process.platform!=='win32' && (st.uid!==process.getuid() || (st.mode & 0o077)!==0))throw Error('journal permissions');
      const kind=Number(fs.statfsSync(this.file).type);
      if([0x01021994,0x858458f6,0x9fa0,0x62656572].includes(kind))throw Error('journal must use persistent storage');
      raw=fs.readFileSync(this.file,'utf8');
    }catch{throw error('launch journal unavailable; reconciliation required');}
    if(!raw.endsWith('\n'))throw error('incomplete launch journal');
    let previous=null,last=null,seq=0;
    try {for(const line of raw.trimEnd().split('\n')){
      const row=JSON.parse(line),{digest,...data}=row;
      if(row.seq!==seq++ || row.previous!==previous || digest!==hash(data) || !['pending','observed'].includes(row.state))throw Error('journal chain');
      previous=digest;last=row;
    }}catch{throw error('invalid launch journal; reconciliation required');}
    if(!last)throw error('empty launch journal');return last;
  }
  pending() {return this.read().state==='pending';}
  append(state,record) {
    const before=this.read(),data={seq:before.seq+1,previous:before.digest,state,record};
    const fd=fs.openSync(this.file,'a');
    try{fs.writeFileSync(fd,JSON.stringify({...data,digest:hash(data)})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  hasCapacity() {this.read();return fs.statSync(this.file).size<900000;}
  begin(record) {if(this.pending())throw error('unreconciled launch');if(!this.hasCapacity())throw error('journal maintenance required before admission');this.append('pending',record);}
  clear(observation) {if(!this.pending())throw error('no pending launch to observe');this.append('observed',observation);}
}

export class CompositeManager {
  constructor({request, journal, nativePins, nativeScope='enclave-native-', availableMemoryMiB, mint=()=> 'nd'+randomBytes(16).toString('hex')}) {
    if (typeof request!=='function' || !journal || !nativePins || typeof availableMemoryMiB!=='function') throw error('router configuration absent');
    for (const name of ['deployment','catalogApp']) if (!/^0x[0-9a-f]{64}$/.test(nativePins[name]||'')) throw error('invalid native deployment/catalog pin');
    for (const name of ['runtimeId','profileSha256','igvmSha256','controllerSha256']) if (!/^[0-9a-f]{64}$/.test(nativePins[name]||'')) throw error('invalid native image pin');
    if (!Number.isSafeInteger(nativePins.catalogVersion) || nativePins.catalogVersion<0 || typeof nativePins.cid!=='string' || !nativePins.cid) throw error('invalid native version pin');
    this.availableMemoryMiB=availableMemoryMiB;this.request=request;this.journal=journal;this.pins=Object.freeze({...nativePins});this.nativeScope=nativeScope;this.mint=mint;this.tail=Promise.resolve();
  }
  async serial(fn) {const previous=this.tail;let done;this.tail=new Promise(r=>{done=r;});await previous;try{return await fn();}finally{done();}}
  async snapshot() {
    const all=await Promise.all(['legacy','native'].map(async role=> {
      const [health,list]=await Promise.all([this.request(role,'GET','/health'),this.request(role,'GET','/vms')]);
      if (health.status!==200 || list.status!==200 || !health.body?.managerEpoch || health.body.managerEpoch!==list.body?.managerEpoch || !Array.isArray(list.body.vms)) throw error(`${role} inventory unavailable or epoch changed`);
      if (health.body.inventory?.state!=='ready') throw error(`${role} inventory unknown`);
      return {role,health:health.body,rows:list.body.vms};
    }));
    const [legacy,native]=all, lh=legacy.health, nh=native.health;
    if (lh.backend!=='hyperv-partition-per-app' || nh.backend!==lh.backend || JSON.stringify(lh.boundary)!==JSON.stringify(nh.boundary)) throw error('manager boundaries differ');
    if (nh.vmScope?.prefix!==this.nativeScope || lh.vmScope?.prefix===this.nativeScope) throw error('manager scopes differ from routing contract');
    const appPool=natural(lh.memory?.poolMiB,'app pool'),physicalPool=natural(lh.physicalMemory?.poolMiB,'physical pool');
    if (!appPool || !physicalPool || nh.memory?.poolMiB!==appPool || nh.physicalMemory?.poolMiB!==physicalPool) throw error('manager shared pool definitions differ');
    const cpuPool=lh.cpu?.poolVcpus;
    if(!validCpuPool(cpuPool)||nh.cpu?.poolVcpus!==cpuPool||lh.cpu?.unitsPerVcpu!==CPU_UNITS_PER_VCPU||nh.cpu?.unitsPerVcpu!==CPU_UNITS_PER_VCPU||!Number.isSafeInteger(lh.cpu?.hostLogicalProcessors)||!Number.isSafeInteger(nh.cpu?.hostLogicalProcessors)||lh.cpu.hostLogicalProcessors<cpuPool||nh.cpu.hostLogicalProcessors<cpuPool)throw error('CPU pools unknown or inconsistent');
    const desktop=nh.desktop,p=this.pins;
    for (const key of ['runtimeId','igvmSha256','profileSha256','controllerSha256']) if (desktop?.[key]!==p[key]) throw error('native manager image differs from configured pin');
    const ids=new Set(),names=new Set();let app=0,physical=0,gpu=0,cpu=0;
    for (const {role,rows} of all) for (const r of rows) {
      let actualRole;try{actualRole=routeFor(r?.id);}catch{throw error('invalid backend instance identity');}
      if (!r || actualRole!==role || ids.has(r.id) || r.recovered || r.unattributed || typeof r.name!=='string' || !r.name) throw error('ambiguous manager inventory');
      // permit r1: a pp id is protected only in the legacy manager and only with its enforcement view
      if (PROTECTED_ID.test(r.id) && (role!=='legacy' || !r.protected || typeof r.protected.state!=='string')) throw error('protected instance without its enforcement view');
      if (!PROTECTED_ID.test(r.id) && r.protected!==undefined) throw error('enforcement view on a non-protected instance');
      ids.add(r.id);
      if (!['starting','running','failed','stopped'].includes(r.status)) throw error('unknown domain state');
      if (LIVE.has(r.status)) {if(names.has(r.name))throw error('duplicate active deployment');names.add(r.name);}
      if (role==='native' && (r.imageRole!=='desktop' || r.name!==p.deployment || r.runtimeId!==p.runtimeId || r.desktop?.profileSha256!==p.profileSha256)) throw error('unexpected native domain');
      if (role==='legacy' && (r.imageRole==='desktop' || r.name===p.deployment)) throw error('native domain remains in legacy manager');
      app+=natural(r.memory?.appMiB ?? r.policy?.memMiB,'domain app memory');
      physical+=natural(r.physicalMemoryMiB,'domain physical memory');
      gpu+=natural(r.gpuMilli,'domain GPU allocation');
      cpu+=natural(r.cpu?.grantedUnits,'domain CPU allocation');
    }
    if (![app,physical,gpu,cpu].every(Number.isSafeInteger) || app>appPool || physical>physicalPool || gpu>1000 || cpu>cpuPool*CPU_UNITS_PER_VCPU) throw error('shared capacity exceeded');
    return {legacy:lh,native:nh,rows:all.flatMap(x=>x.rows),appPool,physicalPool,app,physical,gpu,cpuPool,cpu,epoch:hash(all.map(x=>[x.role,x.health.managerEpoch]))};
  }
  async health() {
    let s;
    try{s=await this.snapshot();}catch{
      // A partial inventory is never a list of all domains. Keep the known
      // legacy capability visible for existing routes, with ALL admission off.
      const legacy=await this.request('legacy','GET','/health');
      if(legacy.status!==200||!legacy.body?.managerEpoch||legacy.body.inventory?.state!=='ready')throw error('manager health unavailable');
      const h=structuredClone(legacy.body);
      h.canStart=false;h.cannotStart=['composite inventory unavailable'];
      h.inventory={state:'pending',reason:'composite inventory unavailable'};
      h.physicalMemory={poolMiB:h.physicalMemory?.poolMiB,allocatedMiB:null,freeMiB:0};
      h.memory={...h.memory,allocatedMiB:null,freeMiB:0};
      h.cpu={...h.cpu,allocatedUnits:null,freeUnits:0};
      h.catalog.derivations=[];h.supports.desktop=false;h.supports.gpu=false;
      if(h.desktop)h.desktop={...h.desktop,ready:false,freeGpuMilli:0};
      if(h.inference)h.inference={...h.inference,ready:false,freeGpuMilli:0};
      if(h.permitEnforcement)this.#noProtected(h,'composite inventory unavailable');
      return {status:200,body:h};
    }
    const h=structuredClone(s.legacy), d=structuredClone(s.native.desktop);
    h.managerEpoch=s.epoch;h.vmScopes=[s.legacy.vmScope,s.native.vmScope];
    h.physicalMemory={poolMiB:s.physicalPool,allocatedMiB:s.physical,freeMiB:s.physicalPool-s.physical};
    h.memory={...h.memory,allocatedMiB:s.app,freeMiB:s.appPool-s.app};
    h.cpu={...h.cpu,allocatedUnits:s.cpu,freeUnits:s.cpuPool*CPU_UNITS_PER_VCPU-s.cpu};
    d.allocatedGpuMilli=s.gpu;d.freeGpuMilli=d.ready?1000-s.gpu:0;h.desktop=d;
    if(h.inference){h.inference.allocatedGpuMilli=s.gpu;h.inference.freeGpuMilli=h.inference.ready?1000-s.gpu:0;}
    h.supports.desktop=d.ready===true;h.supports.gpu=Boolean(h.inference?.ready || d.ready);
    h.catalog.derivations=h.catalog.derivations.filter(x=>x!==V8);
    if(d.ready && s.native.catalog?.derivations?.includes(V8))h.catalog.derivations.push(V8);
    h.catalog.derives=[...new Set([...h.catalog.derives,V8])];
    if(h.preflight?.roles)h.preflight.roles.desktop=s.native.preflight?.roles?.desktop ?? {ok:false};
    try{if(this.journal.pending()||!this.journal.hasCapacity()){h.canStart=false;h.cannotStart=['router journal requires reconciliation or maintenance'];h.catalog.derivations=[];if(h.permitEnforcement)this.#noProtected(h,'router journal requires reconciliation');}}catch{h.canStart=false;h.cannotStart=['router journal unavailable'];h.catalog.derivations=[];if(h.permitEnforcement)this.#noProtected(h,'router journal unavailable');}
    return {status:200,body:h};
  }
  #noProtected(h,why) {h.permitEnforcement={...h.permitEnforcement,available:false,reasons:[...(h.permitEnforcement.reasons||[]),why]};delete h.permitEnforcement.enforcementEpoch;h.supports={...h.supports,permitEnforcement:false};}
  checkNative(body) {
    const p=this.pins,d=body.derive;
    if (body.name!==p.deployment || body.id || d?.catalog?.app!==p.catalogApp || d?.catalog?.version!==p.catalogVersion || d?.cid!==p.cid || d?.runtimeId!==p.runtimeId || d?.desktop?.profileSha256!==p.profileSha256 || d?.secretDeployment!==p.deployment) throw error('native request differs from configured deployment',400);
    if (body.cpuShare!==0.25 || body.gpuShare!==0.5 || d.desktop.gpuMilli!==500) throw error('native resource allocation differs from configured deployment',400);
  }
  precheck(body,h,native) {
    const d=body.derive;
    try {
      if(native){validateDesktopRecord(d);const why=desktopSpawnRefusal(d,body);if(why)throw Error(why);}
      else {
        // Reuse the installed backend's deterministic record validation. These
        // placeholder component bytes validate structure only; the backend must
        // still fetch and verify the real CID before it creates any partition.
        derive({record:d,component:COMPONENT_PREAMBLE});
        if(!h.catalog?.derivations?.includes(d.derivation))throw Error('derivation is not served');
        if(d.inference){const why=inferenceRefusal(d,body,h.inference);if(why)throw Error(why);}
        else if(d.runtimeId!==h.catalog?.runtimeId)throw Error('runtime differs from installed backend');
        const secret=['enclave-catalog-bundle/6','enclave-catalog-bundle/7'].includes(d.derivation);
        if(secret&&(body.hasSecrets!==true||body.name!==d.secretDeployment))throw Error('secret deployment differs');
        if([5,6,7].some(n=>d.derivation==='enclave-catalog-bundle/'+n)&&(body.config||body.configCid||body.appConfigCid))throw Error('configuration must be in measured record');
        const why=refuseUnsupported(body,{...h.supports,ports:false,gpu:!!h.inference?.ready,secrets:secret&&h.supports?.secrets===true});if(why)throw Error(why);
        if(body.name==='shield-readiness-v1') {
          if(d.cid!=='bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza'||d.derivation!=='enclave-catalog-bundle/1'||d.policy.memMiB!==256||d.policy.cpuPercent!==100||d.policy.vcpus!==1||d.http||body.cpuShare!==0||body.gpuShare!==0)
            throw Error('readiness request differs from qualified component and policy');
        }else if(!/^0x[0-9a-f]{64}$/.test(body.name||''))throw Error('invalid deployment name');
      }
    }catch(e){throw error('request refused before launch: '+e.message,400);}
  }
  // The legacy body shape checks shared by a legacy spawn and a protected stage.
  checkLegacy(body) {
    const declared=body.derive?.inference?.gpuMilli;
    if(typeof body.gpuShare!=='number' || !Number.isFinite(body.gpuShare) || body.gpuShare<0 || body.gpuShare>1 ||
      (body.gpuShare>0 ? !Number.isSafeInteger(declared) || declared!==Math.round(body.gpuShare*1000) || body.derive.derivation!=='enclave-catalog-bundle/4' : declared!==undefined || body.derive?.inference!=null))
      throw error('GPU allocation is unknown or inconsistent',400);
    // derive.mjs copies these exact policy values and exact V4 gpuMilli into
    // mapping.record; it does not obtain another allocation from component bytes.
    if(!Number.isSafeInteger(body.derive?.policy?.memMiB) || body.derive.policy.memMiB<64 || body.derive.policy.memMiB>65536)throw error('memory policy unknown',400);
  }
  // Shared capacity admission over one snapshot. -> the reservation the journal records.
  async admission(body,s,native) {
    const memory=body.name==='shield-readiness-v1' && body.derive?.policy?.memMiB===256
      ? {appMiB:256} : appMemoryForShare(s.appPool,body.cpuShare,body.derive?.policy?.memMiB);
    let cpu;try{cpu=body.name==='shield-readiness-v1'?natural(body.derive.policy.vcpus,'witness CPUs')*CPU_UNITS_PER_VCPU:cpuForShare(s.cpuPool,body.cpuShare,body.derive.policy).grantedUnits;}catch{throw error('CPU allocation unknown',400);}
    const physical=native?desktopVmMemMiB(memory.appMiB):type1VmMemMiB(memory.appMiB,{name:body.name});
    const gpu=natural(native?body.derive.desktop.gpuMilli:(body.derive?.inference?.gpuMilli ?? 0),'requested GPU');
    if(memory.appMiB>s.appPool-s.app || physical>s.physicalPool-s.physical || gpu>1000-s.gpu || cpu>s.cpuPool*CPU_UNITS_PER_VCPU-s.cpu)throw error('shared capacity cannot fit requested domain',507);
    const hostFree=natural(await this.availableMemoryMiB(),'host physical headroom');
    if(hostFree<physical+17*1024)throw error('host physical headroom cannot preserve 17 GiB startup reserve',507);
    return {cpuUnits:cpu,appMiB:memory.appMiB,physicalMiB:body.name==='shield-readiness-v1'?512:physical,gpuMilli:gpu,runtimeId:body.derive.runtimeId,cid:body.derive.cid,catalog:body.derive.catalog};
  }
  async spawn(body) {return this.serial(async()=>{
    if(this.journal.pending())throw error('unreconciled router launch');
    if(!body || typeof body!=='object' || Array.isArray(body))throw error('invalid spawn body',400);
    body=structuredClone(body);
    if(['secrets','env','secretValues','bootstrap'].some(k=>k in body))throw error('unsupported startup inputs',400);
    if(Object.keys(body.derive?.catalog??{}).sort().join(',')!=='app,version')throw error('invalid catalog fields',400);
    const native=body.derive?.derivation===V8,role=native?'native':'legacy';
    if(native)this.checkNative(body);
    else if(body.name===this.pins.deployment || body.derive?.desktop || (body.id && routeFor(body.id)!=='legacy'))throw error('legacy request crosses native namespace',400);
    if(body.id && PROTECTED_ID.test(String(body.id)))throw error('legacy request crosses protected namespace',400);
    if(!native)this.checkLegacy(body);
    const s=await this.snapshot();
    this.precheck(body,s[role],native);
    const existing=s.rows.find(r=>r.name===body.name && LIVE.has(r.status));
    if(existing)return {status:409,body:{error:'deployment already exists',id:existing.id}};
    if(!s[role].canStart || (native && !s.native.desktop.ready))throw error('target manager unavailable');
    const expected=await this.admission(body,s,native);
    const forwarded=structuredClone(body);if(native){forwarded.id=this.mint();if(!NATIVE_ID.test(forwarded.id))throw error('native id generator invalid');}
    else forwarded.id=body.id||'hv'+randomBytes(16).toString('hex');
    if(s.rows.some(r=>r.id===forwarded.id))throw error('instance id already reserved',409);
    this.journal.begin({schema:'enclave-router-pending/1',role,name:body.name,id:forwarded.id??null,requestSha256:hash(forwarded),epoch:s.epoch,expected,startedAt:new Date().toISOString()});
    // The intent remains on any thrown error, 5xx, malformed success or transport
    // failure. No automatic retry can create an overlapping reservation.
    let result;try{
    result=await this.request(role,'POST','/vms',forwarded);
    if([200,201].includes(result.status)) {
      const r=result.body;
      if(!r || r.name!==body.name || routeFor(r.id)!==role || (native && r.id!==forwarded.id))throw error('unverifiable launch response');
      await this.observePending();
    }
    // Even a 4xx retains the latch: no HTTP status alone proves that a backend
    // did not create a partition before answering. Reconciliation is explicit.
    if(![200,201].includes(result.status))throw error('backend launch outcome requires reconciliation');
    return result;
    }catch(e){throw error('launch outcome unknown; reconciliation required');}
  });}
  // permit r1: an authenticated protected stage. The body bytes are MAC'd end to end and are forwarded unchanged;
  // the manager mints the pp id, so the latch records the name and correlates the id from the answer.
  async stageProtected(path,raw,headers) {return this.serial(async()=>{
    if(this.journal.pending())throw error('unreconciled router launch');
    let req;try{req=JSON.parse(raw.toString('utf8'));}catch{throw error('invalid protected stage body',400);}
    const body=req?.spawn;
    if(!body || typeof body!=='object' || Array.isArray(body) || 'id' in body || body.name!==req.deployment)throw error('invalid protected stage body',400);
    if(['secrets','env','secretValues','bootstrap'].some(k=>k in body)||body.derive?.derivation===V8||body.derive?.desktop||body.name===this.pins.deployment)throw error('protected stage crosses native or secret inputs',400);
    if(Object.keys(body.derive?.catalog??{}).sort().join(',')!=='app,version')throw error('invalid catalog fields',400);
    this.checkLegacy(body);
    const s=await this.snapshot();
    this.precheck(body,s.legacy,false);
    if(s.legacy.permitEnforcement?.available!==true)throw error('protected enforcement unavailable in the legacy manager');
    const existing=s.rows.find(r=>r.name===body.name && LIVE.has(r.status));
    if(existing)return {status:409,body:{error:'deployment already exists',id:existing.id}};
    if(!s.legacy.canStart)throw error('target manager unavailable');
    const expected=await this.admission(body,s,false);
    this.journal.begin({schema:'enclave-router-pending/1',role:'legacy',name:body.name,id:null,protected:true,requestSha256:createHash('sha256').update(raw).digest('hex'),epoch:s.epoch,expected,startedAt:new Date().toISOString()});
    let result;try{
      result=await this.request('legacy','POST',path,raw,headers);
      if(result.status===202){
        const id=result.body?.instanceId;
        if(!PROTECTED_ID.test(id||'') || result.body?.deployment!==body.name)throw error('unverifiable protected stage response');
        await this.observePending(id);
      }
      if(result.status!==202)throw error('protected stage outcome requires reconciliation');
      return result;
    }catch(e){throw error('protected stage outcome unknown; reconciliation required');}
  });}
  async observePending(answeredId=null) {
    const pending=this.journal.read();if(pending.state!=='pending')throw error('no pending launch');
    const r=pending.record,s=await this.snapshot(),e=r.expected;
    let id=r.id;
    if(id===null && r.protected===true){
      // explicit reconciliation without the answer: exactly one live protected row for this name
      const c=answeredId?[answeredId]:s.rows.filter(x=>PROTECTED_ID.test(x.id)&&x.name===r.name&&LIVE.has(x.status)).map(x=>x.id);
      if(c.length!==1)throw error('pending protected stage has no single correlated instance');
      id=c[0];
    }
    const v=s.rows.find(x=>x.id===id);
    if(!e||s.epoch!==r.epoch||!v||v.name!==r.name||routeFor(v.id)!==r.role||(r.protected===true)!==PROTECTED_ID.test(v.id)||
       (v.memory?.appMiB??v.policy?.memMiB)!==e.appMiB||v.physicalMemoryMiB<e.physicalMiB||
       v.gpuMilli!==e.gpuMilli||v.cpu?.grantedUnits!==e.cpuUnits||v.runtimeId!==e.runtimeId||v.cid!==e.cid||
       v.catalog?.app!==e.catalog?.app||v.catalog?.version!==e.catalog?.version)throw error('pending launch has no correlated same-epoch reservation');
    this.journal.clear({observation:'same-epoch backend reservation confirmed',id,epoch:s.epoch,requestSha256:r.requestSha256});
    return {status:200,body:{observed:true,id}};
  }
  // Explicit operator reconciliation only. Absence, backend 4xx, restart or
  // elapsed time NEVER clears a pending launch: it may still be in flight.
  async reconcile() {return this.serial(()=>this.observePending());}
  async handle(method,path,body,headers={}) {
    const r=routePath(path);
    const auth=authenticated(headers);
    // permit r1: control handshake and authenticated requests reach exactly the legacy (protected-capable) manager
    if(r.control){
      if(!((method==='GET'&&r.path==='/control/hello'&&!body?.length)||(method==='POST'&&r.path==='/control/session')))throw error('unknown manager route',404);
      return this.request('legacy',method,path,body?.length?body:undefined,headers);
    }
    if(r.stage||r.protectedOp){
      if(!auth)return {status:401,body:{error:'guestd-control/1 authentication required'}};
      if(method!=='POST')throw error('unknown manager route',404);
      if(r.stage)return this.stageProtected(path,Buffer.isBuffer(body)?body:Buffer.alloc(0),headers);
      return this.request('legacy',method,path,Buffer.isBuffer(body)?body:Buffer.alloc(0),headers);
    }
    if(auth){
      // the only authenticated passthroughs: health, and a protected id's view or Stop. No blanket proxy.
      if(method==='GET'&&r.path==='/health'&&!body?.length)return this.request('legacy',method,path,undefined,headers);
      if(r.id&&PROTECTED_ID.test(r.id)&&!r.custody&&['GET','DELETE'].includes(method)&&!body?.length)return this.request('legacy',method,path,undefined,headers);
      throw error('unknown authenticated route',404);
    }
    if(method==='POST'&&r.path==='/router/reconcile')return this.reconcile();
    if(method==='GET' && r.path==='/health')return this.health();
    if(method==='GET' && r.path==='/vms'){const s=await this.snapshot();return {status:200,body:{vms:s.rows,managerEpoch:s.epoch}};}
    if(method==='POST' && r.path==='/vms')return this.spawn(body);
    if(!r.id || !(r.custody?method==='POST':['GET','DELETE'].includes(method)))throw error('unknown manager route',404);
    // Routing uses a decoded id but the authenticated path and body are never
    // rewritten. The original manager remains the authorization authority.
    return this.request(r.role,method,path,body,headers);
  }
}
