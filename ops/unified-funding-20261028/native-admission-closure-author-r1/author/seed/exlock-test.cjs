'use strict';
// SOURCE-ONLY TEST proposal; never a production journal. Parent plus ONE child.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const EX=0x10000000, LIMIT=256*1024*1024, root='C:\\Windows\\Temp', payload=Buffer.from('enclave-exlock-disposable-test-v1\n'.repeat(4));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let dir=null,token=null,child=null,fd=null,peak=0,timedOut=false,cleaned=false;
const events=[];const report={schema:'enclave-exlock-qualification/1',qualified:false,events};
function safePath(p){for(let x=path.resolve(p);;x=path.dirname(x)){if(fs.lstatSync(x).isSymbolicLink())throw Error('reparse/symlink refused');if(path.dirname(x)===x)break;}}
function checkOwned(){safePath(dir);if(!path.basename(dir).startsWith('enclave-exlock-test-')||path.dirname(dir)!==root||fs.readFileSync(path.join(dir,'owner'),'utf8')!==token)throw Error('ownership check failed');}
function attempt(name,fn,want){let ok=false,code=null;try{fn();ok=true}catch(e){code=e.code||e.name}events.push({name,ok,code,expected:want});return want==='success'?ok:!ok;}
function mem(rss=0){const n=process.memoryUsage().rss+rss;peak=Math.max(peak,n);if(n>LIMIT){child?.kill();throw Error('aggregate RSS exceeded 256MiB; test refused');}}
const childSource=String.raw`
const fs=require('node:fs'),p=require('node:path');
const [mode,dir,token]=process.argv.slice(1), file=p.join(dir,'journal');
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const timer=setTimeout(()=>process.exit(124),2500);
if(fs.readFileSync(p.join(dir,'owner'),'utf8')!==token)throw Error('owner mismatch');
const sample=setInterval(()=>send({rss:process.memoryUsage().rss}),100);sample.unref();
send({rss:process.memoryUsage().rss});
if(mode==='hold'){
 const fd=fs.openSync(file,fs.constants.O_RDWR|0x10000000);send({holding:true});
 setTimeout(()=>process.exit(0),800); // kernel closes fd on process exit: no explicit close
}else{
 const actions=[['cross-process-shared-open',()=>{let x=fs.openSync(file,'r+');fs.closeSync(x)}],['cross-process-exclusive-open',()=>{let x=fs.openSync(file,fs.constants.O_RDWR|0x10000000);fs.closeSync(x)}],['cross-process-rename',()=>fs.renameSync(file,p.join(dir,'renamed'))],['cross-process-delete',()=>fs.unlinkSync(file)]];
 for(const [name,fn]of actions){try{fn();send({name,ok:true,code:null})}catch(e){send({name,ok:false,code:e.code||e.name})}}
 clearTimeout(timer);send({done:true});process.exit(0);
}`;
function run(mode,onRow=()=>{}){return new Promise((resolve,reject)=>{
 if(child)throw Error('child overlap refused');
 const c=cp.spawn(process.execPath,['--max-old-space-size=16','--max-semi-space-size=1','--input-type=commonjs','-e',childSource,mode,dir,token],{stdio:['ignore','pipe','pipe'],windowsHide:true});child=c;
 let out='',errBytes=0,failed=null;const rows=[];
 const timer=setTimeout(()=>{failed=Error('owned child timeout');c.kill()},3500);
 const fail=e=>{failed??=e;c.kill()};
 c.stdout.on('data',b=>{out+=b;if(out.length>8192)return fail(Error('child output limit'));let nl;while((nl=out.indexOf('\n'))>=0){const line=out.slice(0,nl);out=out.slice(nl+1);try{const row=JSON.parse(line);if(row.rss)mem(row.rss);else{rows.push(row);onRow(row)}}catch(e){fail(e)}}});
 c.stderr.on('data',b=>{errBytes+=b.length;if(errBytes>4096)fail(Error('child stderr limit'))});c.on('error',fail);
 c.on('close',(code)=>{clearTimeout(timer);child=null;if(failed||code!==0||errBytes)reject(failed||Error('child failed, output withheld'));else resolve(rows)});
});}
async function main(){
 if(process.platform!=='win32')throw Error('Windows only');safePath(root);mem();
 dir=fs.mkdtempSync(path.join(root,'enclave-exlock-test-'));token=crypto.randomBytes(16).toString('hex');
 fs.writeFileSync(path.join(dir,'owner'),token,{flag:'wx'});checkOwned();
 const file=path.join(dir,'journal');fs.writeFileSync(file,payload,{flag:'wx'});
 report.node=process.version;report.executable=process.execPath;report.flags=EX;report.tempDir=dir;report.originalSha256=sha(payload);
 fd=fs.openSync(file,fs.constants.O_RDWR|EX);
 const rows=await run('probe');events.push(...rows.filter(x=>x.name));
 const buf=Buffer.alloc(payload.length);const n=fs.readSync(fd,buf,0,buf.length,0);report.heldBytesPreserved=n===payload.length&&sha(buf)===sha(payload);
 fs.closeSync(fd);fd=null;
 report.reopenAfterClose=attempt('positive-reopen-after-close',()=>{const f=fs.openSync(file,fs.constants.O_RDWR|EX);try{if(sha(fs.readFileSync(f))!==sha(payload))throw Error('bytes changed')}finally{fs.closeSync(f)}},'success');
 let during=false;
 await run('hold',r=>{if(r.holding)during=attempt('parent-open-while-child-holds',()=>{const f=fs.openSync(file,'r+');fs.closeSync(f)},'failure')});
 report.reopenAfterExit=attempt('positive-reopen-after-child-exit',()=>{const f=fs.openSync(file,fs.constants.O_RDWR|EX);try{if(sha(fs.readFileSync(f))!==sha(payload))throw Error('bytes changed')}finally{fs.closeSync(f)}},'success');
 const blocked=rows.filter(x=>x.name);report.qualified=blocked.length===4&&blocked.every(x=>!x.ok)&&report.heldBytesPreserved&&report.reopenAfterClose&&during&&report.reopenAfterExit;
 report.scope='runtime-specific cross-process exclusion only; not Windows crash durability, ACL security, authority, guard, or migration proof';
}
const deadline=setTimeout(()=>{timedOut=true;child?.kill();},19000);
main().catch(e=>{report.error=e.message;report.qualified=false}).finally(()=>{
 clearTimeout(deadline);try{if(fd!==null)fs.closeSync(fd)}catch{};
 if(child){child.kill();report.error='owned child remains; cleanup withheld';report.qualified=false;}
 else if(dir)try{checkOwned();const names=fs.readdirSync(dir);if(names.some(n=>!['owner','journal','renamed'].includes(n)))throw Error('unexpected file; cleanup withheld');for(const n of names){const f=path.join(dir,n),s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('nonregular owned file; cleanup withheld')}for(const n of names)fs.unlinkSync(path.join(dir,n));fs.rmdirSync(dir);cleaned=true}catch(e){report.cleanupError=e.message;report.qualified=false}
 report.cleaned=cleaned;report.timedOut=timedOut;report.peakAggregateRss=peak;if(timedOut||!cleaned)report.qualified=false;
 console.log(JSON.stringify(report));process.exitCode=report.qualified?0:1;
});
