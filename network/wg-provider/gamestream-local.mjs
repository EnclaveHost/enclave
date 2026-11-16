#!/usr/bin/env node
// A desktop app's GameStream ports on the owner's own machine, for a Moonlight on the same network as the host.
// The same gateway an edge runs (gamestream.mjs: the app's front is asked for port tunnels, UDP as a flow of lanes),
// but it reaches the app's front directly at an address the operator gives, not through a provider: nothing of the
// stream leaves the local network. The host's operator supplies that address (for a Shield partition on a Windows
// host: the manager's relay.port of the app's VM, forwarded over ssh) and the SHA-256 of the front's public key as the
// host's manager verified it (transportKeySha256); a front that presents another key is refused.
//
//   node gamestream-local.mjs <config.json>
//   {"name":"<id>.app.enclave.host","connect":"127.0.0.1:44507","spkiSha256":"<64 hex>","bind":"127.0.0.3"}
//
// Moonlight is pointed at `bind`. Every client that reaches `bind` is taken for this app's: bind to loopback, or to an
// address only the owner's machines reach. Sunshine's own pairing still decides who may stream.
import fs from 'node:fs';
import tls from 'node:tls';
import {createHash} from 'node:crypto';
import {createGameStream} from './gamestream.mjs';

export function localConfig(raw){
 const c=raw&&typeof raw==='object'?raw:{};
 const m=/^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|localhost):(\d{1,5})$/.exec(String(c.connect||''));
 if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(String(c.name||''))||c.name.length>253)throw Error('name: the app\'s host name');
 if(!m||+m[2]<1||+m[2]>65535)throw Error('connect: a loopback address and port (the forwarded front)');
 if(!/^[0-9a-f]{64}$/.test(String(c.spkiSha256||'')))throw Error('spkiSha256: 64 hex digits (the front\'s verified transport key)');
 if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(c.bind||'')))throw Error('bind: an IPv4 address of this machine');
 return {name:c.name,host:m[1].replace(/^\[|\]$/g,''),port:+m[2],spkiSha256:c.spkiSha256,bind:c.bind};
}

// TLS to the forwarded front under the app's name; only the pinned key is accepted (its certificate chain is not what
// identifies it here: the host's manager verified this key for this VM)
export const pinnedConnect=({host,port,spkiSha256})=>(_to,name)=>new Promise((resolve,reject)=>{
 const s=tls.connect({host,port,servername:name,rejectUnauthorized:false,ALPNProtocols:['http/1.1']},()=>{
  let got='';try{got=createHash('sha256').update(s.getPeerX509Certificate().publicKey.export({type:'spki',format:'der'})).digest('hex');}catch{}
  if(got!==spkiSha256){s.destroy();return reject(Error('the front presents another key than the pinned one'));}
  s.removeListener('error',reject);s.setTimeout(0);s.setNoDelay(true);resolve(s);
 });
 s.once('error',reject);s.setTimeout(10000,()=>s.destroy(Error('tunnel connect timeout')));
});

export async function startLocal(raw,{log=()=>{},ports}={}){
 const c=localConfig(raw);
 const g=await createGameStream({route:n=>n===c.name?'local':null,host:c.bind,connect:pinnedConnect(c),log,...(ports?{ports}:{}),
  // one app: a client that names nothing (Moonlight given an address) is this app's
  ask:async()=>({name:c.name,age:0})});
 log(`gamestream local: ${c.bind} TCP ${g.ports.https}, ${g.ports.http}, ${g.ports.rtsp} and UDP ${g.ports.udp.join(', ')} for ${c.name} at ${c.host}:${c.port}`);
 return g;
}

if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(new URL(import.meta.url).pathname)){
 const log=m=>console.log(new Date().toISOString(),m);
 const g=await startLocal(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),{log});
 const stop=()=>{g.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
