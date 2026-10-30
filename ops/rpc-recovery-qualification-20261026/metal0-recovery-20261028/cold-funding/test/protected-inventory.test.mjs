import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {PROTECTED_IDS,requireProtectedInventory} from '../lib/protected-inventory.mjs';
test('production incident cannot omit either original deployment, including expired ones',()=>{
 for(const rows of [null,[],[{id:PROTECTED_IDS[0]}],[{id:PROTECTED_IDS[0]},{id:PROTECTED_IDS[0]}],[{id:PROTECTED_IDS[0]},{id:'0x'+'aa'.repeat(32)}],[...PROTECTED_IDS.map(id=>({id})),{id:'extra'}]])assert.throws(()=>requireProtectedInventory({leases:rows}));
 assert.doesNotThrow(()=>requireProtectedInventory({leases:PROTECTED_IDS.map(id=>({id,expiry:0}))})); // Timing enforcement stays in prepare, never reclassified as no lease.
});
test('actual preparation CLI refuses empty inventory before issuing any RPC',t=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'metal0-inventory-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));const f=path.join(d,'quiesce.json');fs.writeFileSync(f,JSON.stringify({providedBy:'root',leases:[]}));
 const r=spawnSync(process.execPath,['bin/prepare.mjs','--quiesce',f],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:3000});assert.equal(r.status,1);assert.match(r.stderr,/Both original metal0 deployments/);
});
