// Counterexample (reviewer, isolated): privacy-agent.mjs awaits hostServices.start() inside the agent's startup try-block;
// start() awaits the first reconcile(), whose providers() throws "all public directories unavailable" when every
// directory is down. Expected for "refuse HOST SERVICES only, apps unaffected": start() must not reject; the periodic
// reconcile retries. Runs against the reviewed snapshot (snap/).
import test from 'node:test';
import assert from 'node:assert/strict';
import {HostServiceTransport} from '../snap/network/host-service-transport.mjs';
const config={zone:'app.enclave.host',exits:['a'.repeat(32)],ports:{'directory-replica':18188}};
test('host-service start() with every directory unreachable does not reject (apps must not be taken down)',async()=>{
  const t=new HostServiceTransport({runtime:{},grants:{},hostId:'0x'+'11'.repeat(32),config,log:()=>{},
    providers:async()=>{throw new Error('all public directories unavailable: fetch failed');}});
  try{await assert.doesNotReject(t.start());}finally{await t.close();}
});
