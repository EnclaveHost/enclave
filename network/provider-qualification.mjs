// One qualification contract for direct hosts and TUNA providers. Evidence is
// produced by independent probes, never by a host setting its own ready flag.
import net from 'node:net';
import {recoverMessageAddress} from 'viem';
import {isBlockedHost} from '../relay/net-guard.mjs';

export const PROVIDER_CHECKS = Object.freeze([
  'tcp80', 'tcp443', 'udpEcho', 'outboundHttps', 'payloadIntegrity',
  'blocksPrivateDestinations', 'blocksOwnAddresses', 'blocksSmtp',
  'rejectsUnauthorizedProxy',
]);
const idPattern=/^0x[0-9a-f]{64}$/;
const addressPattern=/^0x[0-9a-fA-F]{40}$/;
export function publicProviderAddress(address) {
  return typeof address==='string' && !!net.isIP(address) && !isBlockedHost(address);
}
export function qualificationMessage(report) {
  const fields=['version','hostId','operator','address','issuedAt','expiresAt','checks'];
  if(!report||Object.keys(report).some(k=>!fields.includes(k))||report.version!==1||
    !idPattern.test(report.hostId)||!addressPattern.test(report.operator)||
    !publicProviderAddress(report.address)||!Number.isSafeInteger(report.issuedAt)||
    !Number.isSafeInteger(report.expiresAt)||report.expiresAt<=report.issuedAt||
    report.expiresAt-report.issuedAt>300000||!report.checks||
    Object.keys(report.checks).length!==PROVIDER_CHECKS.length||
    PROVIDER_CHECKS.some(k=>report.checks[k]!==true))throw new Error('provider qualification failed');
  return 'enclave-provider-qualification:v1\n'+JSON.stringify({version:1,hostId:report.hostId,
    operator:report.operator.toLowerCase(),address:report.address,issuedAt:report.issuedAt,
    expiresAt:report.expiresAt,checks:Object.fromEntries(PROVIDER_CHECKS.map(k=>[k,true]))});
}
export async function verifyQualification(envelope,{hostId,operator,address,probeSigners,now=Date.now()}) {
  if(!Array.isArray(probeSigners)||!probeSigners.length||probeSigners.some(a=>!addressPattern.test(a)))
    throw new Error('independent provider probe signers required');
  const r=envelope?.report,message=qualificationMessage(r);
  if(r.hostId!==hostId||r.operator.toLowerCase()!==operator.toLowerCase()||r.address!==address||
    r.issuedAt>now||r.expiresAt<=now)throw new Error('provider qualification is stale or for another host');
  const signer=(await recoverMessageAddress({message,signature:envelope.signature})).toLowerCase();
  if(signer===operator.toLowerCase()||!probeSigners.some(a=>a.toLowerCase()===signer))
    throw new Error('independent provider qualification signature required');
  return Object.freeze({...r,checks:Object.freeze({...r.checks}),signer});
}

// Each adapter must exercise the real transport. All checks run, including the
// negative isolation checks; a missing implementation fails qualification.
export async function qualifyProvider({hostId,operator,address,probe,signer,now=Date.now,validForMs=60000}) {
  if(!Number.isSafeInteger(validForMs)||validForMs<=0||validForMs>300000)throw new Error('invalid qualification lifetime');
  const issuedAt=now(),checks={};
  for(const name of PROVIDER_CHECKS) {
    if(typeof probe[name]!=='function'||await probe[name]({address})!==true)
      throw new Error('provider qualification failed: '+name);
    checks[name]=true;
  }
  const report={version:1,hostId,operator,address,issuedAt,expiresAt:issuedAt+validForMs,checks};
  const message=qualificationMessage(report);
  if(now()>=report.expiresAt)throw new Error('provider qualification expired during probes');
  if(signer.address.toLowerCase()===operator.toLowerCase())throw new Error('provider cannot qualify itself');
  return {report,signature:await signer.signMessage({message})};
}
