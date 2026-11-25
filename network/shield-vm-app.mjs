// A whole-VM app on an Enclave Shield host (a VBS-isolated Hyper-V partition under the OpenHCL paravisor): the same
// app image as on an SEV-SNP host, behind the same front (isolation/vmboot/front), with this platform's report.
//
// The front's fresh document has format "shield-vm-v1" and carries the paravisor's HCLA envelope around a VBS VM
// report. It is accepted when
//   - the report is signed by the VSM identity key (IDKS) of a host boot the caller authenticated (TPM quote,
//     credential, measured-boot log: relay/hvnode-verify.mjs), never by a key the guest or its document names;
//   - its measurement is a boot digest the app's catalog version lists for this platform and its guest SVN is at
//     least that entry's (and its signer the entry's, when the version pins one);
//   - its 64 bytes of data are sha256(the TLS key this connection presented || the nonce just sent) and then the
//     32-byte deployment id. The VBS report has no launch field the host sets, so the guest's front states the
//     deployment its launcher named at boot under the same signature: the host chooses it at launch as it chooses
//     HOST_DATA on SEV-SNP, and a guest launched for another deployment cannot pass for this one.
// What it does not show is what a Shield verdict never shows: that the host cannot read the partition. The host's
// boot is attested and the host is not excluded.
import {createHash} from 'node:crypto';
import {verifyHvNodeEvidence} from '../relay/hvnode-verify.mjs';
import {parseTcgLog,vsmKey} from '../relay/vbs-tcglog.mjs';
import {rsaKeyFromModulus} from '../relay/vbs-verify.mjs';
import {verifyVbsVmReport} from '../relay/vbs-vm-report.mjs';
import {platformsValid,platformAdmitted} from '../relay/vbs-app-core.mjs';
import {validShieldLaunch,wholeVmRuntimeId} from './snp-vm-app.mjs';

export const SHIELD_VM_FORMAT='shield-vm-v1';
const DEPLOYMENT=/^0x[0-9a-f]{64}$/,MAX_REPORT_CHARS=12000;

// the 64 bytes the front asks its platform to sign (isolation/vmboot/front: main.go fresh, source.go Bind)
export function shieldVmUserData(spki,nonce,deploymentId){
  return Buffer.concat([createHash('sha256').update(spki).update(nonce).digest(),Buffer.from(deploymentId.slice(2),'hex')]);
}

// The report against the version's launch identities, under an IDKS key the CALLER authenticated from a verified host
// boot. -> {ok:true, measurement, guestSvn} | {ok:false, reason}
export function judgeShieldVmReport(doc,spki,nonce,{deploymentId,expected,idksPublicKey}={}){
  const no=reason=>({ok:false,reason});
  try{
    if(!Buffer.isBuffer(spki)||spki.length<32||spki.length>4096||!Buffer.isBuffer(nonce)||nonce.length!==32)return no('actual TLS SPKI and fresh nonce required');
    if(!DEPLOYMENT.test(deploymentId||'')||/^0x0{64}$/.test(deploymentId))return no('a whole-VM report is judged only against a named deployment');
    if(!expected||!validShieldLaunch(expected.shield)||wholeVmRuntimeId(expected)!==expected.runtimeId)return no('the version publishes no Enclave Shield launch identity, or it is not the expected runtime');
    if(doc?.format!==SHIELD_VM_FORMAT)return no('not a Shield whole-VM document');
    if(typeof doc.report!=='string'||!doc.report.length||doc.report.length>MAX_REPORT_CHARS||!/^[A-Za-z0-9+/]+={0,2}$/.test(doc.report))return no('no report');
    const launch=expected.shield,pinned=launch.filter(e=>e.identity!==undefined);
    // a version pins the signer of every boot image it lists or of none: half a pin set is no pin set
    if(pinned.length&&pinned.length!==launch.length)return no('the version pins the signer of some Shield boot images and not others');
    const r=verifyVbsVmReport({envelope:Buffer.from(doc.report,'base64'),idksPublicKey,expectedUserData:shieldVmUserData(spki,nonce,deploymentId),
      allowedMeasurements:launch.map(e=>e.bootDigest),minimumGuestSvn:0,
      ...(pinned.length?{imageIdentities:launch.map(e=>({measurement:e.bootDigest,identity:e.identity,minimumGuestSvn:e.guestSvn}))}:{})});
    if(r.ok!==true)return no(r.reason||'report refused');
    const entry=launch.find(e=>e.bootDigest===r.measurement);
    if(!entry||!(r.guestSvn>=entry.guestSvn))return no('guest SVN below the version\'s');
    return {ok:true,measurement:r.measurement,guestSvn:r.guestSvn};
  }catch(e){return no(e.message);}
}

// The front's answer judged by a host's own agent: hostSession is this host's complete authenticated boot session,
// policy the operator's {ekRoots, platforms} (the Shield app policy's; the image list is the catalog version's, not
// the operator's). -> {ok:true, measurement, guestSvn} | {ok:false, reason}
export function verifyShieldVmProof(doc,spki,nonce,{deploymentId,expected,hostSession,policy}={}){
  const no=reason=>({ok:false,reason});
  try{
    if(!policy||!platformsValid(policy.platforms))return no('explicit TPM identity and platform firmware pins (or "attested") are required');
    if(!hostSession||hostSession.capture)return no('a complete authenticated host session is required');
    const host=verifyHvNodeEvidence(hostSession,{ekRoots:policy.ekRoots});
    if(!host.ok||!host.admissible)return no('host boot verification failed: '+host.reasons.join('; '));
    // the key comes only from the log the TPM verification just authenticated
    const key=vsmKey(parseTcgLog(Buffer.from(hostSession.evidence.log,'base64')).events,'IDKS');
    if(!key)return no('authenticated boot log contains no IDKS');
    const v=judgeShieldVmReport(doc,spki,nonce,{deploymentId,expected,idksPublicKey:rsaKeyFromModulus(key.modulus,key.exponent)});
    if(!v.ok)return v;
    if(!platformAdmitted(policy.platforms,host.boot))return no('authenticated TPM/platform pair is not admitted');
    return v;
  }catch(e){return no(e.message);}
}
