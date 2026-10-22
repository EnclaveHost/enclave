// Local injected Windows ACL reproduction. No network, real ACL changes, or keys.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const url=new URL('./tree/network/host-services/service-tls.mjs',import.meta.url);
const pin='a4adfcfb3502cc9ddc702f7efbbb4da713a15fcc19fdeb211fd7082e1b523b94';
assert.equal(createHash('sha256').update(fs.readFileSync(url)).digest('hex'),pin,'source changed; review the new version');
const {checkDeclarationFile,evaluateDeclarationAcl}=await import(url);
const file='/fixture/declaration.json', calls=[];
const safe={owner:'S-1-5-18',rules:[{sid:'S-1-5-18',allow:true,rights:2032127}]};
const unsafe={...safe,rules:[...safe.rules,{sid:'S-1-5-32-545',allow:true,rights:2}]};
const readResult=await checkDeclarationFile(file,{platform:'win32',
 fsx:{lstatSync:p=>({isDirectory:()=>p===path.dirname(file),isFile:()=>p===file,isSymbolicLink:()=>false})},
 windowsAcl:async p=>{calls.push(p);return p===file?unsafe:safe;}});
const broadReadAccepted=evaluateDeclarationAcl({...safe,rules:[...safe.rules,{sid:'S-1-5-32-545',allow:true,rights:1179785}]});
const result={at:new Date().toISOString(),sourceSha256:pin,scope:'Injected Windows file-system/ACL fixture; no native or production changes',
 fileACLWasInspected:calls.includes(file),unsafeFileAccepted:!!readResult,broadReadersAccepted:!!broadReadAccepted,
 result:'REPRODUCED: parent ACL alone accepts an uninspected writable declaration file and untrusted read access',
 limitations:'This proves validator behavior, not a live exploit. Local process identity and secret confidentiality require the delegated repair.'};
assert.equal(result.fileACLWasInspected,false);assert.equal(result.unsafeFileAccepted,true);assert.equal(result.broadReadersAccepted,true);
fs.writeFileSync(new URL('../../outputs/decentralization-audit/challenge-declaration-review.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
