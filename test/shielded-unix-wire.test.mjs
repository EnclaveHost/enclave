import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import net from 'node:net';

test('private Unix transport preserves framing and refuses invalid/missing endpoints', async () => {
 const dir=mkdtempSync(join(tmpdir(),'shield-unix-'));
 let server;
 try {
  const src=join(dir,'probe.c'), bin=join(dir,'probe');
  writeFileSync(src, `#include "shielded-wire.h"
#include <string.h>
int main(int n,char **v){int e=0;sh_pipe*p=sh_pipe_open(v[1],9501,&e);
if(!p)return 3;
sh_reply r={0};int rc=sh_pipe_call(p,7,"abc",3,&r);
int ok=rc==0&&r.status==0&&r.len==3&&!memcmp(r.data,"xyz",3);
sh_pipe_close(p);return ok?0:4;}`);
  execFileSync('cc',['-O2','-Iwasm/ggml-shielded',src,'wasm/ggml-shielded/shielded-wire.c','-lpthread','-o',bin],{cwd:resolve('.'),stdio:'pipe'});
  const sock=join(dir,'gpu0');let received;
  server=net.createServer(c=>{
   let bytes=Buffer.alloc(0);
   c.on('data',b=>{
    bytes=Buffer.concat([bytes,b]);
    if(bytes.length>=12){received=bytes;const reply=Buffer.alloc(12);reply[0]=0;reply.writeBigUInt64LE(3n,1);reply.write('xyz',9);c.end(reply);}
   });
  });
  await new Promise((yes,no)=>{server.once('error',no);server.listen(sock,yes)});
  async function run(host){return await new Promise((yes,no)=>{
   const c=spawn(bin,[host]);c.once('error',no);c.once('exit',yes);
   const timer=setTimeout(()=>c.kill('SIGKILL'),5000);c.once('exit',()=>clearTimeout(timer));
  })}
  assert.equal(await run('unix:'+sock),0);
  assert.equal(received[0],7);assert.equal(received.readBigUInt64LE(1),3n);
  assert.equal(received.subarray(9).toString(),'abc');
  assert.equal(await run('unix:relative'),3);
  assert.equal(await run('unix:/'+ 'x'.repeat(200)),3);
  assert.equal(await run('unix:'+join(dir,'absent')),3);
 } finally {
  if(server)await new Promise(yes=>server.close(yes));
  rmSync(dir,{recursive:true,force:true});
 }
});
