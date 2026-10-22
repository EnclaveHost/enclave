// Read-only public browsing in a fresh disposable context; no wallet, cookies,
// user profile, transaction, deployment or production infrastructure changes.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const require = createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/e2e/package.json');
const { chromium } = require('playwright');
const base = new URL('.', import.meta.url);
const knownDO = new Set(['134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39']);
const blocked=[], requests=[], failed=[], pages=[];
let browser;
const report={startedAt:new Date().toISOString(),mode:'fresh disposable browser, no wallet, no existing storage, public navigation only, no wallet or authenticated actions',knownDigitalOceanAddresses:[...knownDO],blocked,requests,failed,pages,limitations:['Browser-side hostname/IP blocking only; no claim about gateway backend provenance or DNS rebinding.','Uses public ENS HTTPS gateway, not native ENS resolution.','No authenticated deployment, writes, custody or provider outage drill.']};
const deadline=setTimeout(()=>{void browser?.close();},110000);
try {
 browser=await chromium.launch({headless:true,args:['--single-process','--no-zygote','--in-process-gpu','--disable-software-rasterizer','--disable-gpu','--disable-dev-shm-usage','--renderer-process-limit=1','--disable-extensions','--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess','--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2','--js-flags=--max-old-space-size=128']});
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
 await context.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(knownDO.has(u.hostname)||/(^|\.)enclave\.host$/i.test(u.hostname)||u.hostname==='62.238.4.214'){
   blocked.push({origin:u.origin,path:u.pathname});return route.abort('blockedbyclient');
  }
  return route.continue();
 });
 context.on('request',r=>{const u=new URL(r.url());requests.push({method:r.method(),origin:u.origin,path:u.pathname});});
 context.on('requestfailed',r=>{const u=new URL(r.url());failed.push({origin:u.origin,path:u.pathname,error:r.failure()?.errorText});});
 for(const pathname of ['/','/apps','/dashboard']){
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const row={path:pathname,errors};pages.push(row);
  try{
   const response=await page.goto('https://enclavehost.eth.limo'+pathname,{waitUntil:'domcontentloaded',timeout:25000});
   row.status=response?.status();
   // Observe rendering for a bounded interval; no clicks, wallet or writes.
   await page.waitForTimeout(6000);
   row.title=await page.title();
   row.body=(await page.locator('body').innerText({timeout:5000})).slice(0,12000);
   row.readyState=await page.evaluate(()=>document.readyState);
   row.screenshot=pathname==='/'?'home.png':pathname.slice(1)+'.png';
   await page.screenshot({path:new URL(row.screenshot,base).pathname,timeout:5000});
  }catch(e){row.error=e.message;}
  finally{await page.close();}
 }
 report.completed=true;
}catch(e){report.error=e.message;report.completed=false;}
finally{
 clearTimeout(deadline);
 await browser?.close();
 report.finishedAt=new Date().toISOString();
 await fs.writeFile(new URL('result.json',base),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({completed:report.completed,pages:pages.map(p=>({path:p.path,status:p.status,title:p.title,readyState:p.readyState,error:p.error,bodyPreview:p.body?.slice(0,350),pageErrors:p.errors})),blocked:blocked.length,failed:failed.length,error:report.error}));
}
