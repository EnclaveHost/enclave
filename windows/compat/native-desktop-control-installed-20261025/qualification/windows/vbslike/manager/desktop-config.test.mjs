import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {loadDesktopConfig,probeDesktopWorker} from './desktop-config.mjs';
import {sha256Hex} from './derive.mjs';
import {runtimeId} from '../../../isolation/contract/runtime.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const exe=path.join(dir,'bridge.exe');fs.writeFileSync(exe,'test bridge');
 const profileText=fs.readFileSync(new URL('./testdata/desktop-platform/profile.json',import.meta.url),'utf8'),p=JSON.parse(profileText);
 const runtime={name:'wasmtime',version:'test',execution:'jit',hostIsa:'x86_64',targetIsa:'x86_64',cpuFeatures:'baseline',wx:'enforced',cache:'none'};
 const platform={igvmSha256:'a'.repeat(64),runtimeId:runtimeId(runtime).toString('hex'),profileText,profileSha256:sha256Hex(Buffer.from(profileText)),
  media:[['root',p.root.imageBytes,p.root.imageSha256],['hashes',p.root.hashBytes,p.root.hashSha256],['models',p.models.imageBytes,p.models.imageSha256]]
   .map(([role,payloadBytes,payloadSha256],i)=>({role,path:`C:\\media\\${role}.iso`,bytes:payloadBytes+65536,sha256:String(i+1).repeat(64),payloadBytes,payloadSha256,payloadOffset:65536}))};
 const cfg={imagePath:'C:\\native\\igvm.bin',platform,runtime,bridge:{exe,sha256:sha256Hex(fs.readFileSync(exe))},workerPort:19595,workerBudgetGb:12};
 const file=path.join(dir,'desktop.json');
 const save=(value=cfg)=>{const b=Buffer.from(JSON.stringify(value));fs.writeFileSync(file,b);return sha256Hex(b);};
 return{cfg,file,save,exe};
}
test('native launcher configuration binds its whole file, profile, runtime and worker bridge',t=>{
 const f=fixture(t),pin=f.save(),cfg=loadDesktopConfig(f.file,pin);
 assert.equal(cfg.admission.platform.profileSha256,f.cfg.platform.profileSha256);
 assert.ok(Object.isFrozen(cfg)&&Object.isFrozen(cfg.bridge)&&Object.isFrozen(cfg.platform.media));
 assert.throws(()=>loadDesktopConfig(f.file,'f'.repeat(64)),/differs/);
 fs.writeFileSync(f.exe,'changed');assert.throws(()=>loadDesktopConfig(f.file,pin),/not its pin/);
});
test('partial, oversized, contradictory and ambiguous desktop configurations fail closed',t=>{
 const f=fixture(t);
 for(const patch of [{extra:true},{imagePath:1},{workerPort:'19595'},{workerPort:0},{workerPort:65536},{workerBudgetGb:'12'},{workerBudgetGb:0},
  {runtime:{...f.cfg.runtime,version:'wrong'}},{bridge:{...f.cfg.bridge,exe:1}},{bridge:{...f.cfg.bridge,sha256:'bad'}}]){
  const pin=f.save({...f.cfg,...patch});assert.throws(()=>loadDesktopConfig(f.file,pin));
 }
 const missing={...f.cfg};delete missing.platform;assert.throws(()=>loadDesktopConfig(f.file,f.save(missing)));
 fs.writeFileSync(f.file,' '.repeat(65537));assert.throws(()=>loadDesktopConfig(f.file,'a'.repeat(64)),/64 KiB/);
 for(const pin of ['',null,1,'A'.repeat(64)])assert.throws(()=>loadDesktopConfig(f.file,pin),/path and SHA256/);
});
test('native worker probe requires reservation protocol and the exact configured budget',async()=>{
 const cfg={workerPort:1234,workerBudgetGb:12};
 const card={protocol:'1,4,0',vramBudgetGb:12};
 assert.equal(await probeDesktopWorker(cfg,async args=>{assert.deepEqual(args,{port:1234});return card;}),card);
 for(const other of [{...card,protocol:'1,2,9'},{...card,protocol:'2,0,0'},{...card,protocol:'1,3,'},{...card,protocol:'1,3,-1'},
  {...card,vramBudgetGb:0},{...card,vramBudgetGb:11.99},null])
  await assert.rejects(probeDesktopWorker(cfg,async()=>other),/protocol or budget/);
});
test('native worker liveness uses a non-reserving HELLO over the real wire',async t=>{
 const server=net.createServer(sock=>{
  let got=Buffer.alloc(0);
  sock.on('data',b=>{
   got=Buffer.concat([got,b]);if(got.length<13)return;
   assert.equal(got.length,13);assert.equal(got[0],0);assert.equal(got.readBigUInt64LE(1),4n);assert.equal(got.readUInt32LE(9),1);
   const payload=Buffer.from(JSON.stringify({version:[1,4,0],vram_budget:12*2**30,vram_total:16*2**30,vram_free:12*2**30}));
   const header=Buffer.alloc(9);header.writeBigUInt64LE(BigInt(payload.length),1);sock.end(Buffer.concat([header,payload]));
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const card=await probeDesktopWorker({workerPort:server.address().port,workerBudgetGb:12});
 assert.equal(card.protocol,'1,4,0');assert.equal(card.vramBudgetGb,12);
});
