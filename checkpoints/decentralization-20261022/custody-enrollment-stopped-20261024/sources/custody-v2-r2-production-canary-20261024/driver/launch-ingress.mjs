// Read-only routing proof: pinned forwarder source/config, exact local process/socket, SSH tunnel,
// SSH-authenticated running Caddy config, and strict-TLS raw-target refusal probes. No routing mutation.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {canonical,sha256hex} from './canonical.mjs';
import {digestFile} from './launch-bundle.mjs';
import {linuxRuntimeIO} from './launch-runtime.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
export const INGRESS_SOURCE=Object.freeze({commit:'5f364d4f9bd387370e79690df6d622e402d36645',files:{'forwarder.mjs':'f22aec697118908c49070119dd4ebfebca4f7763dfe5fe728450b10d469bd97a','origin-config.mjs':'5ea3050803859b8c5360f97a1ea16a5e0e578dc843e72bbc7d7d3792c6202adb'}});
export const CONTROL=Object.freeze({host:'controladmin@127.0.0.1',port:'32423',key:'/home/steven/.ssh/minipc',knownHosts:'/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts'});
const need=(x,m)=>{if(!x)throw Error('canary ingress refused: '+m);};
const hash=v=>sha256hex(canonical(v));
export function controlSshArgs(){return ['-F','/dev/null','-p',CONTROL.port,'-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+CONTROL.knownHosts,'-i',CONTROL.key];}
export function tunnelArgs(reverse){return [...controlSshArgs(),'-NT','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-R',reverse,CONTROL.host];}
export function rawTlsRefusal(endpoint,method,target,{request=https.request}={}) {
 const u=new URL(endpoint);need(u.origin===endpoint&&u.protocol==='https:'&&!u.port&&!u.username&&!u.password,'exact TLS origin required');
 return new Promise((resolve,reject)=>{
  let settled=false,q,timer;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);q?.destroy();error?reject(Error('canary ingress refused: strict TLS route probe failed')):resolve(result);};
  try {
   q=request({hostname:u.hostname,port:443,servername:u.hostname,rejectUnauthorized:true,method,path:target,agent:false,
    headers:{connection:'close',...(method==='GET'?{}:{'content-type':'application/json','content-length':2})}},r=>{
     const status=r.statusCode;r.destroy();finish(null,{method,target,status});
    });
   if(settled){q.destroy();return;}
   timer=setTimeout(()=>finish(true),8000);q.on('error',()=>finish(true));q.end(method==='GET'?undefined:'{}');
  } catch { finish(true); }
 });
}
export const REFUSAL_PROBES=Object.freeze([
 ['GET','/'],['GET','/health'],['GET','/state'],['PUT','/state'],['POST','/submit'],['POST','/v2/custody/host-binding'],
 ['POST','/v2/custody/info'],['GET','/v2/custody/challenge'],['POST','/v2/custody/challenge/../host-binding'],
 ['POST','/v2/custody/challenge/%2e%2e/host-binding'],['POST','/v2/custody/info/..\\host-binding'],
 ['POST','/v2/custody/%68ost-binding'],['POST','/v2/custody/challenge?x=1']]);
export async function checkPublicRefusals(endpoint,probe=rawTlsRefusal){
 const observations=[];for(const [m,p] of REFUSAL_PROBES){const r=await probe(endpoint,m,p);need(r.method===m&&r.target===p&&r.status===404,'private or ambiguous route did not return404');observations.push({method:m,path:p,status:r.status});}
 return observations;
}
export function readControlIngress(compiled,{exec=execFileSync,now=()=>Date.now()}={}) {
 const script=fs.readFileSync(path.join(HERE,'inspect-caddy.py'),'utf8');
 const input=Buffer.from(JSON.stringify({hostname:new URL(compiled.endpoint).hostname,tunnelPort:compiled.tunnelPort,caddy:compiled.caddy})).toString('base64');
 let result;
 try{result=JSON.parse(exec('/usr/bin/ssh',[...controlSshArgs(),CONTROL.host,'python3 -'],{input:script+`\nimport base64\nmain(json.loads(base64.b64decode('${input}')))\n`,encoding:'utf8',timeout:30000,maxBuffer:16384,stdio:['pipe','pipe','pipe']}));}
 catch{throw Error('canary ingress refused: SSH-authenticated running route unavailable');}
 need(result.ok===true&&result.hostname===new URL(compiled.endpoint).hostname&&result.tunnelPort===compiled.tunnelPort&&result.loopbackListener===true&&/^[a-f0-9]{64}$/.test(result.routeSha256??'')
  &&Number.isSafeInteger(result.at)&&result.at<=now()+5000&&result.at>=now()-30000,'remote runtime route evidence differs or expired');
 return result;
}
export async function compileIngress(pins){
 const p=pins.ingress;need(p&&path.isAbsolute(p.repo)&&fs.realpathSync(p.repo)===p.repo,'pinned ingress repo required');
 try{need(execFileSync('git',['-C',p.repo,'rev-parse','HEAD'],{encoding:'utf8',timeout:10000}).trim()===INGRESS_SOURCE.commit,'ingress commit differs');
 need(!execFileSync('git',['-C',p.repo,'status','--porcelain','--untracked-files=no'],{encoding:'utf8',timeout:10000}).trim(),'ingress source has tracked changes');}catch{throw Error('canary ingress refused: source revision unavailable or changed');}
 for(const [rel,sha] of Object.entries(INGRESS_SOURCE.files))need(digestFile(path.join(p.repo,rel),262144)===sha,'ingress source hash differs');
 const {compileOriginIngress}=await import(pathToFileURL(path.join(p.repo,'origin-config.mjs')).href);
 const compiled=compileOriginIngress({endpoint:pins.custodian.endpoint,listenPort:p.listenPort,upstreamPort:pins.launch.mgmtPort,tunnelPort:p.tunnelPort});
 need(![p.listenPort,p.tunnelPort].includes(pins.launch.hostPort),'ingress collides with private state port');
 need(/^[a-f0-9]{64}$/.test(p.knownHostsSha256??'')&&digestFile(CONTROL.knownHosts,1048576)===p.knownHostsSha256,'SSH host pin differs');
 need(path.isAbsolute(p.configFile)&&fs.realpathSync(p.configFile)===p.configFile,'absolute ingress config required');
 const st=fs.statSync(p.configFile);need(st.isFile()&&st.uid===process.getuid()&&(st.mode&0o777)===0o600&&st.size<16384,'private ingress config required');
 need(hash(JSON.parse(fs.readFileSync(p.configFile,'utf8')))===hash(compiled.forwarder),'forwarder config differs');
 return {...compiled,tunnelPort:p.tunnelPort,node:fs.realpathSync(process.execPath),ssh:fs.realpathSync('/usr/bin/ssh'),sourceFile:path.join(p.repo,'forwarder.mjs'),configFile:p.configFile};
}
export async function inspectIngress({pins,io=linuxRuntimeIO(),compile=compileIngress,remote=readControlIngress,probe=rawTlsRefusal,probePublic=true}) {
 const started=io.now(),c=await compile(pins);need(/^\d{8}T\d{6}Z$/.test(pins.runLabel),'timestamped run required');
 const check=(kind,exe,args,cap)=>{
  const name=`enclave-custody-r2-${kind}-${pins.runLabel}.service`,u=io.unit(name);
  need(u.ActiveState==='active'&&u.SubState==='running'&&u.LoadState==='loaded'&&u.KillMode==='control-group'&&u.MemoryMax===String(cap*1024*1024)&&u.MemorySwapMax==='0'&&u.Restart==='no'
   &&u.ControlGroup.endsWith('/'+name)&&/^[a-f0-9]{32}$/.test(u.InvocationID??''),'ingress unit identity or limits differ');
  const pid=Number(u.MainPID),p=io.process(pid);need(p.uid===process.getuid()&&p.exe===exe&&p.cgroup==='0::'+u.ControlGroup&&hash(io.args(pid))===hash([exe,...args])&&hash(io.env(pid))===hash(['PATH=/usr/bin:/bin']),'ingress process differs');
  const cg=io.cgroup(u.ControlGroup);need(cg.memoryMax===String(cap*1024*1024)&&cg.swapMax==='0'&&hash(cg.pids)===hash([pid])&&cg.events.oom==='0'&&cg.events.oom_kill==='0','ingress kernel cgroup differs');
  return {unit:name,invocation:u.InvocationID,process:p};
 };
 const forward=check('ingress',c.node,[c.sourceFile,c.configFile],256),tunnel=check('tunnel',c.ssh,tunnelArgs(c.reverseForward),128);
 const hits=io.listeners().filter(l=>l.port===c.forwarder.listen.port);need(hits.length===1&&hits[0].kind==='tcp'&&hits[0].addr==='0100007F'&&io.sockets(forward.process.pid).has(hits[0].inode),'forwarder listener owner or binding differs');
 const control=await remote(c),refusals=probePublic?await checkPublicRefusals(c.endpoint,probe):null;
 const controlAfter=await remote(c);need(control.routeSha256===controlAfter.routeSha256,'running route changed during collection');
 const forwardAfter=check('ingress',c.node,[c.sourceFile,c.configFile],256),tunnelAfter=check('tunnel',c.ssh,tunnelArgs(c.reverseForward),128);
 need(hash(forwardAfter)===hash(forward)&&hash(tunnelAfter)===hash(tunnel),'ingress resources changed during collection');
 const endHits=io.listeners().filter(l=>l.port===c.forwarder.listen.port);need(hash(endHits)===hash(hits)&&io.sockets(forward.process.pid).has(hits[0].inode),'forwarder listener changed during collection');
 need(hash(io.process(forward.process.pid))===hash(forward.process)&&hash(io.process(tunnel.process.pid))===hash(tunnel.process)
  &&io.unit(forward.unit).InvocationID===forward.invocation&&io.unit(tunnel.unit).InvocationID===tunnel.invocation,'ingress process changed during collection');
 need(io.now()-started<=120000,'ingress collection expired');
 const binding={endpoint:c.endpoint,source:INGRESS_SOURCE,configSha256:hash(c.forwarder),caddyRouteSha256:control.routeSha256,forward,tunnel};
 return {at:io.now(),bindingDigest:hash(binding),endpoint:c.endpoint,forwarderUnit:forward.unit,tunnelUnit:tunnel.unit,sourceCommit:INGRESS_SOURCE.commit,
  routeSha256:control.routeSha256,refusals,scope:'Temporary control-VM Caddy and SSH ingress proven for the canary; centralized availability dependency remains.'};
}
