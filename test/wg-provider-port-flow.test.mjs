// The client's side of a port-tunnel flow (network/wg-provider/port-flow.mjs) and the gateway that uses it
// (gamestream.mjs): datagrams from several lanes are handed on once and in order, a missing one is waited for no
// longer than the reorder time, and a front that knows no flows gets the plain tunnel.
import test from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import dgram from 'node:dgram';import {once} from 'node:events';
import {flowReceiver,lanePicker,flowDeframer,flowReport,FLOW_REPORT} from '../network/wg-provider/port-flow.mjs';
import {createGameStream} from '../network/wg-provider/gamestream.mjs';

// a clock and timers a test moves by hand
function clock(){
 let t=0,id=0;const timers=new Map();
 return {now:()=>t,setTimer:(fn,ms)=>{timers.set(++id,{at:t+ms,fn});return id;},clearTimer:i=>timers.delete(i),
  advance(ms){const end=t+ms;for(;;){let next=null;for(const [i,x] of timers)if(x.at<=end&&(!next||x.at<next[1].at))next=[i,x];if(!next)break;timers.delete(next[0]);t=next[1].at;next[1].fn();}t=end;},pending:()=>timers.size};
}

test('receiver: in order, once each; a second copy and a late copy are dropped',()=>{
 const c=clock(),got=[],rx=flowReceiver({deliver:p=>got.push(p),reorderMs:80,...c});
 rx.push(0,'a');rx.push(1,'b');rx.push(1,'b again');rx.push(3,'d');rx.push(3,'d again');
 assert.deepEqual(got,['a','b']);
 rx.push(2,'c');assert.deepEqual(got,['a','b','c','d']);
 rx.push(0,'a late');assert.deepEqual(got,['a','b','c','d']);
 assert.deepEqual(rx.stats(),{delivered:4,duplicates:3,skipped:0,late:0,waited:1,rebuilt:0,held:0,next:4,reorderMs:80});
 assert.equal(c.pending(),0);
});

test('receiver: a missing datagram is waited for the reorder time and no longer; when it comes after all it is still handed on, once',()=>{
 const c=clock(),got=[],rx=flowReceiver({deliver:p=>got.push(p),reorderMs:80,...c});
 rx.push(0,'a');rx.push(2,'c');c.advance(79);assert.deepEqual(got,['a']);
 c.advance(1);assert.deepEqual(got,['a','c']);
 rx.push(1,'b');rx.push(1,'b');assert.deepEqual(got,['a','c','b']);
 assert.equal(rx.stats().skipped,1);assert.equal(rx.stats().late,1);assert.equal(rx.stats().duplicates,1);
});

test('receiver: with several missing, no datagram waits longer than the reorder time from its own arrival',()=>{
 const c=clock(),got=[],at=[],rx=flowReceiver({deliver:p=>{got.push(p);at.push(c.now());},reorderMs:80,...c});
 // 0 and 2 and 4 are missing; 1 comes at t=0, 3 at t=30, 5 at t=60
 rx.push(1,'b');c.advance(30);rx.push(3,'d');c.advance(30);rx.push(5,'f');
 c.advance(200);
 assert.deepEqual(got,['b','d','f']);assert.deepEqual(at,[80,110,140]);
});

test('receiver: the wait follows the repair time the app\'s end tells, within its bounds, also for a datagram already waiting',()=>{
 const c=clock(),got=[],rx=flowReceiver({deliver:p=>got.push(p),reorderMs:80,reorderMinMs:40,reorderMaxMs:500,repairMarginMs:20,...c});
 rx.push(1,'b');c.advance(50);
 rx.repair(180);assert.equal(rx.stats().reorderMs,200);
 c.advance(100);assert.deepEqual(got,[]);      // 150 ms in: with the first wait of 80 it would have been passed over
 c.advance(50);assert.deepEqual(got,['b']);
 rx.repair(5);assert.equal(rx.stats().reorderMs,40);rx.repair(9000);assert.equal(rx.stats().reorderMs,500);rx.repair(NaN);assert.equal(rx.stats().reorderMs,500);
 // a shorter time takes effect for what is waiting
 rx.push(3,'d');c.advance(100);rx.repair(30);c.advance(0);assert.deepEqual(got,['b','d']);
});

// the XOR of datagrams, each as its two-byte length and its bytes: what the app's end sends as parity
const xorOf=list=>{const x=Buffer.alloc(2+Math.max(...list.map(p=>p.length)));for(const p of list){x[0]^=p.length>>8;x[1]^=p.length&255;for(let i=0;i<p.length;i++)x[2+i]^=p[i];}return x;};
test('receiver: with all of a parity group but one, the missing datagram is made from the rest, at once and whatever the order',()=>{
 const group=[Buffer.from('zero'),Buffer.from('the longest of the four'),Buffer.from(''),Buffer.from('three')],parity=xorOf(group);
 for(const missing of [0,1,2,3])for(const parityFirst of [false,true]){
  const c=clock(),got=[],rx=flowReceiver({deliver:p=>got.push(p.toString()),reorderMs:80,...c});
  if(parityFirst)rx.parity(0,4,parity);
  for(let s=0;s<4;s++)if(s!==missing)rx.push(s,group[s]);
  if(!parityFirst)rx.parity(0,4,parity);
  assert.deepEqual(got,group.map(String),`missing ${missing}, parity ${parityFirst?'first':'last'}`);
  assert.equal(rx.stats().rebuilt,1);assert.equal(c.pending(),0);
  // the real one arrives after all: a second copy
  rx.push(missing,group[missing]);assert.equal(got.length,4);assert.equal(rx.stats().duplicates,1);
 }
 // two missing: nothing can be made, and the wait is the usual one; a group that is whole needs nothing
 const c=clock(),got=[],rx=flowReceiver({deliver:p=>got.push(p.toString()),reorderMs:80,...c});
 rx.push(0,group[0]);rx.push(3,group[3]);rx.parity(0,4,parity);assert.deepEqual(got,['zero']);
 rx.push(2,group[2]);assert.deepEqual(got,group.map(String));assert.equal(rx.stats().rebuilt,1);
 rx.parity(0,4,parity);rx.parity(0,40,parity);rx.parity(9,1,Buffer.from([0]));assert.equal(rx.stats().rebuilt,1);
 // a parity frame of one is that datagram
 rx.parity(4,1,xorOf([Buffer.from('alone')]));assert.equal(got[4],'alone');
});

test('receiver: more held than it may hold moves on without the timer',()=>{
 const c=clock(),got=[],rx=flowReceiver({deliver:p=>got.push(p),reorderMs:80,maxHeld:3,...c});
 for(const s of [1,2,3])rx.push(s,s);assert.deepEqual(got,[]);
 rx.push(4,4);assert.deepEqual(got,[1,2,3,4]);assert.equal(rx.stats().skipped,1);
 rx.close();rx.push(5,5);assert.deepEqual(got,[1,2,3,4]);
});

test('lane picker: the least behind lane, none when all are late, and a count that cannot be is refused',()=>{
 let t=0;const p=lanePicker({now:()=>t,spillMs:10,lateMs:100,startupMs:2000});
 const a=p.add(),b=p.add();
 assert.equal(p.pick(),a);p.sent(a);t+=5;assert.equal(p.report(a,1),true);     // lane a's usual delay: 5 ms
 p.sent(b);t+=7;assert.equal(p.report(b,1),true);                                // lane b's: 7 ms
 // a carries one that is not reported: after 30 ms it is 25 behind, and b is taken
 p.sent(a);t+=30;assert.equal(p.behind(a),25);assert.equal(p.pick(),b);
 // both behind, a less: a; both late: none
 p.sent(b);t+=60;assert.equal(p.behind(a),85);assert.equal(p.behind(b),53);assert.equal(p.pick(),b);
 t+=60;assert.equal(p.pick(),-1);
 assert.equal(p.report(a,2),true);assert.equal(p.pick(),a);
 assert.equal(p.report(a,1),false);assert.equal(p.report(a,3),false);assert.equal(p.report(a,2.5),false);
 p.remove(a);p.remove(b);assert.equal(p.pick(),-1);
 // before a lane's first report its usual delay is unknown: it is used for the startup time, then not
 const q=lanePicker({now:()=>t,startupMs:2000});const x=q.add();q.sent(x);t+=1999;assert.equal(q.pick(),x);t+=2;assert.equal(q.pick(),-1);
});

test('deframer: data frames, reports, and what is neither',()=>{
 const seen=[];let bad=0;
 const feed=flowDeframer({onData:(seq,p)=>seen.push([seq,p.toString()]),onReport:n=>seen.push(['report',n]),onRepair:ms=>seen.push(['repair',ms]),onParity:(f,n,x)=>seen.push(['parity',f,n,x.toString('hex')]),onError:()=>bad++});
 const data=(seq,s)=>{const b=Buffer.alloc(6+s.length);b.writeUInt16BE(4+s.length);b.writeUInt32BE(seq,2);b.write(s,6);return b;};
 const all=Buffer.concat([data(7,'seven'),flowReport(12),Buffer.from([0xff,0xfe,0,0,0,177]),Buffer.from([0xff,0xfd,0,8,0,0,0,5,3,0xaa,0xbb,0xcc]),data(0xffffffff,''),data(8,'eight')]);
 for(const byte of all)feed(Buffer.from([byte]));   // framing must not depend on how the bytes arrive
 assert.deepEqual(seen,[[7,'seven'],['report',12],['repair',177],['parity',5,3,'aabbcc'],[0xffffffff,''],[8,'eight']]);
 assert.equal(flowReport(12).readUInt16BE(0),FLOW_REPORT);
 feed(Buffer.from([0,3,1,2,3]));assert.equal(bad,1);                      // a data frame too short for a sequence number
 const feed2=flowDeframer({onData(){},onReport(){},onError:()=>bad++});feed2(Buffer.from([0xff,0xfc]));assert.equal(bad,2);feed2(Buffer.from([0xff,0xfd,0,3,0,0,0]));assert.equal(bad,3);
});

// a front that speaks flows: lanes of one id share `flow`; a test sends frames on chosen lanes and reads what arrives
async function flowFront(){
 const flows=new Map(),sockets=new Set(),heads=[];
 const server=net.createServer(s=>{
  sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));
  let buf=Buffer.alloc(0),lane=null;
  s.on('data',chunk=>{
   buf=Buffer.concat([buf,chunk]);
   if(!lane){
    const end=buf.indexOf('\r\n\r\n');if(end<0)return;
    const head=buf.subarray(0,end).toString('latin1');heads.push(head);buf=buf.subarray(end+4);
    const id=/\r\nEnclave-Port-Flow: ([0-9a-f]{32})(\r\n|$)/.exec(head)?.[1];
    if(!/^GET \/\.well-known\/enclave-tunnel\/udp\/\d+ HTTP\/1\.1\r\n/.test(head)||!id)return s.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    if(!flows.has(id))flows.set(id,{lanes:[],datagrams:[]});
    lane={s,flow:flows.get(id),reports:[]};lane.flow.lanes.push(lane);
    s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: enclave-port/1\r\nEnclave-Port-Flow: 1\r\n\r\n');
   }
   while(buf.length>=2){
    const n=buf.readUInt16BE(0);
    if(n===0xffff){if(buf.length<10)break;lane.reports.push(Number(buf.readBigUInt64BE(2)));buf=buf.subarray(10);continue;}
    if(buf.length<2+n)break;lane.flow.datagrams.push([lane.flow.lanes.indexOf(lane),buf.subarray(2,2+n).toString()]);buf=buf.subarray(2+n);
   }
  });
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const data=(seq,s)=>{const b=Buffer.alloc(6+s.length);b.writeUInt16BE(4+s.length);b.writeUInt32BE(seq,2);b.write(s,6);return b;};
 return {port:server.address().port,flows,heads,data,close(){server.close();for(const s of sockets)s.destroy();}};
}
const until=async(ok,what)=>{for(let i=0;i<300;i++){if(ok())return;await new Promise(r=>setTimeout(r,10));}assert.fail('never: '+what);};

test('gateway: a flow of several lanes; datagrams from the lanes reach the client in order and once; each lane reports',async()=>{
 const f=await flowFront();
 const g=await createGameStream({route:n=>n==='desk.app.test'?'10.9.0.2':null,host:'127.0.0.1',ports:{http:0,https:0,rtsp:0,udp:[0,0,0]},flowLanes:[3,1,1],reorderMs:60,
  connect:async()=>{const s=net.connect(f.port,'127.0.0.1');await once(s,'connect');return s;},randomId:()=>'0123456789abcdef0123456789abcdef'});
 const sock=dgram.createSocket('udp4');
 try{
  // the name comes with an HTTP request; the stand-in refuses the TCP tunnel, which is all the binding needs
  {const s=net.connect({port:g.ports.http,host:'127.0.0.1',localAddress:'127.0.0.7'});s.on('error',()=>{});await once(s,'connect');s.end('GET / HTTP/1.1\r\nHost: desk.app.test\r\n\r\n');await once(s,'close');}
  sock.bind(0,'127.0.0.7');await once(sock,'listening');
  const got=[];sock.on('message',m=>got.push(m.toString()));
  sock.send(Buffer.from('ping'),g.ports.udp[0],'127.0.0.1');
  const flow=()=>f.flows.get('0123456789abcdef0123456789abcdef');
  await until(()=>flow()?.lanes.length===3,'three lanes');
  await until(()=>flow().datagrams.length===1,'the first datagram');
  assert.equal(flow().datagrams[0][1],'ping');
  assert.equal(f.heads.filter(h=>h.includes('Enclave-Port-Flow: 0123456789abcdef0123456789abcdef')).length,3);
  // out of order across lanes, one sent twice: 0 on lane 0, 2 on lane 1, 1 on lane 2 and again on lane 0, 3 on lane 1
  const [a,b,c]=flow().lanes;
  a.s.write(f.data(0,'zero'));b.s.write(f.data(2,'two'));
  await until(()=>got.length===1,'zero');
  c.s.write(f.data(1,'one'));a.s.write(f.data(1,'one'));b.s.write(f.data(3,'three'));
  await until(()=>got.length===4,'all four');
  assert.deepEqual(got,['zero','one','two','three']);
  // each lane told the front how many data frames it has received
  await until(()=>a.reports.at(-1)===2&&b.reports.at(-1)===2&&c.reports.at(-1)===1,'reports');
  // a datagram that never comes is passed over after the reorder time
  a.s.write(f.data(5,'five'));
  await until(()=>got.length===5,'five after the wait');
  assert.equal(got[4],'five');
  // the client's datagrams keep going to the app when a lane is gone (one sent while the gateway has not yet seen the
  // lane close is lost with it, as a datagram may be)
  a.s.destroy();
  await until(()=>{sock.send(Buffer.from('still'),g.ports.udp[0],'127.0.0.1');return flow().datagrams.some(d=>d[1]==='still'&&d[0]!==0);},'datagram after a lane closed');
  // and the gateway opens a lane in place of the one that ended
  await until(()=>flow().lanes.length===4,'a fourth connection');
  assert.equal(flow().lanes.filter(l=>!l.s.destroyed).length,3);
  assert.equal(g.stats().udp.flows,1);assert.equal(g.stats().udp.plain,0);assert.equal(g.stats().udp.renewed,1);
 }finally{sock.close();g.close();f.close();}
});
