// Untrusted evidence acquisition ONLY. Offline native execution decides whether
// inputs prove the conditional transition. This tool never creates chain authority.
import fs from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyCommitment, payloadTransactions } from '../../enclave-deployment-lifecycle/network/op-head-relay.mjs';
const require = createRequire(new URL('../../enclave-deployment-lifecycle/package.json', import.meta.url));
const { keccak256, fromRlp, toRlp } = require('viem');
export const MAX_FILE = 128 << 20;
const MAX_RPC_BYTES = 96 << 20, MAX_CALLS = 258;
const FORMAT = 'enclave-signed-payload-candidate/v1';
const fail = message => { throw Error(message); };
const hex = b => `0x${Buffer.from(b).toString('hex')}`;
const hash = b => createHash('sha256').update(b).digest('hex');
const quantity = n => `0x${BigInt(n).toString(16)}`;
const exact = (x, keys, what) => {
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).sort().join() !== [...keys].sort().join()) fail(`${what}: unexpected fields`);
};
const bytes = (x, max = MAX_FILE) => {
  if (typeof x !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(x) || (x.length - 2) / 2 > max) fail('invalid/oversized lowercase hex');
  return Buffer.from(x.slice(2), 'hex');
};
const word = x => { const b=bytes(x,32); if(b.length!==32)fail('expected32 bytes'); return b; };

export function ownEndpoint(raw) {
  const u=new URL(raw);
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname!=='/') fail('private witness endpoint must be a plain origin');
  const h=u.hostname;
  const a=h.split('.').map(Number);
  const ipv4=/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(h) && a.every(n=>n>=0&&n<=255);
  if (h!=='[::1]' && !(ipv4 && (a[0]===127 || a[0]===10 || (a[0]===172&&a[1]>=16&&a[1]<=31) || (a[0]===192&&a[1]===168)))) fail('only explicit loopback/private IP literals; no public authority fallback');
  return u.href;
}

// Raw Snappy, one literal. No compressor dependency or hidden truncation. Native
// bounded Snappy/SSZ decoder remains independent and verifies exact signed bytes.
export function literalSnappy(raw) {
  if (!raw.length || raw.length > (10<<20)) fail('envelope size');
  const prefix=[]; let n=raw.length;
  do { let b=n&127;n=Math.floor(n/128);prefix.push(b|(n?128:0)); } while(n);
  const len=raw.length-1;
  if (len<60) prefix.push(len<<2);
  else {
    let v=len;const encoded=[];
    do {encoded.push(v&255);v=Math.floor(v/256);}while(v);
    prefix.push((59+encoded.length)<<2,...encoded);
  }
  return Buffer.concat([Buffer.from(prefix),Buffer.from(raw)]);
}

// Advisory attributes used ONLY to ask the host for witness data. The native
// evaluator independently reconstructs trusted attributes and compares its full
// executed header, so this parser is not an authorization or execution verifier.
export async function signedInput(raw, signer) {
  const {commitment,head}=await verifyCommitment(raw,{chainId:8453,signer});
  const data=bytes(commitment.data,4<<20), p=data.subarray(32);
  if(p.length<560)fail('V4 fixed payload missing');
  const extra=p.readUInt32LE(436), txStart=p.readUInt32LE(504), withdrawalStart=p.readUInt32LE(508);
  if(extra!==560 || txStart<extra || withdrawalStart<txStart || withdrawalStart!==p.length)fail('only exact V4 with empty withdrawal list supported');
  const ext=p.subarray(extra,txStart);
  if(!((ext.length===9&&ext[0]===0)||(ext.length===17&&ext[0]===1)))fail('unsupported Holocene/Jovian extraData');
  const txs=payloadTransactions(commitment.data).map(hex);
  const attrs={timestamp:quantity(p.readBigUInt64LE(428)),prevRandao:hex(p.subarray(372,404)),
    suggestedFeeRecipient:hex(p.subarray(32,52)),parentBeaconBlockRoot:hex(data.subarray(0,32)),
    withdrawals:[],transactions:txs,noTxPool:true,gasLimit:quantity(p.readBigUInt64LE(412)),
    eip1559Params:hex(ext.subarray(1,9))};
  if(ext.length===17)attrs.minBaseFee=quantity(ext.readBigUInt64BE(9));
  const sig=Buffer.concat([word(commitment.signature.r),word(commitment.signature.s),Buffer.from([Number(commitment.signature.yParity)])]);
  const envelope=literalSnappy(Buffer.concat([sig,data]));
  const outputRoot=keccak256(Buffer.concat([Buffer.alloc(32),p.subarray(52,84),p.subarray(528,560),p.subarray(472,504)]));
  return {commitment,head,attrs,envelope,outputRoot};
}

export function witnessAccumulator(seed) {
  exact(seed,['preimageStore','blobData'],'bootstrap witness');
  exact(seed.preimageStore,['preimage_map'],'preimage store');
  exact(seed.blobData,['blobs','commitments','proofs'],'blob data');
  if(Object.values(seed.blobData).some(x=>!Array.isArray(x)||x.length))fail('blob data unsupported here');
  if(!Array.isArray(seed.preimageStore.preimage_map))fail('preimage map must be a sequence');
  const map=new Map();let rawBytes=0, strippedLocals=0;
  function insert(key,value) {
    exact(key,['data','key_type'],'preimage key');
    if(!Array.isArray(key.data)||key.data.length!==31||key.data.some(n=>!Number.isInteger(n)||n<0||n>255))fail('invalid preimage key bytes');
    if(!Array.isArray(value)||value.some(n=>!Number.isInteger(n)||n<0||n>255))fail('invalid preimage bytes');
    if(key.key_type==='Local'){strippedLocals++;return;}
    const b=Buffer.from(value);
    let digest;
    if(key.key_type==='Keccak256')digest=bytes(keccak256(b));
    else if(key.key_type==='Sha256')digest=createHash('sha256').update(b).digest();
    else fail('non-hash preimage refused');
    if(!timingSafeEqual(digest.subarray(1),Buffer.from(key.data)))fail('preimage hash mismatch');
    const id=`${key.key_type}:${Buffer.from(key.data).toString('hex')}`;
    const previous=map.get(id);
    if(previous){if(!previous.value.equals(b))fail('conflicting duplicate preimage');return;}
    rawBytes+=b.length;
    if(rawBytes>24<<20 || map.size>=150000)fail('aggregate preimage bound');
    map.set(id,{key,value:b});
  }
  for(const pair of seed.preimageStore.preimage_map){if(!Array.isArray(pair)||pair.length!==2)fail('invalid preimage pair');insert(...pair);}
  function add(raw) {
    const b=bytes(raw,64<<20),digest=bytes(keccak256(b));
    insert({data:[...digest.subarray(1)],key_type:'Keccak256'},[...b]);
  }
  return {add,finish(){
    const result={preimageStore:{preimage_map:[...map.values()].map(({key,value})=>[key,[...value]])},blobData:{blobs:[],commitments:[],proofs:[]}};
    const encoded=Buffer.from(JSON.stringify(result));
    if(encoded.length>MAX_FILE)fail('serialized witness bound');
    return {encoded,entries:map.size,rawBytes,strippedLocals};
  }};
}

export function checkRawHeader(raw, expectedHash, expectedNumber) {
  const b=bytes(raw,16<<10);
  if(keccak256(b)!==expectedHash)fail('raw header hash mismatch');
  const fields=fromRlp(raw,'hex');
  if(!Array.isArray(fields)||fields.length<16||fields.some(x=>typeof x!=='string'))fail('header RLP shape');
  if(toRlp(fields)!==raw)fail('noncanonical header RLP');
  const number=fields[8]==='0x'?0n:BigInt(fields[8]);
  if(number!==expectedNumber)fail('ancestor height mismatch');
  word(fields[0]);
  return fields[0];
}

function rpcClient(endpoint,signal,fetchImpl) {
  const url=ownEndpoint(endpoint);let calls=0,total=0;
  return async (method,params,maxBytes)=>{
    if(!['debug_executePayload','debug_getRawHeader'].includes(method))fail('unreviewed witness method');
    const id=++calls;if(calls>MAX_CALLS)fail('RPC call budget exceeded');
    const r=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),
      headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
    if(!r.ok)fail(`witness HTTP ${r.status}`);
    const parts=[];let size=0;
    for await(const chunk of r.body){size+=chunk.length;total+=chunk.length;
      if(size>maxBytes||total>MAX_RPC_BYTES){await r.body.cancel?.().catch(()=>{});fail('witness response byte budget');}parts.push(Buffer.from(chunk));}
    const j=JSON.parse(Buffer.concat(parts).toString('utf8'));
    if(j.jsonrpc!=='2.0'||j.id!==id||j.error||!Object.hasOwn(j,'result'))fail('witness RPC failed/mismatched');
    return j.result;
  };
}

export async function capture({plan,commitment,bootstrapWitness,fetchImpl=fetch,signal}) {
  exact(plan,['format','endpoint','context'],'capture plan');
  if(plan.format!=='enclave-signed-capture-plan/v1')fail('wrong capture plan');
  exact(plan.context,['format','base','parentHash','parentNumber','unsafeSigner'],'caller context template');
  const c=plan.context;
  exact(c.base,['chainId','l1Head','l1HeadNumber','agreedL2OutputRoot','claimedL2OutputRoot','claimedL2BlockNumber',
    'intermediateBlockInterval','rollupConfig','expectedRollupConfigHash','expectedScheduleId'],'base context');
  if(c.format!==FORMAT||c.base.chainId!==8453||c.base.intermediateBlockInterval!==1)fail('wrong caller base context');
  for(const key of ['l1Head','agreedL2OutputRoot','claimedL2OutputRoot','expectedRollupConfigHash','expectedScheduleId'])word(c.base[key]);
  for(const key of ['l1HeadNumber','claimedL2BlockNumber'])if(!Number.isSafeInteger(c.base[key])||c.base[key]<0)fail('base numeric bound');
  if(!c.base.rollupConfig||typeof c.base.rollupConfig!=='object'||Array.isArray(c.base.rollupConfig))fail('rollup config missing');
  const signed=await signedInput(commitment,c.unsafeSigner);
  if(!Number.isSafeInteger(c.parentNumber)||c.parentNumber<0||signed.head.parentHash!==c.parentHash || signed.head.number!==BigInt(c.parentNumber)+1n)fail('signed payload does not extend caller parent');
  if(c.base.claimedL2BlockNumber!==Number(signed.head.number)||c.base.claimedL2OutputRoot!==signed.outputRoot)fail('signed candidate differs from caller expected claim');
  const context={...c,envelopeKeccak:keccak256(signed.envelope)};
  const w=witnessAccumulator(bootstrapWitness);
  const call=rpcClient(plan.endpoint,signal,fetchImpl);
  const proof=await call('debug_executePayload',[c.parentHash,signed.attrs],64<<20);
  if(!proof||typeof proof!=='object'||Array.isArray(proof))fail('execution witness is not an object');
  for(const key of ['state','codes','keys']) {
    if(!Array.isArray(proof[key]))fail(`execution witness lacks ${key}`);
    for(const preimage of proof[key])w.add(preimage);
  }
  // BLOCKHASH may need any of the preceding256 headers. Missing one refuses
  // capture rather than pretending the execution witness contains everything.
  let ancestor=c.parentHash,number=BigInt(c.parentNumber);
  for(let i=0;i<256;i++){
    const raw=await call('debug_getRawHeader',[ancestor],64<<10);
    const parent=checkRawHeader(raw,ancestor,number);w.add(raw);
    if(number===0n)break;ancestor=parent;number--;
  }
  const witness=w.finish();
  return {context,envelope:signed.envelope,witness:witness.encoded,receipt:{
    format:'enclave-signed-capture-receipt/v1',authority:false,nativeEvaluated:false,
    contextProvenance:'caller obligation; not authenticated by this capture tool',
    candidateHash:signed.head.hash,parentHash:c.parentHash,number:Number(signed.head.number),
    timestamp:Number(signed.head.timestamp),outputRoot:signed.outputRoot,
    witnessEntries:witness.entries,witnessRawBytes:witness.rawBytes,strippedLocalInputs:witness.strippedLocals,
    methods:['debug_executePayload','debug_getRawHeader'],source:'explicit owned private witness endpoint; responses untrusted'}};
}

async function readJson(file,max) {
  const f=await fs.open(file,'r');try{
    const stat=await f.stat();if(!stat.isFile()||stat.size>max)fail('input file bound/type');
    const parts=[];let count=0;
    while(true){const b=Buffer.alloc(Math.min(65536,max+1-count));const r=await f.read(b,0,b.length,null);
      if(!r.bytesRead)break;count+=r.bytesRead;if(count>max)fail('input grew over bound');parts.push(b.subarray(0,r.bytesRead));}
    return JSON.parse(Buffer.concat(parts));
  }finally{await f.close();}
}
async function main() {
  const a=process.argv.slice(2);
  if(a.length!==5||a[0]!=='--capture-untrusted')fail('usage: capture.mjs --capture-untrusted plan.json commitment.json bootstrap-witness.json NEW_OUTPUT_DIR');
  const plan=await readJson(a[1],128<<10),commitment=await readJson(a[2],9<<20),bootstrapWitness=await readJson(a[3],MAX_FILE);
  const out=path.resolve(a[4]);await fs.mkdir(out,{mode:0o700});
  try {
    const captured=await capture({plan,commitment,bootstrapWitness,signal:AbortSignal.timeout(120000)});
    const files={'context.json':Buffer.from(JSON.stringify(captured.context)), 'witness.json':captured.witness,'envelope.snappy':captured.envelope};
    captured.receipt.sha256=Object.fromEntries(Object.entries(files).map(([name,data])=>[name,hash(data)]));
    for(const [name,data] of Object.entries(files))await fs.writeFile(path.join(out,name),data,{flag:'wx',mode:0o600});
    await fs.writeFile(path.join(out,'CAPTURE.json'),JSON.stringify(captured.receipt,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({captured:true,authority:false,nativeEvaluated:false,directory:out}));
  } catch(e){await fs.writeFile(path.join(out,'FAILED.txt'),String(e.message)+'\n',{flag:'wx',mode:0o600});throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
