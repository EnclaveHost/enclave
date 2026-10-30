// SOURCE ONLY. Owned synthetic child; never start against live state or a real RPC.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [profileFile, mode, dir, portText, marker] = process.argv.slice(2);
const profile=JSON.parse(fs.readFileSync(profileFile));
if (!profile.syntheticOnly || !dir.startsWith(profile.ownedRoot+'/') || !/^\d+$/.test(portText)) throw Error('fixture boundary');
const port=Number(portText), emit=x=>fs.writeSync(1,JSON.stringify(x)+'\n');
const {TxQueue}=await import(pathToFileURL(profile.sessions));
const {JsonStore}=await import(pathToFileURL(profile.store));
const {createWalletClient,http,parseTransaction}=await import(pathToFileURL(profile.viemIndex));
const {privateKeyToAccount}=await import(pathToFileURL(profile.viemAccounts));
// Public Anvil TEST key, never a real account grant or production environment.
const account=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const chain={id:31337,name:'owned TEST only',nativeCurrency:{name:'TEST',symbol:'TEST',decimals:18},rpcUrls:{default:{http:[`http://127.0.0.1:${port}`]}}};
const wallet=createWalletClient({account,chain,transport:http(`http://127.0.0.1:${port}`,{retryCount:0,timeout:10000})});
const file=path.join(dir,'sessions-relayer.json');
// TEST instrumentation only. Supplies attributed successful-rename evidence to
// qualify the predicate; NOT a production observer or production source profile.
let inSignal=false;
process.prependListener('SIGTERM',()=>{inSignal=true;});
const originalRename=fs.renameSync;
fs.renameSync=function(a,b){const out=originalRename.call(fs,a,b);if(b===file)emit({event:'journalRename',duringSignal:inSignal});return out;};
const journal=new JsonStore(file,{txs:[]},{durable:true});
let socket, exitBytes;
if(mode==='G_exit_send') {
  socket=net.connect(port,'127.0.0.1');
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  const tx=await account.signTransaction({chainId:31337,type:'eip1559',nonce:99,to:'0x0000000000000000000000000000000000000001',gas:21000n,maxFeePerGas:1000000000n,maxPriorityFeePerGas:1n,value:0n});
  if(parseTransaction(tx).nonce!==99) throw Error('TEST nonce');
  const body=JSON.stringify({jsonrpc:'2.0',id:99,method:'eth_sendRawTransaction',params:[tx]});
  exitBytes=Buffer.from(`POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  process.on('exit',()=>fs.writeSync(socket._handle.fd,exitBytes)); // Deliberate invalid profile, owned TEST socket only.
}
if(mode.startsWith('F_')) journal.data.txs=Array.from({length:500},(_,i)=>({nonce:i+1000,to:'0x0000000000000000000000000000000000000001',label:'TEST prior',hashes:[],status:i===0?'sending':'mined',at:0}));
// This old snapshot must never be mistaken for the final checkpoint.
if(mode==='D_write_fail'||mode==='D_rename_fail') {journal.data.fixtureMarker='old';journal.flush();}
journal.data.fixtureMarker='pre-signal';
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
 input+=chunk;if(input.length>512)throw Error('control bound');
 if(!input.endsWith('\n'))return;
 const command=JSON.parse(input);input='';
 if(command.action!=='arm-final'||command.marker!==marker)throw Error('control command');
 journal.data.fixtureMarker=marker;
 if(mode==='D_stale_same') {journal.flush();fs.mkdirSync(file+'.tmp');}
 emit({event:'armed'});
});
const forever=()=>new Promise(()=>{});
let receiptCalls=0;
const pc={
 estimateGas:async()=>mode==='A_pre_record'?forever():21000n,
 getBlock:async()=>({baseFeePerGas:1n}), estimateMaxPriorityFeePerGas:async()=>1n,
 getTransactionCount:async()=>0,
 waitForTransactionReceipt:async()=>{if(mode==='C_replacement'&&++receiptCalls===1)throw Error('TEST receipt timeout');return forever();},
 getTransactionReceipt:async()=>{throw Error('TEST no receipt');}
};
let sends=0;
const wc={chain,sendTransaction:async args=>{
 sends++;
 const covered=journal.data.txs.some(r=>r.nonce===args.nonce&&r.to===args.to);
 emit({event:'delegating',nonce:args.nonce,covered,sends});
 if(mode==='D_write_fail'&&sends===1)fs.mkdirSync(file+'.tmp');
 if(mode==='D_rename_fail'&&sends===1){fs.renameSync(file,file+'.old');fs.mkdirSync(file);}
 return wallet.sendTransaction(args);
}};
const q=new TxQueue({pc,wc,account,journal,log:()=>{},alert:()=>{},maxAttempts:2,receiptTimeoutMs:50});
emit({event:'ready',mode,marker});
q.send({to:'0x0000000000000000000000000000000000000001',data:'0x',label:'owned TEST'}).catch(()=>{});
// Queued work must never be delegated after the stop.
q.send({to:'0x0000000000000000000000000000000000000002',data:'0x',label:'owned TEST behind'}).catch(()=>{});
setInterval(()=>{},1000); // Owned child remains alive until its parent stops it.
