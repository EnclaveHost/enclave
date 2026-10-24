// Compile only the guest's already-persisted, private captured intent. No wallet access or broadcasting here.
import {readCapturedGenesis} from './genesis-capture.mjs';
import {readHostStep} from './read-steps.mjs';
import {ORIGINAL_VAULT_V2,OLD_COMMITTEE_4774,METAL0_OPERATOR} from './plan.mjs';
import {MAX_QUOTE_AGE_MS} from './attestation.mjs';
import {sha256hex} from './canonical.mjs';
const LOCAL=Symbol('genesis-prepare-local');
const need=(v,m)=>{if(!v)throw Object.assign(Error('genesis preparation refused: '+m),{[LOCAL]:true});};
export function requireFreshQuote(quote,now=()=>Date.now()) {
 const time=now();need(Number.isSafeInteger(quote?.requestedAt)&&Number.isSafeInteger(quote?.verifiedAt)
  &&quote.verifiedAt>=quote.requestedAt&&time>=quote.verifiedAt&&time-quote.requestedAt<=MAX_QUOTE_AGE_MS,'fresh verified quote required');
}
export async function compileCapturedGenesis({dir,endpoint,reader,attest,digests,viem,abi,now=()=>Date.now()}) {
 try {
  const captured=readCapturedGenesis({dir,endpoint});
  const [salt,machine,Y,codeSet,identitySig,hostSig]=captured.request.args;
  const quote=await attest();requireFreshQuote(quote,now);
  need(['identity','encKey','endpoint','chipId','registryId','measurement'].every(k=>machine[k]===quote.machine?.[k]),'capture does not name the freshly attested machine');
  const host=await readHostStep({reader,now});
  const common={chainId:8453,vault:ORIGINAL_VAULT_V2,machine};
  const committeeId=digests.committeeIdOf({...common,salt,Y});
  need(/^0x[0-9a-f]{64}$/.test(committeeId)&&committeeId!==OLD_COMMITTEE_4774,'invalid or protected committee id');
  const identity=await digests.recoverDigest(digests.genesisDigest({...common,committeeId,Y,codeSet}),identitySig);
  const operator=await digests.recoverDigest(digests.hostDigest(common),hostSig);
  need(identity===machine.identity&&operator===METAL0_OPERATOR,'guest or host authorization signature differs');
  const existing=await reader.readCommittee({committeeId});
  need(existing&&existing.committee===null&&existing.pending===null,'committee already exists or absence is unproven; reconcile prior intent');
  requireFreshQuote(quote,now);
  const data=viem.encodeFunctionData({abi,functionName:'createCommittee',args:captured.request.args});
  return {data,quote,captureDigest:captured.digest,summary:{committeeId,captureDigest:captured.digest,
   calldataSha256:sha256hex(Buffer.from(data.slice(2),'hex')),attestation:quote.publicEvidence,host:host.evidence}};
 }catch(e){if(e?.[LOCAL])throw e;throw Error('genesis preparation refused: capture, attestation or authority verification failed');}
}
