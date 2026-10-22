// Exact contract-creation handoff preparation. Pure validation; never signs or broadcasts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getContractAddress, keccak256 } from '../enclave/node_modules/viem/_esm/index.js';
const sha = hex => createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex');
const eq = (a,b,label) => assert.equal(String(a).toLowerCase(),String(b).toLowerCase(),label);
const hex = n => '0x'+BigInt(n).toString(16);
export function reserveRequest({ pre, draft, simulation, mainSourceHash, now = Date.now() }) {
  assert.equal(mainSourceHash, pre.provenance.EnclaveLeaseGasReserve.sourceSha256, 'main source changed');
  assert.equal(mainSourceHash, draft.reviewedSourceSha256, 'draft source changed');
  assert.match(draft.creationData,/^0x(?:[0-9a-fA-F]{2})+$/);
  assert.equal(sha(draft.creationData),pre.reserveCreationCalldataSha256,'creation calldata changed');
  assert.equal(draft.dataSha256,pre.reserveCreationCalldataSha256,'draft digest changed');
  eq(draft.from,pre.owner,'sender changed'); assert.equal(draft.chainId,8453); assert.equal(BigInt(draft.value),0n);
  const age=now-Date.parse(pre.checkedAt); assert.ok(Number.isFinite(age)&&age>=0&&age<=120000,'preflight must be less than two minutes old');
  assert.equal(pre.reads.length,2,'need both independent RPC preflights');
  assert.equal(new Set(pre.reads.map(x=>new URL(x.rpc).hostname)).size,2,'duplicate RPC');
  for(const r of pre.reads) {
    assert.equal(r.chainId,8453); eq(r.admin,pre.owner,'administrator changed');
    eq(r.blockHash,pre.reads[0].blockHash,'RPC block disagreement');
    assert.equal(r.nonce,pre.reads[0].nonce,'RPC nonce disagreement');
    assert.equal(r.ownerBalanceWei,pre.reads[0].ownerBalanceWei,'RPC balance disagreement');
    assert.equal(String(r.blockNumber),String(simulation.atBlock),'simulation block differs');
  }
  assert.equal(simulation.nonce,String(pre.reads[0].nonce),'simulation nonce differs');
  assert.equal(simulation.results.length,2);
  assert.deepEqual(new Set(simulation.results.map(x=>x.rpc)),new Set(pre.reads.map(x=>x.rpc)));
  const expected=getContractAddress({from:pre.owner,nonce:BigInt(pre.reads[0].nonce)});
  eq(simulation.predictedReserve,expected,'creation address differs');
  let gas=0n,maxFee=0n,tip=0n,l1=0n,runtime;
  for(const r of simulation.results) {
    assert.equal(r.allCallsPassed,true);assert.equal(r.bindingsChecked,true);
    assert.equal(r.result[0].calls.length,7);
    assert.ok(r.result[0].calls.every(c=>c.status==='0x1'),'failed simulated call');
    const code=r.result[0].calls[0].returnData;
    eq(keccak256(code),r.simulatedRuntimeHashes.reserve,'runtime hash inconsistent');
    if(runtime)eq(code,runtime,'simulated runtimes disagree');else runtime=code;
    const e=r.estimates[0];assert.equal(e.step,'create reserve');
    gas=BigInt(e.illustrativeGasLimit)>gas?BigInt(e.illustrativeGasLimit):gas;
    maxFee=BigInt(e.illustrativeMaxFeePerGas)>maxFee?BigInt(e.illustrativeMaxFeePerGas):maxFee;
    l1=BigInt(e.oracleL1EstimateWei)>l1?BigInt(e.oracleL1EstimateWei):l1;
  }
  for(const r of pre.reads)tip=BigInt(r.priorityFeePerGas)>tip?BigInt(r.priorityFeePerGas):tip;
  assert.ok(gas>0n&&gas<=5000000n,'creation gas exceeds reviewed cap');
  assert.ok(maxFee>0n&&maxFee<=1000000000n&&tip<=maxFee,'creation fee exceeds reviewed cap');
  assert.ok(BigInt(pre.reads[0].ownerBalanceWei)>=gas*maxFee+l1,'insufficient setup funds');
  return {format:'enclave-lease-reserve-creation/v1',status:'prepared; wallet approval and live revalidation required',preparedAt:new Date(now).toISOString(),
    expiresAt:new Date(Date.parse(pre.checkedAt)+120000).toISOString(),
    purpose:'Create the additive application lease gas reserve against the existing ledger and registry; zero ETH deposit',
    transaction:{from:pre.owner,chainId:'0x2105',type:'0x2',nonce:hex(pre.reads[0].nonce),data:draft.creationData,value:'0x0',gas:hex(gas),maxFeePerGas:hex(maxFee),maxPriorityFeePerGas:hex(tip)},
    sourceSha256:mainSourceHash,creationDataSha256:pre.reserveCreationCalldataSha256,expectedRuntimeHash:keccak256(runtime),
    predictedAddress:expected,predictedAddressWarning:'NOT a funding destination; publish only after receipt and runtime verification',
    binding:{owner:pre.owner,ledger:pre.originalLedger,registry:pre.originalRegistry,oracle:pre.oracle,limits:pre.limits},
    estimatedFeeLimitWei:String(gas*maxFee+l1),feeLimitCaveat:'Includes an estimated L1 fee, not a guaranteed total; refresh before wallet approval.'};
}
export function checkCreationLanding(request,{transaction:tx,receipt,code}) {
  const wanted=request.transaction;
  eq(tx.from,wanted.from,'wrong sender');assert.equal(tx.to,null,'not contract creation');
  assert.equal(Number(tx.chainId),8453);assert.equal(Number(tx.nonce),Number(BigInt(wanted.nonce)));
  eq(tx.input,wanted.data,'wrong creation code');assert.equal(BigInt(tx.value),0n);
  assert.equal(BigInt(tx.gas),BigInt(wanted.gas),'gas changed');
  assert.ok(BigInt(tx.maxFeePerGas)<=BigInt(wanted.maxFeePerGas),'wallet increased fee cap');
  assert.ok(BigInt(tx.maxPriorityFeePerGas)<=BigInt(wanted.maxPriorityFeePerGas),'wallet increased priority cap');
  assert.equal(receipt.status,'success','creation reverted');eq(receipt.transactionHash,tx.hash,'receipt hash differs');
  eq(receipt.contractAddress,request.predictedAddress,'wrong deployed address');
  eq(keccak256(code),request.expectedRuntimeHash,'unexpected runtime');
  return receipt.contractAddress;
}
