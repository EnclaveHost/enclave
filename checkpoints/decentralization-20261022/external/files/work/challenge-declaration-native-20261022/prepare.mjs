import fs from 'node:fs';
import {CHAIN_PS,evaluateDeclarationChain} from '../challenge-host-tls-20261021/tree/network/host-services/service-tls.mjs';
const p=new URL('./',import.meta.url);
if(process.argv[2]==='evaluate'){
 const result=JSON.parse(fs.readFileSync(new URL('native.json',p)));const v=result.validation;
 if(!v?.pass||v.probe.sid!=='S-1-5-19')throw Error('native probe incomplete');
 // Windows PowerShell 5.1 adds a Count note property when reserializing ConvertFrom-Json arrays.
 // Preserve the native receipt; unwrap only this exact wrapper, checking its length before judging every ACE.
 const chain=name=>{const c=v.probe.chains[name];if(Array.isArray(c))return c;
   if(c&&Object.keys(c).sort().join(',')==='Count,value'&&Array.isArray(c.value)&&c.Count===c.value.length)return c.value;
   throw Error('unexpected native chain serialization');};
 const good=evaluateDeclarationChain(chain('good.json'));
 const absent=evaluateDeclarationChain(chain('absent.json'));
 let refusal;try{evaluateDeclarationChain(chain('unsafe.json'))}catch(e){refusal=e.message}
 if(!refusal?.includes('read its proof key'))throw Error('negative control not refused for the intended reason');
 fs.writeFileSync(new URL('verdict.json',p),JSON.stringify({pass:true,localService:true,good,absent,unsafeRefusal:refusal,cleanup:result.cleanup,productionAclChanges:false},null,2)+'\n');
 console.log(JSON.stringify({pass:true,localService:true,positiveCases:2,negativeCases:1,cleanup:result.cleanup}));
}else{fs.writeFileSync(new URL('chain.txt',p),CHAIN_PS)}
