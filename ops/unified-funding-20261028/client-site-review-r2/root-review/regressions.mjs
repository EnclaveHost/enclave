import test from "node:test";
import assert from "node:assert/strict";
import * as ST from "../authored/site/js/funding/state.js";
const owner="0x"+"11".repeat(20), vault="0x"+"22".repeat(20), legacyVault="0x"+"33".repeat(20);
const ctx=ST.contextOf({owner,vault,legacyVault,chainId:8453,relay:"https://one.invalid"});
const plan={id:"migration:test",kind:"migration",v:3,termsHash:"hash",terms:{owner,chainId:8453,legacy:{vault:legacyVault,oldSid:"sid"},gas:{vault},order:["terminate","legacyOpen"]},steps:{terminate:{status:"proven",recheck:{result:"lost"},review:{digest:"a",message:{signBefore:"9999"}}},legacyOpen:{status:"planned",review:{digest:"b",grant:{signBefore:"9999"}}}}};
test("lost prior proof prevents offering any later signature",()=>assert.deepEqual(ST.nextSignable(plan,1n),[]));
test("admitted step cannot reuse held signatures",()=>{const p=structuredClone(plan);p.steps.terminate={status:"planned",review:{digest:"a"}};const m=ST.createMemory();m.bind(ctx);m.holdSigned(ctx,p,["terminate"],{signature:"test"});p.steps.terminate.status="admitted";assert.equal(m.signedFor(ctx,p),null);});
test("plan missing relay binding is not silently adopted at a different relay",()=>{const c=ST.contextOf({...ctx,relay:"https://two.invalid"});assert.deepEqual(ST.selectPlans([plan],c,"sid"),[]);});
