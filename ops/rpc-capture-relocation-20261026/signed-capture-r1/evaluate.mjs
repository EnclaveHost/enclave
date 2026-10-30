// Offline-only runner for the frozen r2 candidate. Does not qualify caller roots.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
const PIN='581d56a6c052f80c49cc8557e6d0c16fe148be8c67939c00c3ece011a2dbadb8';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=m=>{throw Error(m);};
async function readBounded(file,max){
  const f=await fs.open(file,'r');try{
    const st=await f.stat();if(!st.isFile()||st.size>max)fail('file type/size bound');
    const parts=[];let n=0;
    while(true){const b=Buffer.alloc(Math.min(65536,max+1-n));const r=await f.read(b,0,b.length,null);
      if(!r.bytesRead)break;n+=r.bytesRead;if(n>max)fail('file grew beyond bound');parts.push(b.subarray(0,r.bytesRead));}
    return Buffer.concat(parts);
  }finally{await f.close();}
}
const a=process.argv.slice(2);
if(a.length!==2)fail('usage: evaluate.mjs PINNED_NATIVE_BINARY CAPTURE_DIR (run offline under memory guard)');
const [binary,directory]=a.map(x=>path.resolve(x));
const capBytes=await readBounded(path.join(directory,'CAPTURE.json'),128<<10),cap=JSON.parse(capBytes);
if(cap.authority!==false||cap.nativeEvaluated!==false||cap.format!=='enclave-signed-capture-receipt/v1')fail('unexpected capture receipt');
const inputs={};
for(const [name,limit] of [['context.json',128<<10],['witness.json',128<<20],['envelope.snappy',10<<20]]){
  const b=await readBounded(path.join(directory,name),limit);if(sha(b)!==cap.sha256[name])fail(`capture bytes changed: ${name}`);inputs[name]=b;
}
const native=await readBounded(binary,512<<20);if(sha(native)!==PIN)fail('native pin mismatch');
const staging=await fs.mkdtemp(path.join(directory,'offline-run-'));await fs.chmod(staging,0o700);
const stagedBinary=path.join(staging,'native');await fs.writeFile(stagedBinary,native,{mode:0o500,flag:'wx'});
try{
  for(const [name,b] of Object.entries(inputs))await fs.writeFile(path.join(staging,name),b,{flag:'wx',mode:0o400});
  const result=await new Promise((resolve,reject)=>{
    const child=spawn('prlimit',['--as=2147483648','--cpu=60','--fsize=16777216',stagedBinary,'--offline-candidate',
      path.join(staging,'context.json'),path.join(staging,'witness.json'),path.join(staging,'envelope.snappy')],
      {env:{PATH:process.env.PATH,LANG:'C'},stdio:['ignore','pipe','pipe']});
    let stdout=[],stderr=[],outBytes=0,errBytes=0,killed=false;
    const stop=()=>{killed=true;child.kill('SIGKILL');};
    const timer=setTimeout(stop,90000);
    child.stdout.on('data',b=>{outBytes+=b.length;if(outBytes>(16<<20))stop();else stdout.push(b);});
    child.stderr.on('data',b=>{errBytes+=b.length;if(errBytes>65536)stop();else stderr.push(b);});
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,killed,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()});});
  });
  await fs.writeFile(path.join(staging,'stdout.txt'),result.stdout,{flag:'wx',mode:0o600});
  await fs.writeFile(path.join(staging,'stderr.txt'),result.stderr,{flag:'wx',mode:0o600});
  if(result.killed||result.code!==0)fail(`native refused or exceeded bound: ${result.code}/${result.signal}; see ${staging}`);
  const j=JSON.parse(result.stdout);
  if(j.format!=='enclave-signed-payload-candidate/v1'||j.authority!==false||j.refused||j.hash!==cap.candidateHash||
    j.parentHash!==cap.parentHash||j.outputRoot!==cap.outputRoot||j.coverage?.toBlock!==cap.number||j.coverage?.blocks?.length!==1)fail('native result does not bind captured candidate');
  await fs.writeFile(path.join(staging,'EVALUATION.json'),JSON.stringify({format:'enclave-candidate-evaluation/v1',
    conditionalTransitionVerified:true,authority:false,qualifiedParentL1:false,branchPolicyQualified:false,
    acceptedImageQualified:false,binarySha256:PIN,captureSha256:sha(capBytes),
    resultSha256:sha(Buffer.from(result.stdout)),number:cap.number,hash:cap.candidateHash},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({conditionalTransitionVerified:true,authority:false,directory:staging}));
}finally{await fs.unlink(stagedBinary);}
