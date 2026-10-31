// Actual Windows Node -> compiled command -> native protected ledger. No VM.
import assert from 'node:assert/strict';
import { createPhysicalReservations } from './physical-reservations.mjs';
const [command,commandHash,configPath,poolHash,boot]=process.argv.slice(2);
const config={command,commandHash,configPath,poolHash,boot},p=createPhysicalReservations(config);
const claim={poolHash,boot,actor:'app-legacy',id:'a'.repeat(64),bytes:1073741824};
await p.acquire(claim);
await p.consumeStart(claim);
await assert.rejects(p.consumeStart(claim));
await assert.rejects(p.acquire({...claim,id:'b'.repeat(64),bytes:2147483648}));
await p.acquire({...claim,id:'b'.repeat(64),actor:'app-native'});
await p.consumeStart({...claim,id:'b'.repeat(64),actor:'app-native'});
await assert.rejects(createPhysicalReservations({...config,commandHash:'0'.repeat(64)}).acquire(claim));
console.log('RESULT actualNodeTransport=7 vmChanged=false');
