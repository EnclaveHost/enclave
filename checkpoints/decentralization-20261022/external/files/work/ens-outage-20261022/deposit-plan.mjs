import {encodeFunctionData,keccak256,formatEther} from '../enclave/node_modules/viem/_esm/index.js';
import {OWNER_ABI,LEDGER_ABI} from '../enclave/network/lease-gas-owner.mjs';
export const OWNER='0x0b2d009c0c9Af05b12100D77F3c815fea822eE61';
export const APP='0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33';
export const RESERVE='0x12A3f873041Dec436DaA0085B766a399A6fA3639';
export const LEDGER='0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B';
const RCODE='0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979',LCODE='0x71d50076336283e774ba2ef8d5cbf7602e9cdc5dd918a7e7390c743367766682';
export function depositPlan(amountWei,{confirmed=()=>false}={}){
 const amount=BigInt(amountWei);if(![100000000000000n,1000000000000000n].includes(amount))throw Error('Unreviewed deposit amount');
 const tx={to:RESERVE,data:encodeFunctionData({abi:OWNER_ABI,functionName:'deposit',args:[APP]}),value:amount};
 const id=`adapter-reserve-recovery-20261022-${amount}`;
 return {id,from:OWNER,chainId:8453,summary:{title:'Restore the storage adapter’s lease reserve'},steps:[{id:'deposit',title:`Deposit ${formatEther(amount)} ETH for adapter lease gas`,links:[],effects:()=>[
 `Pays ${formatEther(amount)} ETH into the existing lease-gas reserve for deployment ${APP}.`,
 'The app pays future lease claims and renewals. This is separate from its USDC compute balance.',
 'Base network fees are additional. No contract, administrator, app version or configuration changes are included.',
 'Remaining reserve funds stay credited to this deployment’s owner. Runtime recovery is verified separately after confirmation.'
 ],async check(chain){
  if(chain.chainId!==8453)throw Error('Wrong chain');
  const s=await chain.snapshot(async(c,blockNumber)=>{
   const [rc,lc,d,r,balance]=await Promise.all([c.getCode({address:RESERVE,blockNumber}),c.getCode({address:LEDGER,blockNumber}),c.readContract({address:LEDGER,abi:LEDGER_ABI,functionName:'get',args:[APP],blockNumber}),c.readContract({address:RESERVE,abi:OWNER_ABI,functionName:'reserveOf',args:[APP,OWNER],blockNumber}),c.getBalance({address:OWNER,blockNumber})]);
   return {reserveHash:keccak256(rc||'0x'),ledgerHash:keccak256(lc||'0x'),id:d.id,owner:d.owner,active:d.active,reserveWei:r.balanceWei,enabled:r.enabled,balance};
  });
  const x=s.value,block={number:s.blockNumber,hash:s.blockHash,agreeing:s.agreeing,peers:s.peers};
  const facts={reserve:RESERVE,deployment:APP,currentReserveWei:String(x.reserveWei),depositWei:String(amount)};
  const blocked=reason=>({state:'blocked',reason,block,facts});
  if(x.reserveHash!==RCODE||x.ledgerHash!==LCODE)return blocked('Contract code differs from verified production');
  if(x.id.toLowerCase()!==APP||x.owner.toLowerCase()!==OWNER.toLowerCase())return blocked('Deployment identity or owner changed');
  if(!x.active||!x.enabled)return blocked('Deployment or its lease reserve is disabled');
  if(confirmed(id))return {state:'done',block,facts};
  if(x.balance<amount+20000000000000n)return blocked('Wallet balance does not cover deposit plus the fee allowance');
  return {state:'ready',block,facts,tx};
 }}]};
}
