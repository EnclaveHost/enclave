// A whole-VM app: a catalog version whose runtime is "sev-snp-vm", leased with the snpVm deployment option. The lease
// is one SEV-SNP VM that the host's VM manager (rpc/snp/vm-manager.mjs) launches from the version's measured image,
// and the VM's own front terminates TLS on a key that never leaves it. So the agent admits it on a fresh report from
// that front and routes the app's names to the VM's loopback port, byte for byte.
//
// What the agent expects comes from the chain: the image and launch measurements of the lease's catalog version.
// The manager is asked only where the VM listens. A report is accepted when AMD signed it, its launch measurement is
// one the version lists, HOST_DATA names this deployment, and report_data binds the key this connection presented
// to the nonce just sent.
//
// One image, a launch identity per platform (isolation/vmboot). A whole-VM version names ONE root image
// (image.rootHash) and, for each platform it may be booted on, what that platform's report says of a boot of it:
//   snp.measurements     {"<vCPUs>": "<96 hex>" | [..]}   the SEV-SNP launch measurement, per vCPU count
//   shield.launch        [{bootDigest: "<64 hex>", guestSvn: n, identity?: {signer, productId, moduleId}}]
//                        the Enclave Shield boot image's launch digest (the paravisor's report calls it the
//                        measurement), the image's guest SVN, and its signer when the boot image is signed
// A version lists one platform or both, and a host of a platform takes it only if its platform is listed. The runtime
// name is the whole-VM runtime's historical one on either platform. The Shield report is judged in shield-vm-app.mjs.
import net from 'node:net';
import {createHash} from 'node:crypto';
import {verifyQuote,seedCertChain} from '../relay/snp-verify.mjs';
import {vcekTable} from '../isolation/m2/judge.mjs';
import {validImageIdentity} from '../relay/vbs-image-identity.mjs';

export const SNP_VM_RUNTIME='sev-snp-vm',SNP_VM_FORMAT='sev-snp-vm-v1';
const HEX64=/^[0-9a-f]{64}$/,HEX96=/^[0-9a-f]{96}$/;
const validPort=port=>Number.isInteger(port)&&port>=1024&&port<=65535;

// Reports are judged offline (kds:false), so this module's verifier needs the AMD chain the host already holds. A host
// that names its own verifier module for its other guests seeds that copy; this one is seeded here.
export const seedSnpVmCertChain=seedCertChain;
// The runtime identity of a whole-VM app is its set of admissible launch measurements.
export function snpVmRuntimeId(measurements){
  if(!Array.isArray(measurements)||!measurements.length||measurements.length>16||measurements.some(m=>typeof m!=='string'||!HEX96.test(m))||new Set(measurements).size!==measurements.length)
    throw new Error('whole-VM launch measurements required');
  return createHash('sha256').update('enclave-snp-vm-runtime/1\n'+[...measurements].sort().join('\n')).digest('hex');
}
// A version's Enclave Shield launch identities, as its config and an expectation carry them: 1 to 16, each boot digest
// once, no field this reader does not know.
export function validShieldLaunch(launch){
  return Array.isArray(launch)&&launch.length>=1&&launch.length<=16&&launch.every(e=>e&&typeof e==='object'&&!Array.isArray(e)&&
    Object.keys(e).every(k=>k==='bootDigest'||k==='guestSvn'||k==='identity')&&typeof e.bootDigest==='string'&&HEX64.test(e.bootDigest)&&
    Number.isSafeInteger(e.guestSvn)&&e.guestSvn>=0&&e.guestSvn<=0xffffffff&&(e.identity===undefined||validImageIdentity(e.identity)))&&
    new Set(launch.map(e=>e.bootDigest)).size===launch.length;
}
// The runtime identity of a whole-VM app over every platform its version lists. With SEV-SNP alone it is
// snpVmRuntimeId, so nothing a host or a client holds for today's versions changes.
export function wholeVmRuntimeId({measurements=[],shield}={}){
  if(shield===undefined)return snpVmRuntimeId(measurements);
  if(!validShieldLaunch(shield))throw new Error('whole-VM Shield launch identities required');
  if(!Array.isArray(measurements)||measurements.length>16||measurements.some(m=>typeof m!=='string'||!HEX96.test(m))||new Set(measurements).size!==measurements.length)
    throw new Error('whole-VM launch measurements required');
  const line=e=>[e.bootDigest,e.guestSvn,...(e.identity?[e.identity.signer,e.identity.productId,e.identity.moduleId]:[])].join(':');
  return createHash('sha256').update('enclave-vm-runtime/2\nsev-snp\n'+[...measurements].sort().join('\n')+'\nshield\n'+shield.map(line).sort().join('\n')).digest('hex');
}
// -> {appSha256, runtimeId, measurements[, shield]} from a whole-VM catalog version's config, null for any other version.
// The same reading as the supervisor's launch plan (metal/snpvm-supervisor-patch.py snpVmPlanOf), except for the size:
// a version may publish a measurement per vCPU count, the deployment's option picks one, and every one of them is a
// launch of this version's image. The agent admits any of them; which size the owner is given is the lease's matter.
export function snpVmExpectation(versionConfig){
  let c;try{c=JSON.parse(versionConfig);}catch{return null;}
  if(c?.runtime!==SNP_VM_RUNTIME)return null;
  // a platform section that is present is complete or the version is refused; a version with no Shield section must
  // have the SEV-SNP one, as before
  const listsShield=c.shield!==undefined,shield=listsShield?c.shield?.launch:undefined,snp=c.snp!==undefined||!listsShield;
  if(listsShield&&(!c.shield||typeof c.shield!=='object'||Array.isArray(c.shield)||Object.keys(c.shield).join()!=='launch'||!validShieldLaunch(shield)))throw new Error('the version must publish its Enclave Shield launch identities (1 to 16 boot digests, each with a guest SVN)');
  const published=c.snp?.measurements,keys=published&&typeof published==='object'&&!Array.isArray(published)?Object.keys(published):[];
  if(snp&&(!keys.length||keys.length>16||keys.some(k=>!/^[1-9]\d{0,2}$/.test(k))))throw new Error('the version must publish its launch measurements by vCPU count (1 to 16 sizes)');
  const measurements=keys.flatMap(k=>[].concat(published[k])).map(m=>String(m).toLowerCase()).sort(),appSha256=String(c.image?.rootHash||'').toLowerCase();
  if(!HEX64.test(appSha256))throw new Error('the version names no image root hash');
  if(snp)snpVmRuntimeId(measurements);   // refuses a malformed or repeated measurement whatever else the version lists
  return {appSha256,runtimeId:wholeVmRuntimeId({measurements,shield}),measurements,...(shield?{shield}:{})};
}
// The front's answer to /.well-known/enclave-attestation?nonce=, judged against the chain's expectation.
// policy: the host's own {minTcb, vcek} (this chip signs its guests' reports), as for its other SNP guests.
export async function verifySnpVmProof(doc,spki,nonce,{deploymentId,expected,minTcb,vcek,kds=false,verify=verifyQuote}){
  try{if(!/^0x[0-9a-f]{64}$/.test(deploymentId||'')||!expected||wholeVmRuntimeId(expected)!==expected.runtimeId)return {ok:false,reason:'the launch measurements are not the expected runtime'};}
  catch{return {ok:false,reason:'the launch measurements are not the expected runtime'};}
  // a version that lists no SEV-SNP measurement has no SEV-SNP boot: an empty list admits nothing
  if(!Array.isArray(expected.measurements)||!expected.measurements.length)return {ok:false,reason:'the version publishes no SEV-SNP launch measurement'};
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
  try{return validPort(expected?.snpVm?.port)&&Object.keys(expected.snpVm).join()==='port'&&HEX64.test(expected.appSha256||'')&&wholeVmRuntimeId(expected)===expected.runtimeId;}
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
