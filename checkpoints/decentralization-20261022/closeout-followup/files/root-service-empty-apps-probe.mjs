// Read-only source probe, disposable config, no network or production mutations.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const base=path.dirname(fileURLToPath(import.meta.url));
const source=path.join(base,'windows-host-services-compose/candidate/network');
const {runPrivacy}=await import(pathToFileURL(path.join(source,'privacy-agent.mjs')));
const {validateHostServicesTransport}=await import(pathToFileURL(path.join(source,'host-service-transport.mjs')));
const block={zone:'svc.example',exits:['e1'.repeat(16),'e2'.repeat(16)],ports:{'directory-replica':18188,'bootstrap-replica':18189,'policy-mirror':18190},dns:{tcp:18153,udp:18153}};
validateHostServicesTransport(block);
const out=path.join(base,'root-service-empty-apps-probe');await fs.mkdir(out,{recursive:true});
const temp=await fs.mkdtemp(path.join(out,'case-'));
try {
 const config={version:2,apps:[],directory:temp,enclaveNetwork:{hostServices:block}};
 const cfg=path.join(temp,'privacy-config.json');await fs.writeFile(cfg,JSON.stringify(config));
 let error=null;try{await runPrivacy(cfg);}catch(e){error=e.message;}
 assert.equal(error,'version 2 app configuration required');
 const sha=createHash('sha256').update(await fs.readFile(path.join(source,'privacy-agent.mjs'))).digest('hex');
 const result={at:new Date().toISOString(),sourceSha256:sha,validHostServicesShape:true,apps:0,error,scope:'The source rejects an empty app list before validating or starting otherwise well-shaped hostServices. This is a source-level cold-start gate, not a production outage test or proof that all other service configuration is valid.'};
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally {await fs.rm(temp,{recursive:true,force:true});}
