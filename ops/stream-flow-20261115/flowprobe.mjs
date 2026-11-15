// Does the app's front serve port-tunnel flows? Opens tunnels to UDP 47999 under the app's name and reads the answers.
import tls from 'node:tls';import {randomBytes} from 'node:crypto';
const repo=process.argv[2],name=process.argv[3];
const {openTunnel}=await import(repo+'/network/wg-provider/gamestream.mjs');
const connect=(to,n)=>new Promise((resolve,reject)=>{const s=tls.connect({host:n,port:443,servername:n,ALPNProtocols:['http/1.1']},()=>{s.setNoDelay(true);resolve(s);});s.once('error',reject);});
const id=randomBytes(16).toString('hex'),t0=Date.now();
const plain=await openTunnel({to:name,name,proto:'udp',port:47999,connect});console.log('plain tunnel: 101, flow',plain.flow,`(${Date.now()-t0} ms)`);plain.socket.destroy();
const lanes=[];
for(let i=0;i<16;i++){const t=Date.now();const x=await openTunnel({to:name,name,proto:'udp',port:47999,connect,flow:id});lanes.push(x);if(i<2||i===15)console.log(`lane ${i+1}: 101, flow`,x.flow,`(${Date.now()-t} ms)`);}
try{await openTunnel({to:name,name,proto:'udp',port:47999,connect,flow:id});console.log('a 17th lane was accepted');}catch(e){console.log('a 17th lane:',e.message);}
try{await openTunnel({to:name,name,proto:'tcp',port:47989,connect,flow:id});console.log('a flow on TCP was accepted');}catch(e){console.log('a flow on TCP:',e.message);}
// a report of nothing received is taken; then the front's own reports arrive on a quiet lane within its keepalive
lanes[0].socket.write(Buffer.from([0xff,0xff,0,0,0,0,0,0,0,0]));
await new Promise(r=>setTimeout(r,1500));
console.log('lanes still open after a report:',lanes.filter(l=>!l.socket.destroyed).length);
for(const l of lanes)l.socket.destroy();
process.exit(0);
