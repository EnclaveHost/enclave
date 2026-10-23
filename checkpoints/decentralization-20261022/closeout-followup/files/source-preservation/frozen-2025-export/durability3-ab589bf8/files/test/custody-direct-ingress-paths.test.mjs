// The direct custodian ingress (custody/v2/ingress.mjs, served by the REAL Caddy over TLS) in front of the REAL custodian
// router (custody/v2/http.mjs). Caddy matches a cleaned, percent-decoded path; the guest resolves the forwarded URL with
// WHATWG rules (dot segments, %2e, backslashes). No request through the ingress, however its path is spelled, may reach
// the guest's host-binding route; and the host's private /state, /submit and /receipts never reach the guest port.
//   run: CADDY_BIN=/path/to/caddy node --test test/custody-direct-ingress-paths.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {mintLocalCa} from './helpers/local-tls.mjs';
import {directCustodyIngress} from '../custody/v2/ingress.mjs';
import {createCustodyRouter} from '../custody/v2/http.mjs';
const caddy=process.env.CADDY_BIN;
const HB='host-binding';
// spellings of the host-binding route: case, slashes, dot segments (plain, %-encoded, mixed), backslashes, encoded
// separators, parameters, query and fragment confusion, and an absolute-form target
const VARIANTS=[`/v2/custody/${HB}`,`/V2/CUSTODY/HOST-BINDING`,`/v2/custody/${HB}/`,`//v2/custody/${HB}`,`/v2//custody/${HB}`,`/v2/custody/./${HB}`,
  `/v2/custody/release/../${HB}`,`/v2/custody/release/%2e%2e/${HB}`,`/v2/custody/release/%2E%2E/${HB}`,`/v2/custody/release/.%2e/${HB}`,
  `/v2/custody/release/%2e./${HB}`,`/v2/custody/release\\..\\${HB}`,`/v2/custody/release/..\\${HB}`,`/v2/custody/release/..%5c${HB}`,
  `/v2/custody/release%2f..%2f${HB}`,`/v2/custody/release/%252e%252e/${HB}`,`/v2/custody/${HB}?/v2/custody/release`,`/v2/custody/${HB};/v2/custody/release`,
  `/v2/custody/release/..;/${HB}`,`/v2/custody/host%2Dbinding`,`/v2/custody/%68ost-binding`,`/v2/custody/release/%2e%2e%2f${HB}`,
  `/v2/custody/x/../release/../${HB}`,`/v2/custody/release/../../custody/${HB}`,`http://localhost/v2/custody/${HB}`];
const PRIVATE=[['/state','GET'],['/state','PUT'],['/submit','POST'],['/receipts','GET'],['/v2/custody/release/../../../state','GET'],
  ['/v2/custody/release/%2e%2e/%2e%2e/%2e%2e/submit','POST']];

test('no spelling of the host-binding route passes the direct ingress to the real custodian router',
  {skip:!caddy?'set CADDY_BIN to run the real Caddy/TLS integration':false,timeout:30000},async()=>{
  const ca=mintLocalCa(),seen=[];let bound=0,child,backend,diagnostics='';
  const request=(port,route,method,body='{}')=>new Promise((resolve,reject)=>{
    const req=https.request({hostname:'127.0.0.1',servername:'localhost',port,path:route,method,ca:ca.caPem,
      headers:{host:'localhost','content-type':'application/json','content-length':Buffer.byteLength(body)},timeout:3000},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('timeout')));req.end(body);
  });
  // the real router; the member's host-binding entry point only counts (the private surface under test)
  const member={info:()=>({v:2}),setHostSig:async()=>{bound++;return {ok:true};},evidence:async()=>({ok:true}),join:async()=>({ok:true}),approve:async()=>({ok:true}),
    approveCode:async()=>({ok:true})};
  const custodian={encKeyHex:'00',challenge:()=>({ok:true}),release:async()=>({ok:true})};
  const route=createCustodyRouter({custodian,member,runIndependent:async()=>({ok:true}),servedCommittee:()=>null,chainId:8453,vault:'0x'+'00'.repeat(20),rate:()=>true});
  try{
    backend=http.createServer((req,res)=>{seen.push({path:req.url,method:req.method,resolved:new URL(req.url,'http://x').pathname});return route(req,res);});
    backend.listen(0,'127.0.0.1');await once(backend,'listening');
    const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
    const port=reservation.address().port;await new Promise(r=>reservation.close(r));
    const site=directCustodyIngress({endpoint:'https://localhost',mgmtPort:backend.address().port});
    const config='{\n admin off\n auto_https off\n}\n'+site.replace('https://localhost {',`https://localhost:${port} {\n bind 127.0.0.1\n tls ${ca.dir}/leaf.pem ${ca.dir}/leaf.key`);
    const configPath=path.join(ca.dir,'Caddyfile');fs.writeFileSync(configPath,config,{mode:0o600});
    execFileSync(caddy,['adapt','--config',configPath,'--adapter','caddyfile'],{stdio:'pipe'});
    child=spawn(caddy,['run','--config',configPath,'--adapter','caddyfile'],{env:{...process.env,XDG_CONFIG_HOME:ca.dir,XDG_DATA_HOME:ca.dir},stdio:['ignore','ignore','pipe']});
    child.stderr.on('data',c=>{diagnostics=(diagnostics+c.toString()).slice(-3000);});
    let ready=false;
    for(let i=0;i<100&&!ready;i++){
      if(child.exitCode!==null)throw Error('Caddy exited: '+diagnostics);
      try{ready=(await request(port,'/v2/custody/info','GET','')).status===200;}catch{}
      if(!ready)await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(ready,'the ingress becomes ready');
    // positive control: an allowlisted POST reaches the guest router
    seen.length=0;
    assert.equal((await request(port,'/v2/custody/challenge','POST')).status,200);
    assert.equal(seen.length,1,'an allowlisted route is forwarded');
    seen.length=0;
    const outcomes=[];
    for(const v of VARIANTS){
      let status;try{status=(await request(port,v,'POST')).status;}catch(e){status='client:'+e.code;}
      outcomes.push([v,status]);
    }
    for(const [r,m] of PRIVATE){let status;try{status=(await request(port,r,m)).status;}catch(e){status='client:'+e.code;}outcomes.push([`${m} ${r}`,status]);}
    assert.equal(bound,0,`a host-binding spelling reached the guest's setHostSig: ${JSON.stringify(outcomes)} forwarded ${JSON.stringify(seen)}`);
    for(const s of seen){
      assert.notEqual(s.resolved.toLowerCase().replace(/\/+$/,''),'/v2/custody/host-binding',`forwarded and resolved to host-binding: ${s.path}`);
      assert.ok(!['/state','/submit','/receipts'].includes(s.resolved),`a private host route reached the guest port: ${s.path}`);
    }
    for(const [v,status] of outcomes)assert.ok(status===404||status===400||String(status).startsWith('client:'),`${v}: ${status} (forwarded: ${JSON.stringify(seen)})`);
  }finally{
    if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}
    if(backend){backend.closeAllConnections();await new Promise(r=>backend.close(r));}
    ca.cleanup();
  }
});
