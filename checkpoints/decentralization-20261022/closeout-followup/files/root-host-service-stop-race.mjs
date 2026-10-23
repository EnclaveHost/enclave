import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HostServiceTransport } from './windows-host-services-compose/candidate/network/host-service-transport.mjs';

const source = new URL('./windows-host-services-compose/candidate/network/host-service-transport.mjs', import.meta.url);
const provider = (id, address, roles) => ({providerId:id, address, eligibleRoles:roles,
  pricePerGiB6:0, qualifiedUntil:Date.now()+60000, wgExitKey:'exit-test', wgGuardKey:'guard-test'});
const exit = provider('e1'.repeat(16),'192.0.2.1',['ingress']);
const guard = provider('a1'.repeat(16),'192.0.2.2',['guard']);
let begin, release, options, circuit, revokes = 0;
const began = new Promise(resolve => begin=resolve);
const runtime = { start: async opts => {
  options=opts; begin();
  await new Promise(resolve => release=resolve);
  circuit=Object.assign(new EventEmitter(), {closed:false,providers:{guard:opts.guard,exit:opts.exit},
    service:{control:'127.0.0.1:1',exitKey:'test'},close:async()=>{circuit.closed=true;}});
  return circuit;
}};
const transport = new HostServiceTransport({runtime, providers:async()=>[guard,exit],
  grants:{revoke:async()=>{revokes++;}},hostId:'0x'+'a1'.repeat(32),
  config:{zone:'svc.example',exits:[exit.providerId],ports:{'directory-replica':18188}}});
const starting=transport.start();
await began;
await transport.close();
release();
await starting;
const result={at:new Date().toISOString(),sourceSha256:createHash('sha256').update(await fs.readFile(source)).digest('hex'),
  transportClosed:transport.closed,authorizationGateAfterClose:options.gate(),
  returnedCircuitClosed:circuit.closed,circuitsAfterClose:transport.circuits.size,
  revokesBeforeCleanup:revokes,timerCreatedAfterClose:!!transport.timer,
  limitation:'Actual HostServiceTransport with a deferred runtime seam; no real WireGuard process, network grant or production claim. Actual WgCircuitRuntime checks its own closure, but uses the supplied gate only for app broker/egress, not host-service startup.'};
await transport.close();
await fs.writeFile(new URL('./root-host-service-stop-race-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
