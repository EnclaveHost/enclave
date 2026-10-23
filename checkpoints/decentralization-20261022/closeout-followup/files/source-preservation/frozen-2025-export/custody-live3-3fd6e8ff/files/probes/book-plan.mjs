// Read-only simulations. No signing or broadcast capability.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {parseAbi,encodeFunctionData,stringToHex,keccak256} from 'viem';
import {pinBlock,codeAt,readMany,agree,rpc,LIVE} from '../lib/live.mjs';
const book='0xab214342d5a490150a4a977063a2f88e21f80907',vault='0xe48699b8401564aace7a814ae4569b67a3f7eef5',admin='0x0b2d009c0c9af05b12100d77f3c815fea822ee61',zero='0x'+'00'.repeat(20);
const abi=parseAbi(['function owner() view returns(address)','function addr(bytes32) view returns(address)','function set(bytes32,address)']);const key=stringToHex('secretVaultV2',{size:32});
const block=await pinBlock();const tag='0x'+block.number.toString(16);
const [owner,current]=await readMany(block,[{address:book,abi,functionName:'owner'},{address:book,abi,functionName:'addr',args:[key]}]);assert.equal(owner.value.toLowerCase(),admin);assert.equal(current.value.toLowerCase(),zero);
const codeHash=keccak256(await codeAt(block,vault));assert.equal(codeHash,'0x4b949b378382d7fa862e7bc1552b58547ce811527c9746f4d9a0d39a8b4f716b');
const transaction={chainId:'0x2105',from:admin,to:book,value:'0x0',data:encodeFunctionData({abi,functionName:'set',args:[key,vault]})};
assert.equal(await agree('eth_call',[transaction,tag]),'0x');
const rejection=await Promise.all(LIVE.state.map(async u=>{try{await rpc(u,'eth_call',[{...transaction,from:'0x'+'19'.repeat(20)},tag]);return false}catch(e){return /revert/i.test(e.message)}}));assert.ok(rejection.every(Boolean));
const out={at:new Date().toISOString(),status:'UNSIGNED — do not activate until lifecycle canaries and dashboard integration pass',block,providers:LIVE.state,expectedBefore:{owner:admin,secretVaultV2:zero,vaultCodeHash:codeHash},effect:'Publish the existing original custody v2 vault through the administrator-controlled address book. No contract replacement, committee migration, secret transfer or change to administrator rights.',transaction,simulation:{adminSetSucceeded:true,unauthorizedSetRejected:rejection},rollback:{chainId:'0x2105',from:admin,to:book,value:'0x0',data:encodeFunctionData({abi,functionName:'set',args:[key,zero]})},rollbackLimit:'Removing discovery does not undo policies or encrypted bundles already stored, and older clients with hardcoded vault defaults can still resolve it.',signing:'Administrator wallet signature and gas required; nonce, fees, simulation and current authority must be refreshed immediately before signing.'};
fs.writeFileSync(new URL('../evidence/book-activation-unsigned-20261023.json',import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log(JSON.stringify({at:out.at,block:String(block.number),adminSetSucceeded:true,unauthorizedSetRejected:rejection}));
