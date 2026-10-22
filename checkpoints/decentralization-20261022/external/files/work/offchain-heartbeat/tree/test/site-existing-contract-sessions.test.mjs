import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {stringToHex} from "viem";
import {startRig,haveTools,walletScript} from "./helpers/independent-browser-rig.mjs";
const require=createRequire(new URL("../e2e/package.json",import.meta.url));
let chromium;try{({chromium}=require("playwright"));}catch{}
const skip=haveTools()||(!chromium&&"Playwright unavailable");
// Public Anvil fixture key; never a production wallet.
const ADMIN="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

for (const platformBook of [false,true])
test("browser sessions reuse existing contracts: " + (platformBook ? "admin-controlled address book" : "fixed profile"), {skip:skip||false,timeout:180000}, async t=>{
  let rig,browser;
  const forbidden=[];
  try{
    rig=await startRig({legacySessionFactory:true});
    if (platformBook) rig.profile.addressBook=rig.addresses.book;
    const admin=rig.wc(ADMIN);
    await rig.write(admin,rig.addresses.catalog,rig.abi.catalog,"publishVersion",
      ["existing","Existing","Browser fixture","1","bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
        [0,0,64,1],"http:8080","{}",0n]);
    const appId=await rig.pc.readContract({address:rig.addresses.catalog,abi:rig.abi.catalog,
      functionName:"appIdOf",args:[admin.account.address,"existing"]});
    const set=async(key,value)=>{
      await rig.write(admin,rig.addresses.book,rig.abi.book,"set",[stringToHex(key,{size:32}),value]);
      // Browser reads two confirmations back.
      await rig.pc.request({method:"evm_mine",params:[]});
      await rig.pc.request({method:"evm_mine",params:[]});
      await rig.pc.request({method:"evm_mine",params:[]});
    };
    browser=await chromium.launch({args:["--disable-gpu","--disable-dev-shm-usage","--renderer-process-limit=1","--disable-extensions",
      "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2","--js-flags=--max-old-space-size=192"]});
    const context=await browser.newContext({ignoreHTTPSErrors:true,reducedMotion:"reduce"});
    await context.route("**/*",route=>{
      const u=new URL(route.request().url());
      if(!["localhost","127.0.0.1","[::1]"].includes(u.hostname)){forbidden.push(u.href);return route.abort();}
      return route.continue();
    });
    await context.addInitScript(({profile,address})=>{
      const text=JSON.stringify(profile);
      localStorage.setItem("enclave_independent_profile",text);
      sessionStorage.setItem("enclave_independent_ack",text);
      localStorage.setItem("enclave_session",JSON.stringify({address,rdns:"test.local.wallet"}));
      window.__walletMutations=[];
      const seen=new WeakSet();
      window.addEventListener("eip6963:announceProvider",e=>{
        const p=e.detail.provider;if(seen.has(p))return;seen.add(p);
        const request=p.request.bind(p);
        p.request=async(args)=>{
          if(/^(eth_sign|personal_sign|eth_send)/.test(args.method))window.__walletMutations.push(args.method);
          return request(args);
        };
      });
    },{profile:rig.profile,address:rig.owner});
    await context.addInitScript({content:walletScript({rpc:rig.rpc,address:rig.owner})});
    const page=await context.newPage();
    await page.goto(rig.site+"/dashboard");
    await page.waitForFunction(async()=>!!(await import("/js/core/api.js")).Enclave.provider);
    const mutations=()=>page.evaluate(()=>window.__walletMutations.length);
    let opened,row;
    await t.test("original-style factory resolves through its book without a hosted API",async()=>{
      const a=await page.evaluate(async()=>(await import("/js/core/independent-chain.js")).sessionAuthority());
      assert.equal(a.factory,rig.addresses.factory.toLowerCase());assert.equal(a.book,rig.addresses.book.toLowerCase());
      assert.equal(a.deployments,rig.addresses.ledger.toLowerCase());
    });
    await t.test("wallet opens a session and deploys while the first RPC is unavailable",async()=>{
      rig.rpcModes[0]="down";
      try {
      opened=await page.evaluate(async()=>{
        const c=await (await import("/js/core/sessions.js")).startSession({budgetUsd:2,hours:1});
        return {vault:c.session.handle.vault,sid:c.session.handle.sid};
      });
      await page.evaluate(async ref=>(await import("/js/core/sessions.js")).sessionCall("deploy.create",
        {appRef:ref,gpuMilli:0,cpuMilli:100,appPort:8080,ports:"",isPublic:true,configCid:"",
          maxRate6:100n,env:"staging",fund6:500000n}),`catalog://${appId}/0`);
      const n=await rig.pc.readContract({address:rig.addresses.ledger,abi:rig.abi.ledger,functionName:"count"});
      const rows=await rig.pc.readContract({address:rig.addresses.ledger,abi:rig.abi.ledger,functionName:"getPage",args:[0n,n]});
      row=rows.find(x=>x.owner.toLowerCase()===opened.vault.toLowerCase());
      assert.ok(row);assert.equal(row.balance6,500000n);
      } finally { delete rig.rpcModes[0]; }
    });
    if (!platformBook) await t.test("admin binding changes refuse grant and session signing; restoration retains the same grant",async()=>{
      await set("appCatalog",rig.addresses.registry);
      const before=await mutations();
      const results=await page.evaluate(async id=>{
        const S=await import("/js/core/sessions.js"),result=[];
        for(const fn of [()=>S.startSession({budgetUsd:0,hours:1}),
          ()=>S.sessionCall("deploy.setActive",{id,active:false})]){
          try{await fn();result.push("unexpected success");}catch(e){result.push(e.message);}
        }
        return result;
      },row.id);
      results.forEach(x=>assert.match(x,/appCatalog.*differs/));
      assert.equal(await mutations(),before,"no owner signing or transaction prompt under stale bindings");
      await set("appCatalog",rig.addresses.catalog);
      await page.evaluate(async id=>(await import("/js/core/sessions.js")).sessionCall("deploy.setActive",{id,active:false}),row.id);
      const sid=await page.evaluate(async()=>(await (await import("/js/core/sessions.js")).currentSession()).session.handle.sid);
      assert.equal(sid,opened.sid);
      const stopped=await rig.pc.readContract({address:rig.addresses.ledger,abi:rig.abi.ledger,functionName:"get",args:[row.id]});
      assert.equal(stopped.active,false);
    });
    if (platformBook) await t.test("administrator replaces the catalog without replacing the factory, profile or existing grant",async()=>{
      const catalog=await rig.deployCatalog();
      await rig.write(admin,catalog,rig.abi.catalog,"publishVersion",
        ["updated","Updated","New admin-selected catalog","1","bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
          [0,0,64,1],"http:8080","{}",0n]);
      const nextApp=await rig.pc.readContract({address:catalog,abi:rig.abi.catalog,functionName:"appIdOf",
        args:[admin.account.address,"updated"]});
      await set("appCatalog",catalog);
      rig.rpcModes[0]="down";
      try{
        await page.evaluate(async id=>(await import("/js/core/sessions.js")).sessionCall("deploy.setActive",{id,active:false}),row.id);
        const state=await page.evaluate(async()=>{
          const C=await import("/js/core/config.js"),S=await import("/js/core/sessions.js");
          return {catalog:C.APP_CATALOG_ADDRESS,initial:C.INDEPENDENT.profile.contracts.appCatalog,
            sid:(await S.currentSession()).session.handle.sid};
        });
        assert.equal(state.catalog,catalog.toLowerCase());
        assert.equal(state.initial,rig.addresses.catalog.toLowerCase(),"no profile rewrite");
        assert.equal(state.sid,opened.sid,"no new grant needed for an existing session");
        await page.evaluate(async ref=>(await import("/js/core/sessions.js")).sessionCall("deploy.create",
          {appRef:ref,gpuMilli:0,cpuMilli:100,appPort:8080,ports:"",isPublic:true,configCid:"",
            maxRate6:100n,env:"staging",fund6:0n}),`catalog://${nextApp}/0`);
        const before=await mutations();
        const refused=await page.evaluate(async ({old,token})=>{
          const send=(await import("/js/core/wallet.js")).sendTx,errors=[];
          for (const [to,data] of [[old,"0x1234"],[token,"0x095ea7b3"+old.slice(2).toLowerCase().padStart(64,"0")+"0".repeat(63)+"1"]]){
            try{await send(to,data);errors.push("unexpected success");}
            catch(e){errors.push(e.message);}
          }
          return errors;
        },{old:rig.addresses.catalog,token:rig.addresses.usdc});
        refused.forEach(error=>assert.match(error,/retired platform contract/));
        assert.equal(await mutations(),before,"old prepared target never reaches the wallet");
      }finally{delete rig.rpcModes[0];}
    });
    if (platformBook) await t.test("retired core bindings refuse signing without falling back to initial profile addresses",async()=>{
      await set("appCatalog","0x"+"0".repeat(40));
      const before=await mutations();
      const error=await page.evaluate(async()=>{
        try{await (await import("/js/core/sessions.js")).startSession({budgetUsd:0,hours:1});return "unexpected success";}
        catch(e){return e.message;}
      });
      assert.match(error,/required entry appCatalog is unset/);
      assert.equal(await mutations(),before);
      await set("appCatalog",rig.addresses.catalog);
      await page.evaluate(async()=>(await import("/js/core/independent-chain.js")).sessionAuthority());
    });
    await t.test("lost quorum refuses before a wallet prompt",async()=>{
      const before=await mutations();rig.rpcModes[0]="down";rig.rpcModes[1]="down";
      try{
        const message=await page.evaluate(async()=>{
          try{await (await import("/js/core/sessions.js")).startSession({budgetUsd:0,hours:1});return "unexpected success";}
          catch(e){return e.message;}
        });
        assert.match(message,/chain endpoints|quorum|agree/i);assert.equal(await mutations(),before);
      }finally{delete rig.rpcModes[0];delete rig.rpcModes[1];}
    });
    await t.test("owner can end the existing session and recover unused budget",async()=>{
      await page.evaluate(async()=>(await import("/js/core/sessions.js")).endSession({quiet:true}));
      const balance=await rig.pc.readContract({address:rig.addresses.usdc,abi:rig.abi.usdc,functionName:"balanceOf",args:[rig.owner]});
      assert.equal(balance,99_500000n);
    });
    assert.deepEqual(forbidden,[],"unexpected external origin");
  }finally{await browser?.close();await rig?.stop();}
});
