import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {performance} from 'node:perf_hooks';
const runReference=(binary,input,timeoutMs)=>new Promise((resolve,reject)=>{
 const p=execFile(binary,[],{timeout:timeoutMs,maxBuffer:65536},(error,stdout)=>{
  if(error)return reject(new Error('reference execution failed'));
  try{resolve(JSON.parse(stdout));}catch{reject(new Error('invalid reference result'));}
 });p.stdin.end(JSON.stringify(input));
});
/** requestVerified MUST bind the live app handshake, catalog artifact, deployment
 * and expected host under the configured isolation policy. Never replace this
 * with an unverified fetch or a successful WebPKI certificate check alone.
 */
export function createCpuWorkload({referenceBinary,requestVerified,rounds,memoryMiB,passes,timeoutMs,referenceMemoryBudgetMiB=128}) {
 if(typeof requestVerified!=='function'||!Number.isInteger(rounds)||rounds<1||rounds>2_000_000
  ||!Number.isInteger(memoryMiB)||memoryMiB<0||memoryMiB>2048||!Number.isInteger(passes)||passes<1||passes>8
  ||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new Error('invalid workload');
 if(!Number.isInteger(referenceMemoryBudgetMiB)||referenceMemoryBudgetMiB<0||memoryMiB>referenceMemoryBudgetMiB)throw new Error('reference memory budget exceeded');
 let referenceQueue=Promise.resolve();
 return {async runAndVerify(job) {
  const input={seed:randomBytes(32).toString('hex'),rounds,memory_mib:memoryMiB,passes};
  // Compute before timing the host so verifier CPU pressure is not charged as
  // host slowness. The seed stays private until the request starts.
  const pending=referenceQueue.then(()=>runReference(referenceBinary,input,timeoutMs));
  referenceQueue=pending.catch(()=>{});
  const expected=await pending;
  if(BigInt(Math.ceil(timeoutMs/1000))>BigInt(job.offer.durationSec) ||
    BigInt(job.lease.leaseUntil)*1000n<=BigInt(Date.now()+timeoutMs))throw new Error('insufficient paid lease for challenge');
  const start=performance.now();
  const actual=await requestVerified(job,{method:'POST',path:'/v1/run',body:input,
   headers:{authorization:`Bearer ${job.token}`},timeoutMs});
  const elapsedMs=performance.now()-start;
  if(actual.attestationVerified!==true||actual.hostId!==job.offer.hostId||actual.deploymentId!==job.deployment.id)
   throw new Error('unbound execution evidence');
  for(const k of ['digest','rounds','memory_bytes','passes'])
   if(actual.body?.[k]!==expected[k])throw new Error(`incorrect result: ${k}`);
  if(elapsedMs>timeoutMs)throw new Error('deadline exceeded');
  return {verified:true,profile:'cpu-ram/1',elapsedMs,expected,input,evidence:actual.evidence,
   scope:'measured CPU/RAM work only; no GPU or exclusive physical-capacity claim'};
 }};
}
