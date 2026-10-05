#!/usr/bin/env node
// Run on the independent probe machine. The signing key never leaves it.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';
const run=promisify(execFile),file=process.argv[2];if(!file)throw Error('usage: qualification-round.mjs PRIVATE_CONFIG');
const cfg=JSON.parse(await fs.readFile(file,'utf8'));
if(!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(cfg.sshHost||'')||[cfg.remoteManifest,cfg.remoteReport].some(p=>!/^\/[a-zA-Z0-9_./-]+$/.test(p||'')))throw Error('explicit SSH host and absolute provider paths required');
if(cfg.sshConfigFile&&(!path.isAbsolute(cfg.sshConfigFile)||cfg.sshConfigFile.includes('\0')))throw Error('absolute SSH config path required');
const sshConfig=cfg.sshConfigFile?['-F',cfg.sshConfigFile]:[];
const ssh=[...sshConfig,'-o','BatchMode=yes','-o','ConnectTimeout=15',cfg.sshHost];
const {stdout}=await run('ssh',[...ssh,'cat -- '+cfg.remoteManifest],{maxBuffer:65536,timeout:20000});
const manifest=JSON.parse(stdout),proxy=new URL('socks5://'+manifest.proxy);
if(proxy.hostname!=='127.0.0.1'||!/^\d+$/.test(proxy.port)||!/^[0-9a-f]{32}$/.test(proxy.username)||!/^[0-9a-f]{32}$/.test(proxy.password))throw Error('host returned an invalid private canary endpoint');
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const tunnel=spawn('ssh',[...sshConfig,'-N','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ExitOnForwardFailure=yes','-L',`127.0.0.1:${port}:127.0.0.1:${proxy.port}`,cfg.sshHost],{stdio:'ignore'});
let tunnelError;tunnel.on('error',e=>{tunnelError=e;});
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'provider-qualification-'));await fs.chmod(dir,0o700);
try{
 let ready=false;for(let i=0;i<100;i++){
  if(tunnelError||tunnel.exitCode!==null)throw Error('independent probe tunnel failed');
  ready=await new Promise(r=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));});if(ready)break;await new Promise(r=>setTimeout(r,100));
 }
 if(!ready)throw Error('private probe tunnel did not start');
 const manifestFile=path.join(dir,'manifest.json'),outputFile=path.join(dir,'qualification.json'),configFile=path.join(dir,'config.json');
 await fs.writeFile(manifestFile,JSON.stringify(manifest),{mode:0o600});
 await fs.writeFile(configFile,JSON.stringify({...cfg,manifestFile,outputFile,proxy:proxy.username+':'+proxy.password+'@127.0.0.1:'+port}),{mode:0o600});
 const result=await run(process.execPath,[new URL('./qualify-provider.mjs',import.meta.url).pathname,'--config',configFile,'--publish'],{timeout:110000,maxBuffer:65536});
 const envelope=await fs.readFile(outputFile);
 const child=spawn('ssh',[...ssh,`umask 077; cat > ${cfg.remoteReport}.tmp && chmod 600 ${cfg.remoteReport}.tmp && mv ${cfg.remoteReport}.tmp ${cfg.remoteReport}`],{stdio:['pipe','ignore','pipe']});
 const done=new Promise((r,j)=>{child.once('error',j);child.stdin.once('error',j);child.once('exit',code=>code===0?r():j(Error('provider report installation failed')));});child.stderr.resume();child.stdin.end(envelope);await done;
 process.stdout.write(result.stdout);
}finally{tunnel.kill('SIGTERM');await fs.rm(dir,{recursive:true,force:true});}
