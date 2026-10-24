// READ ONLY. Discovery supplements the frozen October20 inventory; discovered state is quorum-read separately.
import fs from 'node:fs';
import {decodeEventLog,parseAbi} from 'viem';
import {pinBlock,logs,LIVE,readMany} from '../lib/live.mjs';
const old=JSON.parse(fs.readFileSync(new URL('../../existing-custody-audit/evidence/live-custody.json',import.meta.url)));
const V='0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5',HO='0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7',REG='0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC';
const abi=parseAbi(['event CommitteeCreated(bytes32 indexed committeeId,address indexed identity,bytes Y)','event PolicyUpdated(bytes32 indexed id,address indexed owner,uint64 policyRev,bytes32 committeeId,bool paused)','event BundlePut(bytes32 indexed id,uint64 secretRev,bytes32 committeeId,uint256 bundleBytes)','event PolicyClaimed(bytes32 indexed id,address indexed previousOwner,address indexed newOwner,uint64 policyRev)']);
const block=await pinBlock();const fromBlock=BigInt(old.block.number)+1n;
const raw=await logs({addresses:[V],fromBlock,toBlock:block.number});
const events=raw.map(l=>{try{const e=decodeEventLog({abi,data:l.data,topics:l.topics});return {block:l.blockNumber,tx:l.transactionHash,name:e.eventName,id:e.args.id||null,committeeId:e.args.committeeId||null,identity:e.args.identity||null};}catch{return {block:l.blockNumber,tx:l.transactionHash,name:'other',topic:l.topics[0]};}});
const committees=[...new Set([...old.committees.map(c=>c.committeeId),...events.filter(e=>e.name==='CommitteeCreated').map(e=>e.committeeId)])];
const policies=[...new Set([...old.policies.map(c=>c.id),...events.map(e=>e.id).filter(Boolean)])];
const hAbi=parseAbi(['function authority(bytes32) view returns(address owner,address pendingOwner,uint64 revision,bytes32 policyHash)']);
const rAbi=parseAbi(['function get(bytes32) view returns((string endpoint,string repo,bytes32 measurement,address operator,uint64 registeredAt,uint64 lastSeen,bool active,uint64 cpuPricePerSec6,uint64 gpuPricePerSec6,address proofKey,address payoutWallet))']);
const registryId='0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be';
const vals=await readMany(block,[{address:HO,abi:hAbi,functionName:'authority',args:[registryId]},{address:REG,abi:rAbi,functionName:'get',args:[registryId]}]);
const [owner,pendingOwner,revision,policyHash]=vals[0].value;const h=vals[1].value;
const out={at:new Date().toISOString(),readOnly:true,block,baselineBlock:old.block,fromBlock,discoveryProvider:LIVE.logs[0],discoveryLimit:'Delta logs from one provider can omit events. This is not independently exhaustive discovery.',stateProviders:LIVE.state,events,committees,policies,host:{registryId,owner,pendingOwner,revision,policyHash,operator:h.operator,payoutWallet:h.payoutWallet,active:h.active,lastSeen:h.lastSeen,endpoint:h.endpoint}};
fs.writeFileSync(new URL('../evidence/discover-delta.json',import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log(JSON.stringify({at:out.at,events:events.length,committees:committees.length,policies:policies.length,owner,pendingOwner,active:h.active}));
