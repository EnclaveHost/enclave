import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const here=new URL('.',import.meta.url);
const src=fs.readFileSync(new URL('linux-wallet-unknown/candidate/supervisor.js',here),'utf8');
const a=src.indexOf('const _walletWithdrawn=new Map();');
const b=src.indexOf('// Is this record',a);
if(a<0||b<a)throw Error('source marker changed');
const sandbox={Date,deployments:new Map()};vm.createContext(sandbox);
vm.runInContext(src.slice(a,b)+'\nglobalThis.api={noteWalletWithdrawn,walletSendGate};',sandbox);
const id='0x'+'42'.repeat(32);
const allowedUntil=Date.now()+60_000;
// Existing tryClaim obtains allow, then awaits openForUs, then constructs its send gate.
// Another decision can withdraw permission during that await.
sandbox.api.noteWalletWithdrawn(id);
const lateConstructed=sandbox.api.walletSendGate(null,allowedUntil,id)();
// Control: taking the gate before the withdrawal catches the change.
const before=sandbox.api.walletSendGate(null,allowedUntil,id);
sandbox.api.noteWalletWithdrawn(id);
const previouslyCaptured=before();
const out={at:new Date().toISOString(),sourceSha256:crypto.createHash('sha256').update(src).digest('hex'),gateConstructedAfterWithdrawal:lateConstructed,gateConstructedBeforeWithdrawal:previouslyCaptured,note:'Actual candidate gate functions in vm, synthetic allow->await->withdrawal->gate ordering visible in tryClaim. Not a production transaction or full tryClaim execution.'};
fs.writeFileSync(new URL('root-linux-decision-window-result.json',here),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
