// A whole-VM app: a catalog version whose runtime is "sev-snp-vm", leased with the snpVm deployment option. The lease
// is one SEV-SNP VM that the host's VM manager (rpc/snp/vm-manager.mjs) launches from the version's measured image,
// and the VM's own front terminates TLS on a key that never leaves it. So the agent admits it on a fresh report from
// that front and routes the app's names to the VM's loopback port, byte for byte.
//
// What the agent expects comes from the chain: the image and launch measurements of the lease's catalog version.
// The manager is asked only where the VM listens. A report is accepted when AMD signed it, its launch measurement is
// one the version lists, HOST_DATA names this deployment, and report_data binds the key this connection presented
// to the nonce just sent.
import net from 'node:net';
import {createHash} from 'node:crypto';
import {verifyQuote} from '../relay/snp-verify.mjs';
import {vcekTable} from '../isolation/m2/judge.mjs';

export const SNP_VM_RUNTIME='sev-snp-vm',SNP_VM_FORMAT='sev-snp-vm-v1';
const HEX64=/^[0-9a-f]{64}$/,HEX96=/^[0-9a-f]{96}$/;
const validPort=port=>Number.isInteger(port)&&port>=1024&&port<=65535;

// The runtime identity of a whole-VM app is its set of admissible launch measurements.
export function snpVmRuntimeId(measurements){
  if(!Array.isArray(measurements)||!measurements.length||measurements.length>16||measurements.some(m=>typeof m!=='string'||!HEX96.test(m))||new Set(measurements).size!==measurements.length)
    throw new Error('whole-VM launch measurements required');
  return createHash('sha256').update('enclave-snp-vm-runtime/1\n'+[...measurements].sort().join('\n')).digest('hex');
}
// -> {appSha256, runtimeId, measurements} from a whole-VM catalog version's config, null for any other version.
// The same reading as the supervisor's launch plan (metal/snpvm-supervisor-patch.py snpVmPlanOf).
export function snpVmExpectation(versionConfig){
  let c;try{c=JSON.parse(versionConfig);}catch{return null;}
  if(c?.runtime!==SNP_VM_RUNTIME)return null;
  const published=c.snp?.measurements,keys=published&&typeof published==='object'?Object.keys(published):[];
  if(keys.length!==1||!/^\d+$/.test(keys[0]))throw new Error('the version must publish its launch measurement for exactly one vCPU count');
  const measurements=[].concat(published[keys[0]]).map(m=>String(m).toLowerCase()).sort(),appSha256=String(c.image?.rootHash||'').toLowerCase();
  if(!HEX64.test(appSha256))throw new Error('the version names no image root hash');
  return {appSha256,runtimeId:snpVmRuntimeId(measurements),measurements};
}
// The front's answer to /.well-known/enclave-attestation?nonce=, judged against the chain's expectation.
// policy: the host's own {minTcb, vcek} (this chip signs its guests' reports), as for its other SNP guests.
export async function verifySnpVmProof(doc,spki,nonce,{deploymentId,expected,minTcb,vcek,kds=false,verify=verifyQuote}){
  if(!/^0x[0-9a-f]{64}$/.test(deploymentId||'')||!expected||snpVmRuntimeId(expected.measurements)!==expected.runtimeId)return {ok:false,reason:'the launch measurements are not the expected runtime'};
  if(minTcb===undefined)return {ok:false,reason:'no minimum-TCB policy'};
  if(typeof doc.report!=='string'||doc.report.length>8192)return {ok:false,reason:'no report'};
  const report=Buffer.from(doc.report,'base64');
  const v=await verify(report,{challenge:nonce,transportKeySpki:spki,allowedMeasurements:expected.measurements,auxblob:vcek?vcekTable(vcek):null,kds,minTcb});
  if(v.ok!==true)return {ok:false,reason:v.reasons?.at(-1)||'report refused'};
  if(v.vcekVerified!==true||v.tcb?.checked!==true)return {ok:false,reason:'the AMD signature chain or the minimum TCB was not verified'};
  // HOST_DATA (offset 0xC0, 32 bytes) lies in the region the signature just verified covers
  if(report.subarray(0xc0,0xe0).toString('hex')!==deploymentId.slice(2))return {ok:false,reason:'HOST_DATA is not this deployment'};
  return {ok:true,measurement:v.measurement};
}
// An expectation that names a whole-VM app is complete or refused: never half of one.
export function validSnpVmExpectation(expected){
  try{return validPort(expected?.snpVm?.port)&&Object.keys(expected.snpVm).join()==='port'&&HEX64.test(expected.appSha256||'')&&snpVmRuntimeId(expected.measurements)===expected.runtimeId;}
  catch{return false;}
}
// The route to a whole-VM app: the loopback port its expectation names. No lookup, no caller-chosen address.
export class SnpVmIngress {
  constructor({expected,connect=net.connect}){this.expected=expected;this.connect=connect;}
  handles(id){return validPort(this.expected(id)?.snpVm?.port);}
  open(id){
    const port=this.expected(id)?.snpVm?.port;
    if(!/^0x[0-9a-f]{64}$/.test(id)||!validPort(port))return Promise.reject(new Error('unknown whole-VM deployment'));
    return new Promise((resolve,reject)=>{
      const socket=this.connect({host:'127.0.0.1',port});
      const timer=setTimeout(()=>socket.destroy(new Error('whole-VM guest connect timeout')),10000);
      socket.once('error',e=>{clearTimeout(timer);reject(e);});
      socket.once('connect',()=>{clearTimeout(timer);socket.on('error',()=>{});resolve(socket);});
    });
  }
  forward=async(socket,id)=>{
    const guest=await this.open(id);if(socket.destroyed){guest.destroy();return;}
    const close=()=>{socket.destroy();guest.destroy();};
    socket.on('error',close);guest.on('error',close);socket.once('close',close);guest.once('close',close);
    socket.pipe(guest).pipe(socket);socket.resume();
  };
}
// What the manager says about where a whole-VM app listens (<stateDir>/<id>.route.json): present only while the VM
// serves a certificate for its app name, and only for the version it was launched as.
export function snpVmRoute(route,{deploymentId,appRef}){
  if(!route||route.deploymentId!==deploymentId||route.appRef!==appRef||!validPort(route.port))return null;
  return {port:route.port};
}
