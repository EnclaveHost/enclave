// Read-only migration inventory. The caller supplies the existing trusted,
// in-domain snapshot capability; JSON/RPC labels are not that capability.
// No transaction construction, signing, sending, or policy authorization here.
import { keccak256, parseAbi, getAddress } from 'viem';
import { LEDGER_ABI, OWNER_ABI, REGISTRY_ABI } from './lease-gas-owner.mjs';
const ZERO = '0x' + '00'.repeat(20), ZERO32 = '0x' + '00'.repeat(32);
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();
const EXTRA = parseAbi([
  'function deploymentsSchema() view returns(uint256)',
  'function registry() view returns(address)',
  'function feeOf(bytes32) view returns(address recipient,uint256 feePerSec6)',
  'function earnOf(bytes32) view returns(uint256 runnerRate6,uint256 escrow6,uint64 creditedUntil)',
  'function capOf(bytes32) view returns(uint256)',
  'function ownerEscrow6(bytes32) view returns(uint256)',
  'function refundableOf(bytes32) view returns(uint256)',
  'function earned6(address) view returns(uint256)',
  'function lifecycleSchema() view returns(uint256)',
  'function lifecycleController() view returns(address)',
  'function selfHostingIdentity() view returns(address)',
  'function importsSealed() view returns(bool)',
  'function ledger() view returns(address)',
  'function reserve() view returns(address)',
  'function principal(address) view returns(address)',
]);
const positiveHash = x => /^0x[0-9a-f]{64}$/i.test(x || '') && !same(x,ZERO32);
const uint = (v,label) => {
  if(typeof v !== 'bigint' && !(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v))) throw Error(`invalid ${label}`);
  const n=BigInt(v); if(n<0n || n >= (1n<<256n)) throw Error(`invalid ${label}`); return n;
};
function pin(p,label) {
  if(!p || !positiveHash(p.codeHash)) throw Error(`reviewed deployed code pin required: ${label}`);
  const address=getAddress(p.address); if(same(address,ZERO)) throw Error(`zero ${label}`);
  return {...p,address};
}

/** Conservative first-canary classification, NOT an execution authorization.
 * Paid/nonzero escrow migrations require a separate conservation plan. Global
 * source operator earnings stay withdrawable on the source; never copy them.
 */
export function assessMigrationInventory(v) {
  const blockers=[], obligations=[];
  const block=(code,detail)=>blockers.push({code,detail});
  if(!v || !positiveHash(v.id) || !v.source) throw Error('incomplete migration inventory');
  const s={...v.source};
  const amounts=['rate6','balance6','spent6','publisherFee6','runnerRate6','escrow6','ownerEscrow6','refundable6','capRate6','gasReserveWei'];
  for(const k of amounts) s[k]=uint(s[k],k);
  if(!v.intendedHost || v.intendedHost.active!==true || !/^0x[0-9a-f]{40}$/i.test(v.intendedHost.operator || '') || same(v.intendedHost.operator,ZERO))
    block('host-unavailable','Intended host must be active with a nonzero registered operator.');
  if(s.schema!==16) block('unsupported-source','First migration path is limited to the reviewed schema-16 ledger.');
  if(!same(s.rowId,v.id) || !s.exists) block('unknown-source','Source deployment does not exist.');
  if(s.active!==true) block('source-disabled','Preserve disabled/stopped intent; do not activate it through migration.');
  if(!same(s.runner,ZERO32) || !same(s.runnerOperator,ZERO) || uint(s.leaseUntil,'leaseUntil')!==0n)
    block('legacy-assignment','Source runner and funded tail must actually be retired; expiry alone is insufficient.');
  if(s.rate6!==0n || s.publisherFee6!==0n || s.runnerRate6!==0n || s.balance6!==0n || s.escrow6!==0n || s.ownerEscrow6!==0n || s.refundable6!==0n)
    block('financial-conservation','Nonzero runtime/fee/escrow needs an explicit refund/backing conservation plan; copying records is not moving funds.');
  if(!v.destination) block('destination-unprepared','Reviewed deployed v2 ledger/controller/identity pins are missing.');
  else {
    const d=v.destination;
    if(d.schema!==17 || d.lifecycleSchema!==2 || d.pairMatches!==true)
      block('destination-pair','Destination must have schema 17/lifecycle 2 and exact controller, identity, registry bindings.');
    if(d.importsSealed!==false) block('imports-closed','Destination import window is closed or unknown.');
    if(d.exists!==false) block('already-imported','Reconcile the existing destination record instead of importing again.');
    if(!d.ownerPrincipal || !d.hostPrincipal || same(d.ownerPrincipal,ZERO) || !same(d.ownerPrincipal,d.hostPrincipal))
      block('selfhost-identity','Pinned identity contract must establish the same owner and intended-host principal.');
  }
  if(s.gasReserveWei>0n) obligations.push({code:'old-gas-reserve',detail:'Legacy gas reserve is separately keyed to source owner. It is not destination transition credit; preserve or explicitly withdraw it through that owner.'});
  if(v.gasAdapter) {
    if(!v.destination || !same(v.gasAdapter.ledger,v.destination.ledger) || !same(v.gasAdapter.reserve,v.destination.controller))
      obligations.push({code:'funding-incompatible',detail:'Existing immutable gas adapter funds the old ledger/reserve. Existing grants do not authorize a new controller or adapter.'});
  } else obligations.push({code:'funding-unverified',detail:'No current funding adapter binding was supplied; no reusable session funding authority is inferred.'});
  obligations.push({code:'source-earnings',detail:'Previously earned operator credit remains on the source ledger and must remain withdrawable; do not duplicate it.'});
  obligations.push({code:'activation-evidence',detail:'Before activation require reconciled old intents, actual generation fencing, authenticated authority, owner witness policy, funded final-stop reserve, and per-app ledger dispatch at every production consumer.'});
  obligations.push({code:'host-offline-authority',detail:'Registry admission and liveness are separate. Require an authenticated independent host-offline transaction path; operator-only deregistration cannot report a crashed host. Deny routing immediately on authenticated failure and reconcile the pending report to canonical finality.'});
  obligations.push({code:'host-bootstrap-budget',detail:'Qualify the paid capacity-test bootstrap path funding the joining host online transaction and a protected independent offline reserve, including failed tests. Avoid registration/payment circularity; this host budget is separate from app transition and compute balances.'});
  obligations.push({code:'host-sponsor-selection',detail:'Prefer an eligible online host with paid work. Only after verified current absence of that source, use the explicitly scoped existing Stripe provisioner fallback under reviewed identity and spending limits. Reconcile a durable hardware/job sponsorship identity before either source pays; no duplicate or unrelated-wallet funding.'});
  obligations.push({code:'app-emergency-stop',detail:'Qualify independent quorum submission without the failed host, protected final-stop gas, and a low-reserve Stop choice instead of unaffordable Queue. Admission denial must not prevent offline reporting. Verify ledger settlement, identity/ownership lookup, fee oracle and refund recipient failures cannot strand authenticated offline state.'});
  return {schema:1,readOnly:true,executable:false,id:v.id,status:blockers.length?'hold':'zero-balance-canary-review',blockers,obligations,
    // Financial fields remain diagnostic. No approval flag or transaction bytes.
    preserved:{owner:s.owner,appRef:s.appRef,capRate6:s.capRate6,spent6:s.spent6,publisherRecipient:s.publisherRecipient},
    limits:'Zero-balance self-hosted first-canary assessment only. Passing does not establish runtime readiness or authorize a migration.'};
}

/** All reads use one block from the supplied local snapshot. No fallback RPC.
 * IntendedHost is explicit: the old assignment may already have been cleared.
 * The result always remains diagnostic, including when authority is qualified.
 */
export async function readMigrationPreflight({snapshot,pins,id,intendedHost}) {
  if(typeof snapshot!=='function' || pins?.chainId!==8453 || !positiveHash(id) || !positiveHash(intendedHost)) throw Error('snapshot, Base pins, deployment and intended host required');
  const source={ledger:pin(pins.source?.ledger,'source ledger'),reserve:pin(pins.source?.reserve,'source reserve'),registry:pin(pins.source?.registry,'source registry')};
  const destination=pins.destination?{ledger:pin(pins.destination.ledger,'destination ledger'),controller:pin(pins.destination.controller,'destination controller'),identity:pin(pins.destination.identity,'destination identity')}:null;
  if(destination && same(source.ledger.address,destination.ledger.address)) throw Error('source and destination ledger must differ');
  const gasAdapter=pins.gasAdapter?pin(pins.gasAdapter,'gas adapter'):null;
  const result=await snapshot(async(c,blockNumber)=>{
    for(const [label,p] of Object.entries({...Object.fromEntries(Object.entries(source).map(([k,v])=>['source '+k,v])),...Object.fromEntries(Object.entries(destination||{}).map(([k,v])=>['destination '+k,v])),...(gasAdapter?{'gas adapter':gasAdapter}:{})})) {
      const code=await c.getCode({address:p.address,blockNumber});
      if(!code || code==='0x' || !same(keccak256(code),p.codeHash)) throw Error(`deployed code differs: ${label}`);
    }
    const read=(p,abi,functionName,args=[])=>c.readContract({address:p.address,abi,functionName,args,blockNumber});
    const d=await read(source.ledger,LEDGER_ABI,'get',[id]);
    const [schema,registry,fee,earn,ownerEscrow,refundable,cap,res,host,reserveLedger]=await Promise.all([
      read(source.ledger,EXTRA,'deploymentsSchema'),read(source.ledger,EXTRA,'registry'),read(source.ledger,EXTRA,'feeOf',[id]),read(source.ledger,EXTRA,'earnOf',[id]),
      read(source.ledger,EXTRA,'ownerEscrow6',[id]),read(source.ledger,EXTRA,'refundableOf',[id]),read(source.ledger,EXTRA,'capOf',[id]),
      read(source.reserve,OWNER_ABI,'reserveOf',[id,d.owner]),read(source.registry,REGISTRY_ABI,'get',[intendedHost]),read(source.reserve,EXTRA,'ledger')]);
    if(!same(registry,source.registry.address)||!same(reserveLedger,source.ledger.address))throw Error('source authority binding differs');
    const value={id,source:{schema:Number(schema),rowId:d.id,exists:d.createdAt>0n,active:d.active,owner:d.owner,appRef:d.appRef,runner:d.runner,runnerOperator:d.runnerOperator,leaseUntil:d.leaseUntil,
      rate6:d.rate,balance6:d.balance6,spent6:d.spent6,publisherRecipient:fee[0],publisherFee6:fee[1],runnerRate6:earn[0],escrow6:earn[1],ownerEscrow6:ownerEscrow,refundable6:refundable,capRate6:cap,gasReserveWei:res.balanceWei},
      intendedHost:{id:intendedHost,operator:host.operator,payoutWallet:host.payoutWallet,active:host.active},destination:null,gasAdapter:null};
    if(destination){
      const dl=destination.ledger;
      const [rev,life,controller,identity,reg,boundLedger,sealed,existing,ownerPrincipal,hostPrincipal]=await Promise.all([
        read(dl,EXTRA,'deploymentsSchema'),read(dl,EXTRA,'lifecycleSchema'),read(dl,EXTRA,'lifecycleController'),read(dl,EXTRA,'selfHostingIdentity'),read(dl,EXTRA,'registry'),
        read(destination.controller,EXTRA,'ledger'),read(dl,EXTRA,'importsSealed'),read(dl,LEDGER_ABI,'get',[id]),read(destination.identity,EXTRA,'principal',[d.owner]),read(destination.identity,EXTRA,'principal',[host.payoutWallet])]);
      value.destination={ledger:dl.address,controller:destination.controller.address,schema:Number(rev),lifecycleSchema:Number(life),importsSealed:sealed,exists:existing.createdAt>0n,ownerPrincipal,hostPrincipal,
        pairMatches:same(controller,destination.controller.address)&&same(identity,destination.identity.address)&&same(reg,source.registry.address)&&same(boundLedger,dl.address)};
    }
    if(gasAdapter){const [l,r]=await Promise.all([read(gasAdapter,EXTRA,'ledger'),read(gasAdapter,EXTRA,'reserve')]);value.gasAdapter={address:gasAdapter.address,ledger:l,reserve:r};}
    return value;
  });
  if(result?.evidence?.proofVerified!==true || result.evidence.tier!=='l1-finalized-derived' || !positiveHash(result.blockHash)) throw Error('authenticated in-domain lifecycle snapshot required; RPC quorum is diagnostic only');
  return {schema:1,readOnly:true,executable:false,blockNumber:result.blockNumber,blockHash:result.blockHash,timestamp:result.timestamp,evidence:result.evidence,inventory:result.value,assessment:assessMigrationInventory(result.value)};
}
