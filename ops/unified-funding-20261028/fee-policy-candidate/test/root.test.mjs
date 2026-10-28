import test from 'node:test';
import assert from 'node:assert/strict';
import {serializeTransaction} from 'viem';
import {createGasFundQuotePolicy,parseFeePolicyConfig,usdc6For,eip1559Sizes,l1OracleArgument,flzStrictUpperBound,oracleFlzUpperBound,checkEnvelopeAttempt,envelopeReplacementFees} from '../fee-policy.mjs';
import {cfg,chain,quoteCtx,execCtx,envelopeCtx,executeData,NOW,TS,B,VAULT,RELAYER,ORACLE,FEED} from './fixture.mjs';
function setup(mut, cmut){const s=chain(mut);const p=createGasFundQuotePolicy({config:cfg(cmut),request:s.request,now:()=>NOW});return {s,p};}
const code=(want)=>e=>{assert.equal(e.code,want,e.message);return true;};
test('complete price includes bounded L2/L1/operator and one ceiling',async()=>{const {p,s}=setup();const q=await p.quote(quoteCtx());const d=q.detail;assert.equal(d.components.totalWei,d.components.l2.wei+d.components.l1.wei+d.components.operator.wei);assert.equal(q.fee6,usdc6For(d.components.totalWei,s.round[1],8n,2000n));assert.ok(q.fee6>0n);assert.equal(s.log.filter(x=>x.method==='eth_estimateGas').length,0);await p.accept(execCtx(q.fee6));const e=await p.envelope(envelopeCtx(q.fee6));assert.equal(e.gasLimit,600000n);assert.ok(Object.isFrozen(e));assert.equal(s.log.filter(x=>x.method==='eth_estimateGas').length,1);});
for(const [label,mut,want] of [
 ['chain mismatch',s=>s.chainId='0x1','chain_mismatch'],
 ['stale block',s=>s.header.timestamp='0x1','block_stale'],
 ['zero header',s=>s.header.hash='0x'+'00'.repeat(32),'chain_unreadable'],
 ['missing basefee',s=>delete s.header.baseFeePerGas,'base_fee_unknown'],
 ['missing code',s=>s.code[ORACLE]='0x','missing_code'],
 ['altered code',s=>s.code[FEED]='0x60','codehash_mismatch'],
 ['changed implementation',s=>s.implWord='0x'+'00'.repeat(32),'proxy_implementation_changed'],
 ['changed aggregator',s=>s.aggregator=VAULT,'feed_aggregator_changed'],
 ['stale price',s=>{s.round[2]=TS-4000n;s.round[3]=TS-4000n;},'feed_stale'],
 ['future price',s=>{s.round[2]=TS+1n;s.round[3]=TS+1n;},'feed_future'],
 ['negative price',s=>s.round[1]=-1n,'feed_answer_nonpositive'],
 ['incomplete round',s=>s.round[4]=0n,'feed_round'],
 ['wrong decimals',s=>s.decimals=18,'feed_decimals'],
 ['wrong description',s=>s.description='BTC / USD','feed_description'],
 ['no Fjord',s=>s.isFjord=false,'l1_fee_unsupported'],
 ['no Isthmus',s=>s.isIsthmus=false,'operator_fee_unsupported'],
 ['no L1 answer',s=>s.fail.add('eth_call:getL1FeeUpperBound'),'l1_fee_unavailable'],
 ['zero L1 answer',s=>s.l1=()=>0n,'l1_fee_zero'],
 ['no operator answer',s=>s.fail.add('eth_call:getOperatorFee'),'operator_fee_unavailable'],
 ['sequencer down',s=>s.seqRound[1]=1n,'sequencer_down'],
 ['sequencer grace',s=>s.seqRound[2]=TS-1n,'sequencer_grace'],
])test(label+' refuses quote without fallback',async()=>{const {p}=setup(mut);await assert.rejects(p.quote(quoteCtx()),code(want));});
test('no envelope guard refuses price',async()=>{const {p}=setup();await assert.rejects(p.quote(quoteCtx({envelopeEnforced:false})),code('envelope_guard_absent'));});
test('fee cannot exceed grant cap',async()=>{const {p}=setup();await assert.rejects(p.quote(quoteCtx({maxFee6:0n})),code('fee_above_signed_cap'));});
test('configuration requires size/gas and rejects insufficient size',()=>{assert.throws(()=>parseFeePolicyConfig(cfg(c=>delete c.tx.gasLimit)),code('bad_config'));assert.throws(()=>parseFeePolicyConfig(cfg(c=>c.tx.maxSignedBytes=600)),code('size_overflow'));});
test('changed accepted intent and excessive post-signature gas refuse envelope',async()=>{const {p,s}=setup();const q=await p.quote(quoteCtx());await p.accept(execCtx(q.fee6));await assert.rejects(p.envelope(envelopeCtx(q.fee6,{data:executeData(q.fee6,{nonce:8n})})),code('envelope_data'));s.estimate=1000000n;await assert.rejects(p.envelope(envelopeCtx(q.fee6)),code('gas_above_cap'));});
test('current cost increase refuses previously quoted fee',async()=>{const {p,s}=setup();const q=await p.quote(quoteCtx());s.round[1]*=2n;await assert.rejects(p.accept(execCtx(q.fee6)),code('fee_no_longer_covers'));});
test('every envelope dimension enforced; replacements stop at cap',async()=>{const {p}=setup();const q=await p.quote(quoteCtx());await p.accept(execCtx(q.fee6));const e=await p.envelope(envelopeCtx(q.fee6));const a={chainId:8453,from:RELAYER,to:VAULT,data:executeData(q.fee6),value:0n,gas:e.gasLimit,nonce:1n,maxFeePerGas:10000000n,maxPriorityFeePerGas:1000000n,attempt:0,nowSec:NOW};assert.equal(checkEnvelopeAttempt(e,a),true);for(const patch of [{gas:e.gasLimit+1n},{value:1n},{to:RELAYER},{chainId:1},{maxFeePerGas:e.maxFeePerGasCap+1n},{maxPriorityFeePerGas:e.maxPriorityFeePerGasCap+1n},{attempt:3},{nowSec:Number(e.notAfter)+1}])assert.throws(()=>checkEnvelopeAttempt(e,{...a,...patch}));assert.equal(envelopeReplacementFees(e,{maxFeePerGas:e.maxFeePerGasCap,maxPriorityFeePerGas:e.maxPriorityFeePerGasCap}),null);});
test('independent viem RLP serialization matches exact signed maximum at integer boundaries',()=>{for(const nonce of [0n,127n,128n,255n,256n,(1n<<64n)-2n])for(const size of [0,1,55,56,255,256,580]){const data='0x'+'ff'.repeat(size);const fields={chainId:8453,nonce:Number(nonce<=256n?nonce:256n),maxPriorityFeePerGas:128n,maxFeePerGas:256n,gas:600000n,to:VAULT,value:0n,data,type:'eip1559',accessList:[]};if(nonce>256n)fields.nonce=Number.MAX_SAFE_INTEGER;const sizes=eip1559Sizes({...fields,nonce:BigInt(fields.nonce),dataBytes:size});const raw=serializeTransaction(fields,{r:'0x'+'ff'.repeat(32),s:'0x'+'ff'.repeat(32),yParity:1});assert.equal((raw.length-2)/2,sizes.signedMax);}});
test('L1 argument covers conservative compression length for every allowed size',()=>{for(let n=1;n<=4096;n++)assert.ok(oracleFlzUpperBound(l1OracleArgument(n))>=flzStrictUpperBound(n));});
