import fs from 'node:fs/promises';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';
import {chromium} from './enclave/e2e/node_modules/playwright/index.mjs';
const root=path.resolve('work/enclave/site');
const server=http.createServer(async(req,res)=>{try{
 const name=new URL(req.url,'http://localhost').pathname;
 if(name==='/__test'){res.setHeader('content-type','text/html');return res.end('<!doctype html><html><body></body></html>');}
 const file=path.resolve(root,'.'+decodeURIComponent(name));if(!file.startsWith(root+path.sep))throw Error('path');
 res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));
}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
let browser;const results=[];
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage();
 await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
 await page.goto(origin+'/__test');
 await page.evaluate(async()=>{
  const c=await import('/js/core/catalog.js'),api=await import('/js/core/api.js');await import('/components/app-detail/app-detail.js');
  window.c=c;window.api=api;api.Enclave.address='0x'+'34'.repeat(20);c.STORE.owner=api.Enclave.address;c.STORE.loaded=true;
  window.testApp={appId:'0x'+'cd'.repeat(32),publisher:'0x'+'12'.repeat(20),slug:'demo',name:'Demo',description:'Fixture',active:true,versionCount:1,versions:[{version:'1',cid:'bafktest',approval:1,yanked:false,verified:false,ports:'http',memMb:64,cpuGflops:2,vramMb:0,gpuGflops:0,config:''}]};
  c.STORE.apps=[testApp];c.STORE.byId={[testApp.appId]:testApp};const el=document.createElement('c-app-detail');el.app=testApp;document.body.append(el);
 });
 await page.waitForSelector('[data-act="deploy"]');
 for(const testCase of [{name:'approved',active:true,approval:1,yanked:false,disabled:false},{name:'rejected',active:true,approval:2,yanked:false,disabled:true},{name:'yanked',active:true,approval:1,yanked:true,disabled:true},{name:'delisted',active:false,approval:1,yanked:false,disabled:true}]){
  await page.evaluate(t=>{testApp.active=t.active;Object.assign(testApp.versions[0],{approval:t.approval,yanked:t.yanked});document.querySelector('c-app-detail').app={...testApp};},testCase);
  await page.waitForFunction(expected=>document.querySelector('[data-act="deploy"]')?.disabled===expected,testCase.disabled);
  assert.equal(await page.locator('[data-act="deploy"]').isDisabled(),testCase.disabled);
  const visible=await page.evaluate(()=>{api.Enclave.address=null;const normal=c.visibleVerIdxs(testApp).length;api.Enclave.address=c.STORE.owner;return {normal,admin:c.visibleVerIdxs(testApp).length};});
  assert.equal(visible.normal,testCase.disabled?0:1);assert.equal(visible.admin,1);results.push({name:testCase.name,...visible,deployDisabled:testCase.disabled});
 }
 await page.screenshot({path:'outputs/admin-control-audit/catalog-moderation-browser.png',fullPage:true});
 await fs.writeFile('outputs/admin-control-audit/catalog-browser-tests.json',JSON.stringify({at:new Date().toISOString(),results,network:'loopback-only; all external requests aborted; no wallet signing'},null,2)+'\n');console.log(JSON.stringify(results));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
