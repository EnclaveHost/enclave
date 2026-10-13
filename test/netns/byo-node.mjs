// netns e2e helper: the host's real WgCircuitRuntime with a BYO WireGuard config (parsed by network/wg-config.mjs, the
// same parser the browser and relay use); prints the circuit's egress entry.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {WgCircuitRuntime} from '../../network/wg-circuit-runtime.mjs';
import {parseWireGuardConfig} from '../../network/wg-config.mjs';
const [wgBinary,configFile]=process.argv.slice(2);
const {config}=parseWireGuardConfig(fs.readFileSync(configFile,'utf8'));
const runtime=new WgCircuitRuntime({directory:fs.mkdtempSync(path.join(os.tmpdir(),'wgbyo-')),wgBinary,nodeBinary:process.execPath,
 workerModule:path.resolve('network/windows-circuit-worker.mjs'),platform:'plain',authorize:()=>true,forward:()=>{},log:m=>console.error('[byo]',m)});
const c=await runtime.start({deploymentId:'0x'+'ab'.repeat(32),names:[],kind:'byo',byo:{...config,endpoint:{address:config.endpoint.host,port:config.endpoint.port}},egress:true});
c.on('down',r=>{console.error('[byo] circuit down:',r);});
console.log(JSON.stringify({egress:c.egress,transport:c.transport}));
setInterval(()=>{},1e9);
