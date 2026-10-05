import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {createAppRedirect} from '../network/app-redirect.mjs';
test('an app redirect rejects other hosts and expires with admission',async()=>{
 let admitted=true;const s=await createAppRedirect({deploymentId:'app',names:['one.example'],authorize:()=>admitted});
 const get=(host,path)=>new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:s.port,path,headers:{host}},r=>{r.resume();r.on('end',()=>resolve({status:r.statusCode,location:r.headers.location}));}).on('error',reject)});
 try{assert.deepEqual(await get('one.example','/x?q=1'),{status:308,location:'https://one.example/x?q=1'});assert.equal((await get('other.example','/')).status,421);assert.equal((await get('one.example','//other.example')).status,400);admitted=false;assert.equal((await get('one.example','/')).status,421);}finally{s.close();}
});
