// Start explicitly only after release review: node serve-reserve.mjs --serve
// This process prepares requests and verifies receipts; MetaMask owns signing and broadcasting.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createPublicClient,http} from '../enclave/node_modules/viem/_esm/index.js';
import {reserveRequest} from './request.mjs';
import {verifyReserve} from './verify-reserve.mjs';
import {createHandoffServer,fileJournal} from './handoff-server.mjs';
if(process.argv.length!==3||process.argv[2]!=='--serve')throw Error('Explicit --serve is required after release review. This command does not sign or submit transactions.');
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..'),run=promisify(execFile);
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p)));
const urls=['https://base-rpc.publicnode.com','https://mainnet.base.org'];
const clients=urls.map(url=>createPublicClient({transport:http(url,{timeout:15000,retryCount:0})}));
const loadRequest=()=>reserveRequest({
 pre:read('outputs/app-lease-gas-review/production-funding-preflight.json'),
 draft:read('work/lease-gas-production-preflight/reserve-creation-draft.json'),
 simulation:read('work/lease-gas-production-preflight/multicall-simulation.json'),
 mainSourceHash:createHash('sha256').update(fs.readFileSync(path.join(root,'work/enclave/contracts/EnclaveLeaseGasReserve.sol'))).digest('hex'),
});
const draft=read('work/lease-gas-production-preflight/reserve-creation-draft.json');
const initialRequest={purpose:'Create application lease gas reserve; no app deposits',transaction:{from:draft.from,chainId:'0x2105',data:draft.creationData,value:'0x0'}};
const prepare=async()=>{
 for(const script of ['read.mjs','simulate.mjs'])await run(process.execPath,[path.join(root,'work/lease-gas-production-preflight',script)],{cwd:root,timeout:90000,maxBuffer:1024*1024});
 const request=loadRequest();
 const nonces=await Promise.all(clients.map(c=>c.getTransactionCount({address:request.transaction.from,blockTag:'pending'})));
 assert.ok(nonces.every(n=>BigInt(n)===BigInt(request.transaction.nonce)),'pending nonce differs from simulation; inspect outstanding transactions');
 assert.ok(Date.now()<Date.parse(request.expiresAt),'preparation expired');
 return request;
};
const app=createHandoffServer({initialRequest,prepare,verify:(request,hash)=>verifyReserve({request,hash,clients}),journal:fileJournal(path.join(here,'reserve-handoff-state.json')),
 assets:{'/':{type:'text/html',body:fs.readFileSync(path.join(here,'reserve.html'),'utf8')},
 '/app.js':{type:'text/javascript',body:fs.readFileSync(path.join(here,'app.js'),'utf8')},
 '/style.css':{type:'text/css',body:fs.readFileSync(path.join(root,'work/metamask-bridge/style.css'),'utf8')}}});
console.log(JSON.stringify({url:await app.listen(),status:app.state.status,purpose:'Reserve contract creation, zero ETH deposit; wallet confirmation required'}));
