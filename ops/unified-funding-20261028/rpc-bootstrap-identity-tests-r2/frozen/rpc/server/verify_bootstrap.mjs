// Owner-selected bootstrap verification. No Enclave registry/service or default
// authority is consulted. The caller owns the fresh one-use challenge and must
// enforce its original deadline; this evidence never grants storage by itself.
import {X509Certificate} from 'node:crypto';
import {RPC_BOOTSTRAP_PURPOSE,rpcStorageRequestBytes,rpcBootstrapBinding,sha256} from '../../isolation/contract/rpc-bootstrap.mjs';
import {runtimeId} from '../../isolation/contract/runtime.mjs';
import {verifyHvNodeEvidence} from '../../relay/hvnode-verify.mjs';
import {parseTcgLog,vsmKey} from '../../relay/vbs-tcglog.mjs';
import {rsaKeyFromModulus} from '../../relay/vbs-verify.mjs';
import {verifyVbsVmReport} from '../../relay/vbs-vm-report.mjs';
import {platformAdmitted,platformsValid} from '../../relay/vbs-app-core.mjs';
import {validImageIdentity} from '../../relay/vbs-image-identity.mjs';
const decode=(v,max)=>{
 if(typeof v!=='string' || v.length===0 || v.length>Math.ceil(max/3)*4) throw Error('bounded canonical base64 required');
 const b=Buffer.from(v,'base64');if(b.length>max || b.toString('base64')!==v) throw Error('bounded canonical base64 required');return b;
};
// handshakeCertificate is the actual client certificate from the owner's TLS
// session, never a value copied from the report. expectedRequest/runtime/image
// policy come from the owner's deployment decision. HostSession must be the
// owner's independently challenged full TPM session, not a captured report.
export function verifyRPCBootstrap({evidence,expectedRequest,expectedRuntimeId,challenge,handshakeCertificate,hostSession}={},policy={}) {
 const no=reason=>({ok:false,reason});
 try {
  if(policy.schema!=='enclave-rpc-bootstrap-policy/1' || !platformsValid(policy.platforms)) return no('explicit owner bootstrap policy required');
  const raw=rpcStorageRequestBytes(expectedRequest);
  const e=evidence;
  const names=['purpose','request','requestSha256','runtime','transportKey','certificate','rootsGranted','rpcReady','challenge','vbsVmReport'];
  if(!e || Reflect.ownKeys(e).length!==names.length || !names.every(k=>Object.hasOwn(e,k)) || e.purpose!==RPC_BOOTSTRAP_PURPOSE || e.rpcReady!==false || e.rootsGranted!==false) return no('bootstrap-only evidence required');
  if(!rpcStorageRequestBytes(e.request).equals(raw) || e.requestSha256!==sha256(raw).toString('hex')) return no('exact owner request differs');
  const rid=runtimeId(e.runtime);
  if(rid.toString('hex')!==expectedRuntimeId) return no('runtime differs from owner expectation');
  if(!Buffer.isBuffer(challenge) || challenge.length!==32 || e.challenge!==challenge.toString('hex')) return no('fresh owner challenge differs');
  const cert=decode(e.certificate,16384),spki=decode(e.transportKey,4096);
  if(!Buffer.isBuffer(handshakeCertificate) || !cert.equals(handshakeCertificate)) return no('actual TLS client certificate differs');
  const x=new X509Certificate(cert);
  if(x.ca || !x.raw.equals(cert) || !x.publicKey.export({type:'spki',format:'der'}).equals(spki) || !x.verify(x.publicKey)) return no('guest self-signed client key differs');
  const candidates=(Array.isArray(policy.images)?policy.images:[]).filter(p=>p?.rpcBootstrap===true && p.runtimeId===expectedRuntimeId && p.profileSha256===expectedRequest.profile && /^[0-9a-f]{64}$/.test(p.measurement||'') && validImageIdentity(p.identity));
  if(!candidates.length) return no('no owner-accepted bootstrap image/runtime/profile');
  if(!hostSession || hostSession.capture) return no('independently challenged host session required');
  const host=verifyHvNodeEvidence(hostSession,{ekRoots:policy.ekRoots});
  if(!host.ok || !host.admissible || !platformAdmitted(policy.platforms,host.boot)) return no('authenticated host boot or platform refused');
  const events=parseTcgLog(Buffer.from(hostSession.evidence.log,'base64')).events,key=vsmKey(events,'IDKS');
  if(!key) return no('authenticated boot has no IDKS');
  const binding=rpcBootstrapBinding({request:expectedRequest,spki,certificate:cert,challenge,runtime:rid});
  const result=verifyVbsVmReport({envelope:decode(e.vbsVmReport,9000),idksPublicKey:rsaKeyFromModulus(key.modulus,key.exponent),expectedUserData:Buffer.concat([binding,Buffer.from(expectedRequest.appId,'hex')]),allowedMeasurements:candidates.map(p=>p.measurement),imageIdentities:candidates.map(p=>({measurement:p.measurement,identity:p.identity})),minimumGuestSvn:policy.minimumGuestSvn??0});
  if(!result.ok) return result;
  return {ok:true,purpose:RPC_BOOTSTRAP_PURPOSE,measurement:result.measurement,requestSha256:e.requestSha256,certificateSha256:sha256(cert).toString('hex'),spkiSha256:sha256(spki).toString('hex'),rootsGranted:false,rpcReady:false,hostExcluded:false};
 } catch(e) {return no(e.message);}
}
