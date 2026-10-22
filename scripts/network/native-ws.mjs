#!/usr/bin/env node
// One verified WebSocket per connection, websocat-style: stdin to binary frames and
// frames to stdout, or --listen on a loopback port, where every accepted local
// connection gets its own discovery, hardware proof and upgrade (no reuse, no
// reconnect). Reaches the TCP apps' /x/<id>/tcp/<port> bridges and any app WebSocket.
// A credential comes from NATIVE_AUTHORIZATION (sent as Authorization), never argv.
import fs from 'node:fs/promises';
import net from 'node:net';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {NativeClient} from '../../network/native-client.mjs';

const USAGE='Usage: node scripts/network/native-ws.mjs TRUST-PROFILE.json /path [--protocol NAME]... [--listen 127.0.0.1:PORT]';
export function parseArgs(argv){
  const [profileFile,path,...rest]=argv,protocols=[];let listen=null;
  if(!profileFile||!path?.startsWith('/'))throw Error(USAGE);
  for(let i=0;i<rest.length;i++){
    if(rest[i]==='--protocol'&&rest[i+1])protocols.push(rest[++i]);
    else if(rest[i]==='--listen'&&rest[i+1]){
      const m=/^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]):(\d{1,5})$/.exec(rest[++i]);
      // A bridge carries the caller's credential: never offer it beyond this machine.
      if(!m||+m[2]>65535)throw Error('--listen takes a loopback address and port, e.g. 127.0.0.1:6667');
      listen={host:m[1].replace(/^\[|\]$/g,''),port:+m[2]};
    }else throw Error(USAGE);
  }
  return {profileFile,path,protocols,listen};
}
// Bytes in become binary messages (awaiting each send: bounded buffering); messages
// out are written with backpressure. Input EOF closes the socket normally.
export async function bridge(socket,input,output){
  const upstream=(async()=>{
    for await(const chunk of input)for(let i=0;i<chunk.length;i+=64*1024)await socket.send(chunk.subarray(i,i+64*1024),{binary:true});
    await socket.close(1000);
  })().catch(e=>socket.cancel(e.message));
  try{for await(const m of socket.messages)if(!output.write(m.data))await once(output,'drain');}
  finally{input.destroy?.();await upstream;}
  return socket.closed;
}
async function main(){
  const args=parseArgs(process.argv.slice(2));
  const client=new NativeClient(JSON.parse(await fs.readFile(args.profileFile,'utf8')));
  const headers=process.env.NATIVE_AUTHORIZATION?{authorization:process.env.NATIVE_AUTHORIZATION}:{};
  const open=()=>client.websocket({path:args.path,headers,protocols:args.protocols});
  const report=(s,closed)=>console.error(JSON.stringify({route:s.route,proof:s.proof,expectation:s.expectation,leaseBlock:s.leaseBlock,protocol:s.protocol,closed}));
  if(!args.listen){const s=await open();const closed=await bridge(s,process.stdin,process.stdout);report(s,closed);if(closed.error)process.exitCode=1;return;}
  const server=net.createServer(async local=>{
    local.on('error',()=>{});
    try{const s=await open();report(s,await bridge(s,local,local));}
    catch(e){console.error(e.message);}
    finally{local.destroy();}
  });
  server.listen(args.listen.port,args.listen.host,()=>console.error('listening on '+args.listen.host+':'+server.address().port));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(e=>{console.error(e.message);process.exitCode=e.message===USAGE?2:1;});
