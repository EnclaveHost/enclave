// Dedicated host-local routing service. Never expose these management sockets
// outside loopback. Public config is selected by both absolute path and hash.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {CompositeManager,LaunchJournal} from './control.mjs';
import {checkJournalStorage,availableMemoryMiB,lockJournal} from './platform.mjs';
import {makeRequest,controlServer,dataServer} from './io.mjs';
const [file,pin,mode]=process.argv.slice(2);
if(!file||!path.isAbsolute(file)||!/^[0-9a-f]{64}$/.test(pin||''))throw Error('absolute config path and SHA256 required');
const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>65536)throw Error('config must be a bounded regular file');
const bytes=fs.readFileSync(file);if(bytes.length>65536||createHash('sha256').update(bytes).digest('hex')!==pin)throw Error('config hash differs');
const config=JSON.parse(bytes);
if(Object.keys(config).sort().join(',')!=='journal,nativePins,schema'||config.schema!=='enclave-native-router/1'||typeof config.journal!=='string'||!path.isAbsolute(config.journal))throw Error('invalid router config');
if(mode==='--reconcile'){
 const r=await fetch('http://127.0.0.1:8097/router/reconcile',{method:'POST',signal:AbortSignal.timeout(30000)});
 console.log(await r.text());process.exit(r.ok?0:1);
}
if(mode!==undefined)throw Error('unknown router operation');
await checkJournalStorage(config.journal);
const unlock=lockJournal(config.journal);process.once('exit',unlock);
const manager=new CompositeManager({request:makeRequest({legacyPort:8091,nativePort:8095}),journal:new LaunchJournal(config.journal),nativePins:config.nativePins,availableMemoryMiB});
const control=controlServer(manager),data=dataServer({legacyPort:8092,nativePort:8096});
const stop=()=>{control.close();control.closeIdleConnections();data.close();};
for(const server of [control,data.server])server.on('error',e=>{stop();console.error('router listener failed:',e.code||'unknown');process.exitCode=1;});
control.listen(8097,'127.0.0.1');data.server.listen(8098,'127.0.0.1');
process.on('SIGTERM',stop);process.on('SIGINT',stop);
console.log('Native manager router listens only on 127.0.0.1:8097/8098; existing managers retain TLS and authorization.');
