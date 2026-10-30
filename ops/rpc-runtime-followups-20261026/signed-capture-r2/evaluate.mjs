// Offline-only runner for the frozen r2 candidate. Does not qualify caller roots.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { readBounded, requireOffline, VENDOR_PIN, sourceProvenance } from './runtime.mjs';
import { bindNativeResult, checkCapturePolicy } from './policy.mjs';
const PIN='581d56a6c052f80c49cc8557e6d0c16fe148be8c67939c00c3ece011a2dbadb8';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=m=>{throw Error(m);};
const a=process.argv.slice(2);
if(a.length!==2)fail('usage: evaluate.mjs PINNED_NATIVE_BINARY CAPTURE_DIR (run offline under memory guard)');
await requireOffline();
const [binary,directory]=a.map(x=>path.resolve(x));
const capBytes=await readBounded(path.join(directory,'CAPTURE.json'),128<<10),cap=JSON.parse(capBytes);
if(cap.authority!==false||cap.nativeEvaluated!==false||cap.format!=='enclave-signed-capture-receipt/v1')fail('unexpected capture receipt');
const provenance=cap.provenance;
if(!provenance||provenance.vendorManifestSha256!==VENDOR_PIN||
  !['plan','commitment','bootstrapWitness'].every(k=>/^[a-f0-9]{64}$/.test(provenance.inputSha256?.[k]??'')))fail('missing/mismatched input/source provenance');
const expectedSource=await sourceProvenance();
for(const group of ['stageSourceSha256','dependencySha256'])
  for(const [name,digest] of Object.entries(expectedSource[group]))
    if(provenance[group]?.[name]!==digest)fail('capture source provenance changed');
const inputs={};
for(const [name,limit] of [['context.json',128<<10],['witness.json',128<<20],['envelope.snappy',10<<20]]){
  const b=await readBounded(path.join(directory,name),limit);if(sha(b)!==cap.sha256[name])fail(`capture bytes changed: ${name}`);inputs[name]=b;
}
const context=JSON.parse(inputs['context.json']);checkCapturePolicy(context);
const limiterSha256=sha(await readBounded('/usr/bin/prlimit',1<<20));
const native=await readBounded(binary,512<<20);if(sha(native)!==PIN)fail('native pin mismatch');
const logs=await fs.mkdtemp(path.join(directory,'offline-run-'));await fs.chmod(logs,0o700);
const staging=await fs.mkdtemp(path.join(os.tmpdir(),'signed-native-'));await fs.chmod(staging,0o700);
const stagedBinary=path.join(staging,'native');
try{
  await fs.writeFile(stagedBinary,native,{mode:0o500,flag:'wx'});
  for(const [name,b] of Object.entries(inputs))await fs.writeFile(path.join(staging,name),b,{flag:'wx',mode:0o400});
  const result=await new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/prlimit',['--as=2147483648','--cpu=60','--fsize=16777216',stagedBinary,'--offline-candidate',
      path.join(staging,'context.json'),path.join(staging,'witness.json'),path.join(staging,'envelope.snappy')],
      {env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','pipe']});
    let stdout=[],stderrHead=Buffer.alloc(0),stderrTail=Buffer.alloc(0),outBytes=0,errBytes=0,killed=false;
    const stop=()=>{killed=true;child.kill('SIGKILL');};
    const timer=setTimeout(stop,90000);
    child.stdout.on('data',b=>{outBytes+=b.length;if(outBytes>(16<<20))stop();else stdout.push(b);});
    child.stderr.on('data',b=>{errBytes+=b.length;
      if(stderrHead.length<32768)stderrHead=Buffer.concat([stderrHead,b.subarray(0,32768-stderrHead.length)]);
      stderrTail=Buffer.concat([stderrTail,b]).subarray(-32768);
    });
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,killed,stdout:Buffer.concat(stdout).toString(),stderr:(errBytes<=32768?stderrHead:errBytes<=65536?Buffer.concat([stderrHead,stderrTail.subarray(65536-errBytes)]):Buffer.concat([stderrHead,Buffer.from('\n[stderr truncated; final bytes follow]\n'),stderrTail])).toString(),stderrBytes:errBytes});});
  });
  await fs.writeFile(path.join(logs,'stdout.txt'),result.stdout,{flag:'wx',mode:0o600});
  await fs.writeFile(path.join(logs,'stderr.txt'),result.stderr,{flag:'wx',mode:0o600});
  if(result.killed||result.code!==0)fail(`native refused or exceeded bound: ${result.code}/${result.signal}; see ${logs}`);
  const j=JSON.parse(result.stdout);
  bindNativeResult(j,cap,context);
  await fs.writeFile(path.join(logs,'EVALUATION.json'),JSON.stringify({format:'enclave-candidate-evaluation/v1',
    conditionalTransitionVerified:true,authority:false,qualifiedParentL1:false,branchPolicyQualified:false,
    acceptedImageQualified:false,binarySha256:PIN,captureSha256:sha(capBytes),
    captureProvenance:provenance,limiterSha256,rollupConfigHash:j.rollupConfigHash,scheduleId:j.scheduleId,stderrBytes:result.stderrBytes,
    resultSha256:sha(Buffer.from(result.stdout)),number:cap.number,hash:cap.candidateHash},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({conditionalTransitionVerified:true,authority:false,directory:logs}));
}finally{await fs.rm(staging,{recursive:true,force:true});}
