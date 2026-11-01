// Private test directory only; the parent preholds this exact child process.
import { ownHostLifecycleJournals } from '../../network/deployment-host-journal-owner.mjs';
const hostId='0x'+'11'.repeat(32),app='0x'+'22'.repeat(32),digest='0x'+'33'.repeat(32);
const owner=await ownHostLifecycleJournals(process.argv[2],{hostId,initialize:true});
owner.journal.holdHostLocal(hostId,app,{why:'retained-child-hold',at:10});
owner.journal.prepareTransition(app,{digest,payload:'{"unsettled":true}'});
process.send('ready');setInterval(()=>{},1000);
