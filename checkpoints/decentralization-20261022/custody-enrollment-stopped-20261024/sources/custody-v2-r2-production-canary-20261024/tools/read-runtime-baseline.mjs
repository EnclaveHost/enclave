// Read-only Linux observations. No process environment, argv, secrets or state contents are output.
import {linuxRuntimeIO} from '../driver/launch-runtime.mjs';
const io=linuxRuntimeIO(),s=io.snapshot();
const testUnit=io.unit('enclave-custody-r2-20261024T030000Z.service');
console.log(JSON.stringify({at:new Date(s.at).toISOString(),readOnly:true,memAvailableMiB:s.memAvailableMiB,
 protectedServices:Object.fromEntries(Object.entries(s.units).map(([n,u])=>[n,{pid:u.main.pid,startTicks:u.main.startTicks,invocation:u.invocation}])),
 runningQemuCount:s.qemus.length,exampleUnitAbsent:testUnit.LoadState==='not-found',
 scope:'Current host inventory only; no launch, key read or SNP claim.'},null,2));
