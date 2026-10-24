// Local EIP-1193 handoff transport. The browser alone asks MetaMask to send a transaction.
// ADAPTED from custody-factory-wallet-20261023 handoff-server.mjs (sha256 fb189e46…, reviewed); the exact diff is
// evidence/handoff-server.diff. Three additions, nothing removed or relaxed:
//   gate()       /prepare is refused (409, journal untouched) while gate() names a reason (here: the upload is not verified);
//   routes       extra POST routes behind the SAME host/origin/cross-site/token checks and body cap (the upload stage);
//   reconcile()  for an attempt left in awaiting-wallet with no hash: the hook reads the chain and may answer
//                {reset:true} (the prepared nonce can no longer be used, or provably was never used) -> ready, or anything
//                else -> unchanged. A recorded hash is never reset.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
export function fileJournal(file) {
 const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 return {
  read:()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{status:'ready'},
  write(value){
   const tmp=file+'.'+randomBytes(8).toString('hex');let fd;
   try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(tmp,file);const d=fs.openSync(dir,'r');try{fs.fsyncSync(d)}finally{fs.closeSync(d)}
   }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp)}catch(e){if(e.code!=='ENOENT')throw e}}
  },
 };
}
export function createHandoffServer({initialRequest,prepare,verify,journal,assets={},accept=async()=>{},gate=async()=>null,routes={},reconcile=async()=>({reset:false}),status=async()=>({})}) {
 let state=journal.read(),origin;
 const token=randomBytes(24).toString('hex');
 const set=value=>{journal.write(value);state=value;};
 const reply=(res,code,value,type='application/json')=>{
  res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
   'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
  res.end(typeof value==='string'?value:JSON.stringify(value));
 };
 const body=async req=>{let b='';for await(const c of req){b+=c;if(b.length>2048)throw Error('request too large')}return JSON.parse(b||'{}')};
 const server=http.createServer(async(req,res)=>{try{
  if(req.headers.host!==new URL(origin).host)return reply(res,403,{error:'host refused'});
  if(req.headers.origin&&req.headers.origin!==origin)return reply(res,403,{error:'origin refused'});
  if(req.headers['sec-fetch-site']==='cross-site'&&!(req.method==='GET'&&req.url==='/'&&req.headers['sec-fetch-mode']==='navigate'))return reply(res,403,{error:'cross-site refused'});
  if(req.method==='GET'&&assets[req.url])return reply(res,200,assets[req.url].body,assets[req.url].type);
  if(req.method==='GET'&&req.url==='/request')return reply(res,200,{request:state.request||initialRequest,token,state,stages:await status()});
  if(req.method!=='POST')return reply(res,404,{error:'not found'});
  if(req.headers.origin!==origin||req.headers['x-signing-token']!==token)return reply(res,403,{error:'authorization refused'});
  if(Object.hasOwn(routes,req.url))return reply(res,200,await routes[req.url](await body(req)));
  if(req.url==='/reconcile'){
   if(state.status!=='awaiting-wallet'||state.hash)return reply(res,409,{error:'Only an attempt handed to the wallet without a recorded hash can be reconciled.'});
   const r=await reconcile(state.request);
   if(r&&r.reset===true)set({status:'ready',reconciledFrom:{nonce:state.request?.transaction?.nonce,preparedAt:state.preparedAt},reconciledAt:new Date().toISOString(),reason:r.reason});
   return reply(res,200,{...r,state});
  }
  if(req.url==='/prepare'){
   if(state.status!=='ready')return reply(res,409,{error:'An attempt already exists. Inspect its outcome before another request.'});
   const blocked=await gate();
   if(blocked)return reply(res,409,{error:blocked});
   set({status:'preparing'});
   let request;
   try{request=await prepare();}catch(e){set({status:'ready'});throw e}
   // A disk failure here MUST NOT return a transaction to the browser.
   set({status:'awaiting-wallet',request,preparedAt:new Date().toISOString()});
   return reply(res,200,{transaction:request.transaction});
  }
  if(req.url==='/rejected'){
   const b=await body(req);
   if(state.status!=='awaiting-wallet'||b.code!==4001)return reply(res,409,{error:'Only explicit wallet rejection can reset this attempt.'});
   set({status:'ready'});return reply(res,200,state);
  }
  if(req.url==='/result'){
   const b=await body(req);
   if(!/^0x[0-9a-fA-F]{64}$/.test(b.hash||''))return reply(res,400,{error:'invalid transaction hash'});
   if(!['awaiting-wallet','submitted'].includes(state.status))return reply(res,409,{error:'no pending request'});
   if(state.hash&&state.hash.toLowerCase()!==b.hash.toLowerCase())return reply(res,409,{error:'different transaction already submitted'});
   const request=state.request,hash=b.hash.toLowerCase();
   // A hash that belongs to another stage is refused BEFORE it is recorded here.
   if(!state.hash)await accept(hash,request);
   set({...state,status:'submitted',hash});
   const result=await verify(request,hash);
   set({...state,status:'confirmed',verification:result});
   return reply(res,200,result);
  }
  return reply(res,404,{error:'not found'});
 }catch(e){reply(res,400,{error:[e.shortMessage||e.message,e.details].filter(Boolean).join(' ').slice(0,700)})}});
 return {server,get state(){return state},get origin(){return origin},async listen(port=0){
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',ok)});
  origin='http://127.0.0.1:'+server.address().port;return origin;
 },async close(){server.closeAllConnections();await new Promise(ok=>server.close(ok))}};
}
