#!/usr/bin/env node
// One verified request with an optional streamed upload (a file or stdin) and an
// optionally streamed response (SSE, chat) to stdout. Same checks as native-get.mjs;
// a credential comes from NATIVE_AUTHORIZATION (sent as Authorization), never argv.
import fs from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import {NativeClient} from '../../network/native-client.mjs';

const USAGE='Usage: node scripts/network/native-request.mjs TRUST-PROFILE.json /path [--method M] [--body-file FILE | --body-stdin] [--content-type T] [--stream]';
export function parseArgs(argv){
  const [profileFile,path,...rest]=argv,o={profileFile,path,method:'GET',stream:false,stdinBody:false,bodyFile:null,contentType:null};
  if(!profileFile||!path?.startsWith('/'))throw Error(USAGE);
  for(let i=0;i<rest.length;i++){
    const flag=rest[i],value=rest[i+1];
    if(flag==='--stream')o.stream=true;
    else if(flag==='--body-stdin')o.stdinBody=true;
    else if(flag==='--method'&&value){o.method=value.toUpperCase();i++;}
    else if(flag==='--body-file'&&value){o.bodyFile=value;i++;}
    else if(flag==='--content-type'&&value){o.contentType=value;i++;}
    else throw Error(USAGE);
  }
  if(o.stdinBody&&o.bodyFile)throw Error(USAGE);
  if((o.stdinBody||o.bodyFile)&&o.method==='GET')o.method='POST';
  return o;
}
// A file is sent with its length; stdin is sent chunked. The body is read only after
// the guest key is verified. Returns the result metadata; the body goes to stdout.
export async function run(client,o,{stdin=process.stdin,stdout=process.stdout,env=process.env}={}){
  const headers={...(env.NATIVE_AUTHORIZATION?{authorization:env.NATIVE_AUTHORIZATION}:{}),...(o.contentType?{'content-type':o.contentType}:{})};
  const upload=o.bodyFile?{body:fs.createReadStream(o.bodyFile),bodyLength:fs.statSync(o.bodyFile).size}:o.stdinBody?{body:stdin}:{};
  const request={method:o.method,path:o.path,headers,...upload,...(upload.body?{maxRequestBytes:1024*1024*1024}:{})};
  if(!o.stream){const r=await client.request(request);stdout.write(r.body);return r;}
  const r=await client.stream(request);
  await pipeline(r.body,stdout,{end:false});
  return {...r,closed:await r.closed};
}
async function main(){
  const o=parseArgs(process.argv.slice(2));
  const client=new NativeClient(JSON.parse(fs.readFileSync(o.profileFile,'utf8')));
  const r=await run(client,o);
  console.error(JSON.stringify({status:r.status,route:r.route,proof:r.proof,expectation:r.expectation,leaseBlock:r.leaseBlock,validUntil:r.validUntil,...(r.closed?{closed:r.closed}:{})}));
  if(r.status<200||r.status>=300)process.exitCode=1;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(e=>{console.error(e.message);process.exitCode=e.message===USAGE?2:1;});
