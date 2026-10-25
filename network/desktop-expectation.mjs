// Derive the native startup identity from operator policy and the current public
// deployment. The manager is compared to that result; it does not choose it.
import { validateDesktopRelease, desktopRecordFor, deriveApprovedDesktop } from '../relay/shield-desktop-release.mjs';
import { shieldImageCandidates } from '../relay/shield-image-candidates.mjs';
import { DESKTOP_DERIVATION } from '../relay/shield-desktop-derive.mjs';

export function desktopExpectation({ row, version, vms, policy, inputs }) {
  try {
    const release = validateDesktopRelease(policy.desktop);
    if (row.isPublic !== true || version.yanked === true) throw new Error('native enrollment requires a current public deployment');
    if (!inputs || !Buffer.isBuffer(inputs.component) || inputs.component.length > (256 << 20))
      return { wait: 'native enrollment needs the independently resolved configuration and controller bytes' };
    const ref = /^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/i.exec(String(row.appRef));
    if (!ref) throw new Error('native enrollment requires a catalog app');
    const record = desktopRecordFor({release,app:ref[1].toLowerCase(),version:Number(ref[2]),
      cid:version.cid,memMiB:Number(version.memMb),ports:version.ports,deploymentId:String(row.id).toLowerCase(),
      cpuMilli:Number(row.cpuMilli),gpuMilli:Number(row.gpuMilli),config:inputs.config});
    const mapping = deriveApprovedDesktop({release,record,component:inputs.component});
    const expected = {appRef:String(row.appRef),configCid:String(row.configCid),appSha256:mapping.appId,
      runtimeId:release.runtimeId,requiresDesktop:true,requiresConfigBundleV5:true,requiresSecretsV1:true,
      requiresConfigSocketServer:true,desktop:{recordSha256:mapping.recordSha256,controllerSha256:release.controllerSha256,
        igvmSha256:release.igvmSha256,profile:record.desktop.profile,profileSha256:release.profileSha256,gpuMilli:record.desktop.gpuMilli}};
    if (!shieldImageCandidates(policy,expected).length) throw new Error('native release has no fully admitted image');
    const matches=vms.filter(v=>v.name===record.secretDeployment&&!v.recovered&&!v.launching&&v.directBootstrap!==true&&
      (v.status==='starting'||v.status==='running'&&v.appReady===true));
    if (matches.length!==1) return {wait:'native enrollment needs one current starting or ready partition'};
    const vm=matches[0];
    for (const [key,value] of Object.entries({derivation:DESKTOP_DERIVATION,cid:record.cid,
      secretDeployment:record.secretDeployment,recordSha256:mapping.recordSha256,componentSha256:mapping.componentSha256,
      appId:mapping.appId,runtimeId:release.runtimeId,imageRole:'desktop',image:release.igvmSha256,igvmSha256:release.igvmSha256}))
      if(vm[key]!==value)throw new Error(`native manager ${key} differs from the independently derived identity`);
    if(vm.catalog?.app!==record.catalog.app||vm.catalog?.version!==record.catalog.version)
      throw new Error('native manager catalog differs from the current deployment');
    for(const key of ['profile','profileSha256','gpuMilli'])
      if(vm.desktop?.[key]!==record.desktop[key])throw new Error(`native manager ${key} differs from the approved release`);
    return {expected,startupEgress:true};
  } catch(e) { return {skip:e.message}; }
}
