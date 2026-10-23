// Root incident operation: one app-funded renewal for an existing running protected guest.
// Uses unchanged production client, delegation and policy; never spends operator ETH or claims another deployment.
import fs from 'node:fs';
import {createPublicClient,http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {parseDeploymentRecord,LEDGER_ABI} from '../../custody-recipient-restore-20261023/repo/network/lease-gas-owner.mjs';
import {createLeaseClient} from '../../custody-recipient-restore-20261023/repo/client/lease-executor-client.mjs';
import {verifiedLeaseAuthority} from '../../custody-recipient-restore-20261023/repo/client/lease-executor-authority.mjs';
import {GuestdControl,parseKey} from '../../linux-post-adoption-release/stage/metal-deabf8f90/isolation/m4/guestd/control-client.mjs';
const allowed={'0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9':'gd9d4a391d','0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c':'gdd0646f2c'};
const id=process.argv[2];if(!allowed[id])throw Error('not a protected ID');
const dir=new URL('../evidence/protected-renewals-2239/',import.meta.url);fs.mkdirSync(dir,{recursive:true,mode:0o700});
const intent=new URL(id+'.intent.json',dir);if(fs.existsSync(intent))throw Error('Existing attempt: reconcile, never resend blindly');
const cfg=JSON.parse(fs.readFileSync('/home/steven/Projects/enclave/metal/config.json','utf8'));
const account=privateKeyToAccount(cfg.registryKey);if(account.address.toLowerCase()!=='0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab')throw Error('operator');
const dep=parseDeploymentRecord(fs.readFileSync('/home/steven/enclave-prod/lease-gas/deployment.json'),{expectedDigest:'sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089'});
const clients=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base-mainnet.public.blastapi.io'].map(url=>createPublicClient({transport:http(url,{timeout:12000,retryCount:0})}));
const a=await verifiedLeaseAuthority({clients,deployment:dep,quorum:2});
const row=await a.client.readContract({address:a.pins.ledger,abi:LEDGER_ABI,functionName:'get',args:[id]});
if(!row.active||row.runner.toLowerCase()!=='0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be'||row.runnerOperator.toLowerCase()!==account.address.toLowerCase())throw Error('not this operator active lease');
const pair=parseKey(fs.readFileSync('/home/steven/enclave-prod/guestd-pair.key','utf8'));
try{const c=new GuestdControl('http://127.0.0.1:8095',pair,{requestTimeoutMs:12000,maxResponseBytes:131072});const v=await c.request('GET','/vms/'+allowed[id]);if(v.status!==200||v.body.status!=='running'||v.body.name!==id)throw Error('protected guest not running');}finally{pair.fill(0)}
const stringify=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
const lc=createLeaseClient({clients,account,reserve:dep.reserve,deployment:dep,relays:cfg.leaseGas.relays,quorum:2,
 onSigned:async r=>{if(r.kind!=='renew'||r.lease.id!==id||r.lease.maxChargeWei>31092172031561n)throw Error('intent exceeds existing policy ceiling');
 const fd=fs.openSync(intent,'wx',0o600);try{fs.writeSync(fd,stringify(r));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}},
 log:()=>{}});
if(!process.argv.includes('--execute')){console.log(stringify({readOnly:true,id,guest:allowed[id],leaseUntil:row.leaseUntil,at:new Date().toISOString(),readyForClientPolicyCheck:true}));process.exit(0);}
try{const r=await lc.renew(id);const out={at:new Date().toISOString(),id,guest:allowed[id],hash:r.hash,chargedWei:r.verified.chargedWei,operatorEthSpent:false,receiptVerified:true};fs.writeFileSync(new URL(id+'.result.json',dir),stringify(out),{mode:0o600,flag:'wx'});console.log(stringify(out));}catch(e){console.error(JSON.stringify({code:e.code||'error',message:String(e.shortMessage||e.message).slice(0,450),intentExists:fs.existsSync(intent)}));process.exitCode=1}
