// The edge gateway under test, and a stand-in for Moonlight's video receiver that measures what it gets.
// node client.mjs <repo> <lanes: 0 = plain tunnel> <seconds> [relay port]
import net from 'node:net';import tls from 'node:tls';import dgram from 'node:dgram';import {once} from 'node:events';
const [repo,lanesArg,secondsArg,relay='18443',reorder='80']=process.argv.slice(2);
const {createGameStream}=await import(repo+'/network/wg-provider/gamestream.mjs');
const lanes=Number(lanesArg),seconds=Number(secondsArg);
const connect=(to,name)=>new Promise((resolve,reject)=>{const s=tls.connect({host:'127.0.0.1',port:Number(relay),servername:name,rejectUnauthorized:false,ALPNProtocols:['http/1.1']},()=>{s.setNoDelay(true);resolve(s);});s.once('error',reject);});
const g=await createGameStream({route:n=>n==='desk.app.test'?'10.9.0.2':null,host:'127.0.0.1',ports:{http:0,https:0,rtsp:0,udp:[0,0,0]},connect,flowLanes:lanes?[lanes,1,1]:null,reorderMs:Number(reorder),statsMs:Number(process.env.STATS_MS||10000),log:m=>console.error(m)});
// name the app, as Moonlight's first request does
{const s=net.connect({port:g.ports.http,host:'127.0.0.1'});await once(s,'connect');s.end('GET /serverinfo HTTP/1.1\r\nHost: desk.app.test\r\nConnection: close\r\n\r\n');s.resume();await once(s,'close');}
const sock=dgram.createSocket('udp4');sock.bind(0,'127.0.0.1');await once(sock,'listening');
const wall=()=>performance.timeOrigin+performance.now();
const frames=new Map();let newest=-1,packets=0,stale=0;const delays=[];
sock.on('message',m=>{
 if(m.length<30)return;
 const f=m.readUInt32BE(12),n=m.readUInt16BE(18),data=m.readUInt16BE(20),made=Number(m.readBigUInt64BE(22))/1e6,at=wall();
 packets++;delays.push(at-made);
 // Moonlight's rule: once a packet of a later frame is here, an earlier frame that is not whole yet is given up
 if(f<newest){stale++;return;}
 if(f>newest)newest=f;
 let x=frames.get(f);if(!x)frames.set(f,x={n,data,got:0,made,done:null});
 x.got++;if(x.got===x.data)x.done=at-made;
});
const ping=setInterval(()=>sock.send(Buffer.from('ping'),g.ports.udp[0],'127.0.0.1'),500);sock.send(Buffer.from('ping'),g.ports.udp[0],'127.0.0.1');
await new Promise(r=>setTimeout(r,seconds*1000));
clearInterval(ping);
const pct=(a,p)=>a.length?a[Math.min(a.length-1,Math.floor(a.length*p))]:null,r1=x=>x===null?null:Math.round(x*10)/10;
delays.sort((a,b)=>a-b);
const ids=[...frames.keys()].sort((a,b)=>a-b),first=ids[0],last=ids[ids.length-1];
let shown=0,missing=0,run=0,longest=0;const done=[];
for(let f=first;f<last;f++){const x=frames.get(f);if(x&&x.done!==null){shown++;done.push(x.done);run=0;}else{missing++;run++;if(run>longest)longest=run;}}
done.sort((a,b)=>a-b);
// the picture's delay over time: per 5 s, the median of the frames shown in it
const slices=[];{const per=new Map();for(let f=first;f<last;f++){const x=frames.get(f);if(!x||x.done===null)continue;const k=Math.floor((x.made-frames.get(first).made)/5000);if(!per.has(k))per.set(k,[]);per.get(k).push(x.done);}
 for(const [k,a] of [...per].sort((x,y)=>x[0]-y[0])){a.sort((x,y)=>x-y);slices.push(Math.round(pct(a,0.5)));}}
console.log(JSON.stringify({lanes,packets,stalePackets:stale,packetDelayMs:{p50:r1(pct(delays,0.5)),p95:r1(pct(delays,0.95)),p99:r1(pct(delays,0.99)),max:r1(delays[delays.length-1]??null)},
 frames:{shown,missing,longestGap:longest},frameDelayMs:{p50:r1(pct(done,0.5)),p95:r1(pct(done,0.95)),p99:r1(pct(done,0.99)),max:r1(done[done.length-1]??null)},medianDelayPer5s:slices,gateway:g.stats().udp}));
sock.close();g.close();process.exit(0);
