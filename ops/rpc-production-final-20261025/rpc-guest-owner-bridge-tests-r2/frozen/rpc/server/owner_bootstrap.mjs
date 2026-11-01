// Only owner_bootstrap_entry.py may supply FD3 (sealed config), FD4/5 (held
// TLS key/cert). The service bounds synchronous crypto, IO and child transport.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sha256} from '../../isolation/contract/rpc-bootstrap.mjs';
import {createOwnerBootstrap} from './owner_bootstrap_session.mjs';
import {listenOwnerBootstrap,receivePreparedRequest,writeFrame} from './owner_bootstrap_transport.mjs';

async function run(){
 if(process.argv.length!==2)throw Error('No bootstrap arguments accepted');
 const size=fs.fstatSync(3).size;
 if(size<=0||size>8<<20)throw Error('Bootstrap configuration bound');
 const config=JSON.parse(fs.readFileSync(3,'utf8'));
 const key=fs.readFileSync(4),cert=fs.readFileSync(5),seeds=[fs.readFileSync(6),fs.readFileSync(7)];
 fs.closeSync(6);fs.closeSync(7);
 fs.closeSync(4);fs.closeSync(5);
 const session=createOwnerBootstrap(config);
 let transport;
 try{
  transport=await listenOwnerBootstrap(session,{...config.listen,key,cert,ownerOffer:{seeds,publicKeys:config.ownerPublicKeys,runtime:config.runtime,manifestSha256:sha256(Buffer.from(JSON.parse(config.prepared).manifest,'base64')).toString('hex'),serverName:config.listen.serverName}});key.fill(0);
  const connection=await transport.accepted;
  await receivePreparedRequest(session,connection,Buffer.from(config.prepared));
  const helper=fileURLToPath(new URL('./owner_bootstrap_submit.py',import.meta.url));
  // Child gets the same sealed public config, never the private TLS key FD.
  const child=spawn('/usr/bin/python3',['-B',helper],{stdio:['ignore','pipe','pipe',3]});
  const output=[];let bytes=0,errors=0;
  const raw=await new Promise((resolve,reject)=>{
   let bad=false;
   const fail=e=>{if(bad)return;bad=true;child.kill('SIGKILL');reject(e);};
   child.on('error',fail);
   child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>65540)fail(Error('Owner response bound'));else output.push(chunk);});
   child.stderr.on('data',chunk=>{errors+=chunk.length;if(errors>8192)fail(Error('Owner error bound'));});
   child.on('close',code=>{if(bad)return;if(code!==0)reject(Error('Owner submission held'));else resolve(Buffer.concat(output));});
  });
  if(raw.length<5||raw.readUInt32BE()!==raw.length-4)throw Error('Exact owner response frame required');
  await writeFrame(connection.socket,raw.subarray(4));
 }finally{key.fill(0);for(const seed of seeds)seed.fill(0);transport?.close();session.close();}
}
run().catch(()=>{console.error('Owner bootstrap refused or ambiguous; records retained');process.exitCode=1;});
