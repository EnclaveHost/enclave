// The replacement text of signers-bundles.py, run by itself against viem: the same signer as viem's own
// recoverMessageAddress, remembered on the second call, the loop not held, non-string messages passed through.
//   node replacement-check.mjs   (from the repository root)
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {recoverAddress,hashMessage,recoverMessageAddress} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
const py=`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('b',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps([m.MIN[1],m.HS[1]]))`;
const [min,hs]=JSON.parse(execFileSync('python3',['-c',py,new URL('../signers-bundles.py',import.meta.url).pathname],{encoding:'utf8'}));
const a=privateKeyToAccount(generatePrivateKey());
for(const [name,text,fn,args] of [['minified',min,'Ye',['Zo','_t']],['host-services',hs,'recoverMessageAddress',['recoverAddress','hashMessage']]]){
  let calls=0;const rec=async x=>{calls++;return recoverAddress(x);};
  const f=new Function(...args,text+';return '+fn)(rec,hashMessage);
  const signed=[];for(let i=0;i<12;i++)signed.push(['m'+i,await a.signMessage({message:'m'+i})]);
  let turns=0,stop=false;const spin=()=>{turns++;if(!stop)setImmediate(spin);};setImmediate(spin);
  for(const [message,signature] of signed)assert.equal(await f({message,signature}),await recoverMessageAddress({message,signature}));
  assert.equal(calls,12);assert.ok(turns>=12,'the loop ran '+turns+' times');
  for(const [message,signature] of signed)assert.equal(await f({message,signature}),a.address);
  assert.equal(calls,12,'remembered');stop=true;
  assert.notEqual(await f({message:'other',signature:signed[0][1]}),a.address);
  const raw={raw:'0x1234'},sr=await a.signMessage({message:raw});
  assert.equal(await f({message:raw,signature:sr}),a.address);assert.equal(await f({message:raw,signature:sr}),a.address);assert.equal(calls,15,'a non-string message is not remembered');
  await assert.rejects(f({message:'m0',signature:'0x00'}));
  console.log('PASS',name);
}
