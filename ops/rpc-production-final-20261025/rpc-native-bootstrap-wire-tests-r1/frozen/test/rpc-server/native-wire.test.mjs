import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import {nativeWire,mapNativeClock} from '../../rpc/host/native-wire.mjs';
const frame=(lane,body)=>{body=Buffer.from(body);const h=Buffer.alloc(5);h[0]=lane;h.writeUInt32BE(body.length,1);return Buffer.concat([h,body]);};
function fixture(){const input=new PassThrough(),output=new PassThrough(),abort=new AbortController();const wire=nativeWire(input,output,abort.signal);return {input,output,abort,wire};}
test('native pipe interop preserves separate TPM and monitor bytes and chunks large owner bodies',async()=>{
 const f=fixture(),outputs=[];f.output.on('data',x=>outputs.push(x));
 const monitor=[],tpm=[];f.wire.monitor.on('data',x=>monitor.push(x));f.wire.tpm.on('data',x=>tpm.push(x));
 const control=f.wire.receiveControl();const inbound=Buffer.concat([frame(2,'ready tpmattest/1\r\n'),frame(0,'{"clock":1}'),frame(1,'{"request":1}\n')]);
 for(let i=0;i<inbound.length;i+=3)f.input.write(inbound.subarray(i,i+3));
 assert.equal((await control).toString(),'{"clock":1}');
 await new Promise(r=>setImmediate(r));assert.equal(Buffer.concat(monitor).toString(),'{"request":1}\n');assert.equal(Buffer.concat(tpm).toString(),'ready tpmattest/1\r\n');
 const body=Buffer.alloc(100000,0x61);await new Promise((resolve,reject)=>f.wire.monitor.write(body,e=>e?reject(e):resolve()));
 await f.wire.sendControl('acquisition-requested');const bytes=Buffer.concat(outputs);let at=0;const restored=[];let count=0;
 while(at<bytes.length){const lane=bytes[at],n=bytes.readUInt32BE(at+1);assert.ok(n<=32768);const b=bytes.subarray(at+5,at+5+n);at+=5+n;if(lane===1){restored.push(b);count++;}else{assert.equal(lane,0);assert.equal(b.toString(),'acquisition-requested');}}
 assert.equal(count,4);assert.deepEqual(Buffer.concat(restored),body);f.wire.close();
});
test('native malformed lane, oversize and incomplete EOF consume pending request',async()=>{
 for(const bytes of [Buffer.from([3,0,0,0,1,1]),Buffer.from([1,0,1,0,0]),Buffer.from([0,0,0,0,5,1])]){
  const f=fixture();const refused=assert.rejects(f.wire.receiveControl());f.input.end(bytes);await refused;assert.throws(()=>f.wire.sendControl('clock'));assert.ok(f.wire.monitor.destroyed&&f.wire.tpm.destroyed);
 }
});
test('native duplicate control and unread lane overflow refuse before consumption',async()=>{
 for(const bytes of [Buffer.concat([frame(0,'one'),frame(0,'two')]),Buffer.concat([frame(1,Buffer.alloc(32768)),frame(1,Buffer.alloc(32768)),frame(1,'x')])]){
  const f=fixture();f.input.write(bytes);assert.throws(()=>f.wire.receiveControl());assert.ok(f.wire.monitor.destroyed);f.wire.close();
 }
});
test('supervisor loss rejects blocked receive and cannot reopen streams',async()=>{
 const f=fixture();const refused=assert.rejects(f.wire.receiveControl(),/supervisor lost/);f.abort.abort();await refused;
 assert.throws(()=>f.wire.receiveControl());assert.throws(()=>f.wire.sendControl('clock'));assert.ok(f.input.destroyed&&f.output.destroyed);
});
test('native time translation charges the complete roundtrip without sharing a clock epoch',()=>{
 const r={schema:'rpc-native-clock/1',originMs:'1000',deadlineMs:'901000',phaseDeadlineMs:'5100',sampleMs:'5000'};
 let local=123456789n;const before=local;local+=50000000n;const c=mapNativeClock(r,before,()=>local);
 assert.equal(c.now(),5050000000n);assert.equal(c.phaseDeadlineNs-c.now(),50000000n);assert.equal(c.original.originMonotonicNs,1000000000n);
 local+=50000000n;assert.equal(c.now(),c.phaseDeadlineNs);local--;assert.throws(()=>c.now(),/regressed/);
});
test('native time rejects stale handshake, reset windows, overflow and unsafe forms',()=>{
 const r={schema:'rpc-native-clock/1',originMs:'1000',deadlineMs:'901000',phaseDeadlineMs:'5100',sampleMs:'5000'};
 assert.throws(()=>mapNativeClock(r,0n,()=>100000000n),/consumed/);
 for(const change of [{deadlineMs:'901001'},{originMs:'-1'},{sampleMs:5000},{sampleMs:'0005000'},{phaseDeadlineMs:'5000'},{phaseDeadlineMs:'35001'},{deadlineMs:'99999999999999999999'}])assert.throws(()=>mapNativeClock({...r,...change},0n,()=>1n));
});
