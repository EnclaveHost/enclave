// Static reviewed prototype pins. These do not authenticate the caller's L1/parent.
import { createHash } from 'node:crypto';
export const POLICY=Object.freeze({
  unsafeSigner:'0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a',
  rollupConfigHash:'0x1607709d90d40904f790574404e2ad614eac858f6162faa0ec34c6bf5e5f3c57',
  scheduleId:'0x3d6185fc0e020da273b0abec02bd96263cd2f079f9f88db097fa683fb74ac896',
});
export function canonicalJson(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
export const canonicalConfigSha256=c=>createHash('sha256').update(canonicalJson(c)).digest('hex');
export function checkCapturePolicy(c){
  if(c.unsafeSigner!==POLICY.unsafeSigner)throw Error('unreviewed unsafe signer');
  if(c.base.expectedRollupConfigHash!==POLICY.rollupConfigHash)throw Error('unreviewed rollup config hash');
  if(c.base.expectedScheduleId!==POLICY.scheduleId)throw Error('unreviewed schedule id');
}
export function bindNativeResult(j,cap,context){
  checkCapturePolicy(context);
  if(cap.rollupConfigHash!==POLICY.rollupConfigHash||cap.scheduleId!==POLICY.scheduleId||
    cap.canonicalRollupConfigSha256!==canonicalConfigSha256(context.base.rollupConfig))throw Error('capture config/schedule binding mismatch');
  if(j.format!=='enclave-signed-payload-candidate/v1'||j.authority!==false||j.refused||j.hash!==cap.candidateHash||
    j.parentHash!==cap.parentHash||j.outputRoot!==cap.outputRoot||j.coverage?.toBlock!==cap.number||j.coverage?.blocks?.length!==1||
    j.rollupConfigHash!==cap.rollupConfigHash||j.scheduleId!==cap.scheduleId)throw Error('native result does not bind captured candidate/config/schedule');
}
