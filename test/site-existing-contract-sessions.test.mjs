import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {stringToHex,encodeFunctionData} from "viem";
import {startRig,haveTools,walletScript,KEYS} from "./helpers/independent-browser-rig.mjs";
const require=createRequire(new URL("../e2e/package.json",import.meta.url));
let chromium;try{({chromium}=require("playwright"));}catch{}
const skip=haveTools()||(!chromium&&"Playwright unavailable");
// Public Anvil fixture key; never a production wallet.
const ADMIN="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

for (const platformBook of [false,true])
test("browser sessions reuse existing contracts: " + (platformBook ? "admin-controlled address book" : "fixed profile"), {skip:skip||false,timeout:300000}, async t=>{
  let rig,browser;
  const forbidden=[];
  try{
    rig=await startRig({legacySessionFactory:true});
    if (platformBook){
      rig.profile.addressBook=rig.addresses.book;
      // as scripts/network/browser-profile.mjs --ledger-history-from writes it at this block: no ledger replaced yet. Later
      // replacements reach a cold tab only through the book's own history (js/core/platform-addresses.js scanLedgerHistory)
      rig.profile.ledgerHistory={through:String(await rig.pc.getBlockNumber()),ledgers:[]};
    }
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
    // ledger replacement: the original ledger keeps its records; `own` is the wallet's own record there
    const ZERO="0x"+"0".repeat(40),L=rig.abi.ledger,old=rig.addresses.ledger;let next,own;
    const mine=async()=>{for(let i=0;i<3;i++)await rig.pc.request({method:"evm_mine",params:[]});};
    const refundable=(id,ledger=old)=>rig.pc.readContract({address:ledger,abi:L,functionName:"refundableOf",args:[id]});
    // what the dashboard lists: one row per record, every replaced-ledger holding with its owner there
    const listing=()=>page.evaluate(async()=>{
      const E=(await import("/js/core/api.js")).Enclave;
      // a reload restores the wallet address while the dashboard re-checks the injected wallet
      for(const end=Date.now()+30000;!E.address&&Date.now()<end;)await new Promise(r=>setTimeout(r,200));
      const rows=await E.listDeployments();
      return {replaced:rows.independentScan?.replaced,history:rows.independentScan?.ledgerHistory,rows:rows.map(r=>({id:String(r.id).toLowerCase(),ledger:r.retiredLedger||"",
        held:(r.replacedHoldings||[]).map(h=>({ledger:h.ledger,owner:h.owner,retired:h.ledgerRetired,refundable6:h.refundable6}))}))};
    });
    const note=(id,ledger)=>page.locator(`.enc-retired[data-rid="${id}"][data-ledger="${ledger.toLowerCase()}"]`);
    const recover=(id,ledger)=>page.locator(`.enc-rrefund[data-id="${id}"][data-ledger="${ledger.toLowerCase()}"]`);
    const usdcOf=a=>rig.pc.readContract({address:rig.addresses.usdc,abi:rig.abi.usdc,functionName:"balanceOf",args:[a]});
    const until=async(fn,what)=>{
      for(const end=Date.now()+60000;Date.now()<end;await new Promise(r=>setTimeout(r,500)))if(await fn())return;
      throw new Error("timed out: "+what+"; "+await page.evaluate(()=>[...document.querySelectorAll(".enc-retired")].map(e=>e.textContent).join(" | ")));
    };
    const fresh=async()=>{
      await page.goto(rig.site+"/dashboard");
      await page.waitForFunction(async()=>{const E=(await import("/js/core/api.js")).Enclave;return !!(E.provider&&E.address);});
    };
    // every non-recovery call to a replaced ledger (and an allowance for it) stops before the wallet
    const refusesOld=async(ledger=old)=>{
      const before=await mutations(),refund=encodeFunctionData({abi:L,functionName:"refund",args:[own]});
      const calls=[[ledger,encodeFunctionData({abi:L,functionName:"create",args:[`catalog://${appId}/0`,0,100,8080,"",true,"",ZERO,0n,100n]})],
        [ledger,encodeFunctionData({abi:L,functionName:"fund",args:[own,1n]})],
        [ledger,encodeFunctionData({abi:L,functionName:"setActive",args:[own,true]})],
        [ledger,refund+"00".repeat(32)],
        [rig.addresses.usdc,encodeFunctionData({abi:rig.abi.usdc,functionName:"approve",args:[ledger,1n]})]];
      const errors=await page.evaluate(async calls=>{
        const send=(await import("/js/core/wallet.js")).sendTx,out=[];
        for(const [to,data] of calls){try{await send(to,data);out.push("unexpected success");}catch(e){out.push(e.message);}}
        return out;
      },calls);
      errors.forEach(e=>assert.match(e,/retired platform contract/));
      assert.equal(await mutations(),before,"no refused call reaches the wallet");
    };
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
    if (platformBook) await t.test("administrator replaces the ledger: the existing grant creates on the new one; the old one is recovery-only",async()=>{
      await rig.write(rig.wc(KEYS.owner),old,L,"create",[`catalog://${appId}/0`,0,100,8080,"",true,"",ZERO,0n,100n]);
      const n=await rig.pc.readContract({address:old,abi:L,functionName:"count"});
      own=(await rig.pc.readContract({address:old,abi:L,functionName:"getPage",args:[0n,n]}))
        .find(x=>x.owner.toLowerCase()===rig.owner.toLowerCase()).id.toLowerCase();
      // the platform's migration procedure (contracts/deployments/ledger-15d-base.json): the replacement imports every
      // record verbatim, ids included, so create() there skips them and no vault custody record is ever overwritten
      const records=await rig.pc.readContract({address:old,abi:L,functionName:"getPage",args:[0n,n]});
      next=await rig.migrateLedger(old);
      await set("deployments",next);
      rig.rpcModes[0]="down";
      try{
        await page.evaluate(async ref=>(await import("/js/core/sessions.js")).sessionCall("deploy.create",
          {appRef:ref,gpuMilli:0,cpuMilli:100,appPort:8080,ports:"",isPublic:true,configCid:"",
            maxRate6:100n,env:"staging",fund6:0n}),`catalog://${appId}/0`);
        const state=await page.evaluate(async()=>{
          const C=await import("/js/core/config.js"),S=await import("/js/core/sessions.js");
          return {ledger:C.DEPLOYMENTS_ADDRESS,initial:C.INDEPENDENT.profile.contracts.deployments,
            sid:(await S.currentSession()).session.handle.sid};
        });
        assert.equal(state.ledger,next.toLowerCase());
        assert.equal(state.initial,old.toLowerCase(),"no profile rewrite");
        assert.equal(state.sid,opened.sid,"the existing grant acts on the admin-selected ledger");
        const total=await rig.pc.readContract({address:next,abi:L,functionName:"count"});
        assert.equal(total,BigInt(records.length)+1n);
        const [made]=await rig.pc.readContract({address:next,abi:L,functionName:"getPage",args:[total-1n,1n]});
        assert.equal(made.owner.toLowerCase(),opened.vault.toLowerCase());
        assert.ok(!records.some(r=>r.id===made.id),"a fresh id, never an imported one");
        // one row per record: the carried-over row, with what the replaced ledger still holds for it attached
        const listed=await listing();
        const mine=records.filter(r=>[rig.owner,opened.vault].some(a=>a.toLowerCase()===r.owner.toLowerCase()));
        assert.ok(mine.length>=2);
        assert.equal(listed.replaced,mine.length,"every record of the wallet and its vault on the replaced ledger");
        for (const r of mine) assert.equal(listed.rows.filter(x=>x.id===r.id.toLowerCase()).length,1,"one row per carried-over record");
        assert.equal(listed.history.complete,true,"the book's history since the profile was read");
        assert.deepEqual(listed.rows.find(r=>r.id===own),{id:own,ledger:"",
          held:[{ledger:old.toLowerCase(),owner:rig.owner.toLowerCase(),retired:false,refundable6:"0"}]},"nothing to recover yet");
        const vaultRow=listed.rows.find(r=>r.id===row.id.toLowerCase());
        assert.equal(vaultRow.ledger,"");
        assert.deepEqual(vaultRow.held,[{ledger:old.toLowerCase(),owner:opened.vault.toLowerCase(),retired:false,refundable6:String(await refundable(row.id))}]);
      }finally{delete rig.rpcModes[0];}
      await refusesOld();
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
    if (platformBook) await t.test("replaced ledgers: each holding by its owner THERE, one per ledger, found by a cold tab; owner recovery, then anyone's once retired",async()=>{
      const wallet=rig.wc(KEYS.owner),vault=opened.vault.toLowerCase(),me=rig.owner.toLowerCase();
      // on the current ledger (L1, migrated with runner rates) the wallet hands its imported record to its own vault: the record's owner differs per
      // ledger from here on (wallet on L0, vault on L1); then both ledgers hold money for it (fixture funding: the
      // browser itself refuses to fund a replaced ledger)
      await rig.write(wallet,next,L,"transferDeployment",[own,opened.vault]);
      // (fundFor names the beneficiary: the ledger credits refundable escrow only to the record's owner there)
      for (const [ledger,amount,payer] of [[next,300000n,opened.vault],[old,400000n,rig.owner]]){
        await rig.write(wallet,rig.addresses.usdc,rig.abi.usdc,"approve",[ledger,amount]);
        await rig.write(wallet,ledger,L,"fundFor",[own,amount,payer]);
      }
      // the administrator migrates again (L1 -> L2, importing L1's records)
      const third=await rig.migrateLedger(next);
      await set("deployments",third);
      const back0=await refundable(own),back1=await refundable(own,next);
      assert.ok(back0>0n&&back1>0n);
      // a COLD tab: the profile pins L0 and its history ends before L1 existed; L1 is found in the book's own history
      await fresh();
      const listed=await listing();
      assert.equal(listed.history.complete,true);
      assert.deepEqual(listed.rows.find(r=>r.id===own).held,[
        {ledger:old.toLowerCase(),owner:me,retired:false,refundable6:String(back0)},
        {ledger:next.toLowerCase(),owner:vault,retired:false,refundable6:String(back1)}],"both ledgers' balances, each with its owner there");
      // L0: the wallet owned it there (though its vault holds the record now) - the wallet may refund
      await recover(own,old).waitFor({timeout:60000});
      // L1: the vault owned it there (though the wallet's dashboard lists it) - no button that the ledger would refuse
      assert.match(await note(own,next).textContent(),/only that owner can refund it/);
      assert.equal(await note(own,next).locator(".enc-rrefund").count(),0);
      assert.equal(await note(row.id.toLowerCase(),old).locator(".enc-rrefund").count(),0,"the vault's record on L0 likewise");
      await refusesOld(old);await refusesOld(next);
      const before=await usdcOf(rig.owner),sent=await mutations();
      await recover(own,old).click();
      await until(async()=>(await usdcOf(rig.owner))===before+back0,"owner refund on L0");
      assert.equal(await mutations(),sent+1,"one wallet transaction");
      // the refresh after that refund keeps the other ledger's balance in view
      await page.waitForFunction(id=>!document.querySelector(`.enc-rrefund[data-id="${id}"]`),own);
      await note(own,next).waitFor({timeout:60000});
      assert.match(await note(own,next).textContent(),new RegExp((Number(back1)/1e6).toFixed(2)+" USDC is refundable there"));
      // the administrator retires L1: anyone may push its refund, which pays the owner THERE (the vault)
      await rig.write(admin,next,L,"retire",[]);
      await mine();
      await fresh();
      const vault0=await usdcOf(opened.vault),owner0=await usdcOf(rig.owner);
      await recover(own,next).click({timeout:60000});
      await until(async()=>(await usdcOf(opened.vault))===vault0+back1,"vault refund on L1");
      assert.equal(await usdcOf(rig.owner),owner0,"the refund pays the record's owner there, never the sender");
      // and L0 retired too: the vault's own record there
      await rig.write(admin,old,L,"retire",[]);
      await mine();
      const vaultBack=await refundable(row.id);assert.ok(vaultBack>0n);
      await fresh();
      const vault1=await usdcOf(opened.vault);
      await recover(row.id.toLowerCase(),old).click({timeout:60000});
      await until(async()=>(await usdcOf(opened.vault))===vault1+vaultBack,"vault refund on L0");
      await refusesOld(old);await refusesOld(next);
    });
    assert.deepEqual(forbidden,[],"unexpected external origin");
  }finally{await browser?.close();await rig?.stop();}
});
