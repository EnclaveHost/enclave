import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,loadStaticFiles} from './server.mjs';
import {fileURLToPath} from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url));
test('completed POST body does not leave a ten-second socket timeout during preflight',async t=>{
 const srv=await startServer({service:{state:()=>({ok:true}),prepare:async()=>{await new Promise(r=>setTimeout(r,10500));return {ok:true,checked:true};}},files:loadStaticFiles(here)});
 t.after(()=>srv.close());
 const res=await fetch(srv.url+'api/prepare',{method:'POST',headers:{'content-type':'application/json',origin:`http://127.0.0.1:${srv.port}`,'x-deploy-token':srv.token},body:'{}'});
 assert.equal(res.status,200);assert.deepEqual(await res.json(),{ok:true,checked:true});
});
