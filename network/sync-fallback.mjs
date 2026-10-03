// Give every privacy-routed app, on every host, a warm fallback route on the fleet's own TUNA provider.
//
//   node sync-fallback.mjs --provider FILE --allocations FILE --linux-config FILE
//        --windows-host SSH_HOST --windows-agent-dir C:\... --fallback-host SSH_HOST [--dry-run]
//
// --provider is {"identity": "<64 hex>", "address": "<public IP>"}: the provider that serves every app's fallback.
// One public IP holds one allocation of a TCP port, so each app gets its own pair of ports there (provisionFallback,
// stable across runs and never reassigned), and HAProxy on the provider answers :443 and :80 by hostname: TLS is
// passed through to the app's own tunnel by SNI and never terminated there (no certificates or keys on that host).
// Each run reads both agents' app lists, writes any missing or changed publicFallback into each agent's config
// (the agents reload on SIGHUP / config mtime), and installs the matching HAProxy configuration when it differs
// (validated first; the service is reloaded, or started once the port is free).
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {provisionFallback,fallbackAppsForHosts} from './provider/fallback-config.mjs';
const run=promisify(execFile);

const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const DRY=process.argv.includes('--dry-run');
const providerFile=arg('--provider'),allocationsFile=arg('--allocations'),linuxConfig=arg('--linux-config');
const winHost=arg('--windows-host'),winDir=arg('--windows-agent-dir'),fallbackHost=arg('--fallback-host');
if(!providerFile||!allocationsFile||!linuxConfig||!winHost||!winDir||!fallbackHost||!/^[A-Z]:\\[^'"\r\n]+$/.test(winDir))
  throw new Error('usage: --provider --allocations --linux-config --windows-host --windows-agent-dir C:\\... --fallback-host [--dry-run]');
const log=m=>console.log(`[sync-fallback] ${m}`);
const readJSON=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const writeAtomic=async(f,text,mode=0o600)=>{const t=f+'.tmp-'+process.pid;await fs.writeFile(t,text,{mode});await fs.rename(t,f);};
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);

// PowerShell on the Windows host; data on stdin, the answer between @@ markers (see reconcile-shield-apps.mjs).
function ps(script,input=''){
  const body="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$a='"+winDir+"';"+
    "$in=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()));"+script+
    ";[Console]::Out.Write('@@'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($out))+'@@')";
  const child=execFile('ssh',['-o','LogLevel=ERROR','-o','BatchMode=yes','-o','ConnectTimeout=20',winHost,'powershell','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(body,'utf16le').toString('base64')],{timeout:120000,maxBuffer:16<<20});
  const done=new Promise((resolve,reject)=>{let o='',e='';child.stdout.on('data',d=>o+=d);child.stderr.on('data',d=>e+=d);
    child.on('error',reject);child.on('close',code=>{const m=o.match(/@@([A-Za-z0-9+/=]*)@@/);
      if(code!==0||!m)reject(new Error(`${winHost}: exit ${code} ${(e.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')).slice(-300)}`));else resolve(Buffer.from(m[1],'base64').toString('utf8'));});});
  child.stdin.end(Buffer.from(input||'-').toString('base64'));
  return done;
}
// A command on the fallback provider, its input on stdin.
async function remote(command,input){
  const child=execFile('ssh',['-o','LogLevel=ERROR','-o','BatchMode=yes','-o','ConnectTimeout=20',fallbackHost,command],{timeout:120000,maxBuffer:4<<20});
  const done=new Promise((resolve,reject)=>{let o='',e='';child.stdout.on('data',d=>o+=d);child.stderr.on('data',d=>e+=d);child.on('error',reject);
    child.on('close',code=>code===0?resolve(o):reject(Object.assign(new Error(`${fallbackHost}: exit ${code}: ${e.trim().slice(-400)}`),{code})));});
  child.stdin.end(input??'');
  return done;
}

const provider=await readJSON(providerFile);
const allocations=await readJSON(allocationsFile).catch(e=>{if(e.code==='ENOENT')return {};throw e;});
const linux=await readJSON(linuxConfig);
const windows=JSON.parse(await ps("$out=[IO.File]::ReadAllText(\"$a\\privacy-config.json\")"));
if(linux.version!==2||windows.version!==2||!Array.isArray(linux.apps)||!Array.isArray(windows.apps))throw new Error('version 2 agent configurations required');

// One plan across both hosts: ports and hostnames must not collide anywhere on the provider.
const hosts=[{name:'linux',cfg:linux},{name:'windows',cfg:windows}];
const plan=provisionFallback({provider,apps:fallbackAppsForHosts(hosts.map(h=>h.cfg.apps)),allocations});
const byId=new Map(plan.apps.map(a=>[a.deploymentId,a.publicFallback]));
for(const h of hosts){
  h.changed=0;
  for(const app of h.cfg.apps){const f=byId.get(app.deploymentId);if(!same(app.publicFallback,f)){app.publicFallback=f;h.changed++;}}
}
// HAProxy: install a differing configuration only after it validates; reload a running frontend, or start it once
// :443/:80 are free (a TUNA allocation that still holds them is released when its app moves to its fallback ports).
const current=await remote('cat /etc/tuna-provider/haproxy.cfg 2>/dev/null || true');
// Validate before changing either agent, including during dry runs.
await remote('/usr/sbin/haproxy -c -q -f /dev/stdin',plan.haproxy);
if(current!==plan.haproxy){
  log(`haproxy: configuration for ${plan.apps.length} apps differs; installing`);
  if(!DRY)await remote('set -e; f=/etc/tuna-provider/haproxy.cfg; cat > $f.next; /usr/sbin/haproxy -c -q -f $f.next; '+
    'if [ -f $f ]; then cp -p $f $f.prev; fi; mv $f.next $f; chmod 0644 $f',plan.haproxy);
}

if(!same(plan.allocations,allocations)){log(`allocations: ${Object.keys(plan.allocations).length} apps`);if(!DRY)await writeAtomic(allocationsFile,JSON.stringify(plan.allocations,null,2));}
if(hosts[0].changed){
  log(`linux: ${hosts[0].changed} app(s) given their fallback`);
  if(!DRY){await writeAtomic(linuxConfig,JSON.stringify(linux,null,2));await run('systemctl',['--user','reload','enclave-tuna-privacy.service']).catch(e=>log('linux reload: '+e.message));}
}
if(hosts[1].changed){
  log(`windows: ${hosts[1].changed} app(s) given their fallback`);
  // Written beside the file and moved over it; the agent reloads on the modification time.
  if(!DRY)await ps("$f=\"$a\\privacy-config.json\";$stamp=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ');"+
    "Copy-Item $f \"$f.$stamp\";[IO.File]::WriteAllText(\"$f.tmp\",$in,(New-Object Text.UTF8Encoding($false)));Move-Item -Force \"$f.tmp\" $f;$out='ok'",
    JSON.stringify(windows,null,2));
}

const state=(await remote('systemctl is-active tuna-web.service || true')).trim();
if(state==='active'){
  if(current!==plan.haproxy&&!DRY){await remote('systemctl reload tuna-web.service');log('haproxy: reloaded');}
}else if(!DRY){
  const busy=(await remote("ss -Hltn '( sport = :443 or sport = :80 )' | wc -l")).trim();
  if(busy!=='0')log('haproxy: not running and :443/:80 are still held (a TUNA allocation); starting once they are free');
  else{await remote('systemctl start tuna-web.service');log('haproxy: started');}
}else log(`haproxy: service ${state} (dry run)`);
log(`${plan.apps.length} apps on ${provider.address}; linux ${hosts[0].changed} and windows ${hosts[1].changed} changed${DRY?' (dry run)':''}`);
