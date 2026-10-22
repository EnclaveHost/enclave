import http from 'node:http';
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {createPublicClient,http as rpcHttp} from '../enclave/node_modules/viem/_esm/index.js';
const run=promisify(execFile),root=new URL('../../',import.meta.url).pathname;
const mode=process.argv[2]||'publish';if(!['publish','upgrade'].includes(mode))throw Error('invalid mode');
const requestFile=root+`outputs/adapter-correction/${mode}-request.json`;
const resultFile=root+`outputs/adapter-correction/${mode}-receipt.json`;
const stateFile=root+`work/metamask-bridge/correction-${mode}-state.json`;
const request=JSON.parse(fs.readFileSync(requestFile));
const token=randomBytes(24).toString('hex');
const client=createPublicClient({transport:rpcHttp('https://base.drpc.org',{timeout:15000,retryCount:1})});
let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):{status:'ready'};
let origin;
function save(){fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n',{mode:0o600});}
function reply(res,status,data,type='application/json'){res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(typeof data==='string'?data:JSON.stringify(data));}
async function body(req){let b='';for await(const chunk of req){b+=chunk;if(b.length>2048)throw Error('request too large');}return JSON.parse(b||'{}');}
const server=http.createServer(async(req,res)=>{try{
 if(req.headers.host!==new URL(origin).host)return reply(res,403,{error:'host refused'});
 if(req.headers.origin&&req.headers.origin!==origin)return reply(res,403,{error:'origin refused'});
 if(req.headers['sec-fetch-site']==='cross-site'&&!(req.method==='GET'&&req.url==='/'&&req.headers['sec-fetch-mode']==='navigate'))return reply(res,403,{error:'cross-site refused'});
 if(req.method==='GET'&&req.url==='/')return reply(res,200,fs.readFileSync(new URL(mode==='publish'?'./correction-publish.html':'./correction-upgrade.html',import.meta.url),'utf8'),'text/html');
 if(req.method==='GET'&&req.url==='/app.js')return reply(res,200,fs.readFileSync(new URL('./app.js',import.meta.url),'utf8'),'text/javascript');
 if(req.method==='GET'&&req.url==='/style.css')return reply(res,200,fs.readFileSync(new URL('./style.css',import.meta.url),'utf8'),'text/css');
 if(req.method==='GET'&&req.url==='/request')return reply(res,200,{request,token,state});
 if(req.method!=='POST')return reply(res,404,{error:'not found'});
 if(req.headers.origin!==origin||req.headers['x-signing-token']!==token)return reply(res,403,{error:'authorization refused'});
 if(req.url==='/prepare'){
  if(state.status!=='ready')return reply(res,409,{error:'An attempt already exists. Check its status before retrying.'});
  state={status:'preparing'};save();
  try{
   await run(process.execPath,[root+'work/prepare-correction-signing.mjs',mode],{cwd:root,timeout:30000});
   const fresh=JSON.parse(fs.readFileSync(requestFile));assert.deepEqual(fresh.transaction,request.transaction);
   assert.equal(await client.getChainId(),8453);
   const nonce=await client.getTransactionCount({address:request.transaction.from,blockTag:'pending'});
   const gas=BigInt(fresh.estimatedGas)*125n/100n;
   const tx={...request.transaction,chainId:'0x2105',gas:'0x'+gas.toString(16),nonce:'0x'+nonce.toString(16)};
   state={status:'awaiting-wallet',preparedAt:new Date().toISOString(),nonce,transaction:tx};save();return reply(res,200,{transaction:tx});
  }catch(e){state={status:'ready'};save();throw e;}
 }
 if(req.url==='/rejected'){
  const b=await body(req);if(state.status!=='awaiting-wallet'||b.code!==4001)return reply(res,409,{error:'Only explicit wallet rejection can reset this attempt.'});
  state={status:'ready'};save();return reply(res,200,state);
 }
 if(req.url==='/result'){
  const b=await body(req);if(!/^0x[0-9a-fA-F]{64}$/.test(b.hash||''))return reply(res,400,{error:'invalid transaction hash'});
  if(!['awaiting-wallet','submitted'].includes(state.status))return reply(res,409,{error:'no pending request'});
  if(state.hash&&state.hash!==b.hash)return reply(res,409,{error:'different transaction already submitted'});
  state={...state,status:'submitted',hash:b.hash};save();
  const tx=await client.getTransaction({hash:b.hash});
  assert.equal(Number(tx.chainId),8453);assert.equal(tx.from.toLowerCase(),request.transaction.from.toLowerCase());assert.equal(tx.to.toLowerCase(),request.transaction.to.toLowerCase());assert.equal(tx.input,request.transaction.data);assert.equal(tx.value,0n);assert.equal(tx.nonce,state.nonce);
  const receipt=await client.waitForTransactionReceipt({hash:b.hash,confirmations:2,timeout:45000});assert.equal(receipt.status,'success');
  const prepared=JSON.parse(fs.readFileSync(root+'outputs/adapter-release/transactions.json'));const appId=prepared.newAppRef.split('/')[2];
  let outcome;
  if(mode==='publish'){
   const abi=JSON.parse(fs.readFileSync(root+'work/enclave/contracts/EnclaveAppCatalog.abi.json'));
   const v=await client.readContract({address:tx.to,abi,functionName:'getVersion',args:[appId,17n]});
   assert.equal(v.cid,request.artifact.cid);assert.equal(v.approval,1);assert.equal(v.yanked,false);assert.deepEqual(JSON.parse(v.config),prepared.catalogConfig);outcome={cid:v.cid,approval:v.approval};
  }else{
   const abi=JSON.parse(fs.readFileSync(root+'work/enclave/contracts/EnclaveDeployments.abi.json'));
   const d=await client.readContract({address:tx.to,abi,functionName:'get',args:[prepared.deployment]});assert.equal(d.appRef,`catalog://${appId}/17`);assert.deepEqual(JSON.parse(d.configCid),prepared.deploymentConfig);outcome={appRef:d.appRef,configMatches:true};
  }
  const result={status:'confirmed',checkedAt:new Date().toISOString(),transactionHash:b.hash,blockNumber:receipt.blockNumber.toString(),calldataExactMatch:true,...outcome};
  fs.writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n');state={...state,...result};save();console.log(JSON.stringify(result));return reply(res,200,result);
 }
 return reply(res,404,{error:'not found'});
}catch(e){reply(res,400,{error:String(e.shortMessage||e.message).slice(0,700)});}});
server.listen(34157,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;fs.writeFileSync(root+'work/metamask-bridge/server-info.json',JSON.stringify({url:origin,pid:process.pid})+'\n');console.log(JSON.stringify({url:origin,status:state.status}));});
