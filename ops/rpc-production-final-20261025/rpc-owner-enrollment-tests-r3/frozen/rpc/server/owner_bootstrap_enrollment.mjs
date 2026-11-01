// Native enrollment is an untrusted candidate. This binds its public fields to
// the owner's prepared request; only createOwnerBootstrap.accept authenticates
// the TPM/guest evidence. Never infer VM ownership from a receipt hash.
import fs from 'node:fs';
import {X509Certificate} from 'node:crypto';
import {rpcStorageRequestBytes,sha256,RPC_BOOTSTRAP_PURPOSE} from '../../isolation/contract/rpc-bootstrap.mjs';
import {runtimeId} from '../../isolation/contract/runtime.mjs';
import {base64,persist} from './owner_bootstrap_session.mjs';

export function validateEnrollment(config){
 const {candidate,receiptSha256}=config.enrollment;
 if(!/^[0-9a-f]{64}$/.test(receiptSha256)||!candidate||Object.keys(candidate).sort().join(',')!=='info,keys')throw Error('exact enrollment binding required');
 const p=candidate.info,names=['purpose','request','requestSha256','runtime','transportKey','certificate','rootsGranted','rpcReady'];
 if(!p||Object.keys(p).length!==names.length||!names.every(k=>Object.hasOwn(p,k))||p.purpose!==RPC_BOOTSTRAP_PURPOSE||p.rootsGranted!==false||p.rpcReady!==false)throw Error('ungranted public enrollment required');
 const request=rpcStorageRequestBytes(config.request);
 if(!rpcStorageRequestBytes(p.request).equals(request)||p.requestSha256!==sha256(request).toString('hex')||runtimeId(p.runtime).toString('hex')!==config.runtime||p.certificate!==config.clientCertificate||JSON.stringify(candidate.keys)!==JSON.stringify(config.keys))throw Error('owner enrollment identity differs');
 const der=base64(p.certificate,16384),cert=new X509Certificate(der),spki=base64(p.transportKey,4096);
 if(!cert.raw.equals(der)||cert.ca||cert.publicKey.asymmetricKeyType!=='ed25519'||!cert.verify(cert.publicKey)||!cert.publicKey.export({type:'spki',format:'der'}).equals(spki))throw Error('exact guest public credential required');
 return {receiptSha256,requestSha256:p.requestSha256,certificateSha256:sha256(der).toString('hex'),guestAuthenticated:false,rootsGranted:false,rpcReady:false};
}

export function publishHostOffer(session,{proof,certificate,delivery,enrollment}){
 const ownerServerDer=new X509Certificate(certificate).raw.toString('base64');
 if(!delivery||Object.keys(delivery).sort().join(',')!=='exportServerDer,policy')throw Error('prepared owner delivery required');
 base64(delivery.exportServerDer,16384);base64(delivery.policy,65536);
 if(proof.offer.serverCertificateSha256!==sha256(Buffer.from(ownerServerDer,'base64')).toString('hex')||proof.offer.requestSha256!==enrollment.requestSha256||proof.offer.clientCertificateSha256!==enrollment.certificateSha256)throw Error('signed offer differs from enrolled identity');
 const raw=Buffer.from(JSON.stringify({proof,ownerServerDer,...delivery}));
 if(raw.length>131072)throw Error('native owner offer frame bound');
 // Same private one-shot directory as the challenge. Durable before a collector
 // can forward it into the native worker's fixed owner-offer.json input.
 persist(session.directory,'enrollment.json',Buffer.from(JSON.stringify(enrollment)+'\n'));
 persist(session.directory,'host-offer.pending',raw);
 const directory=`/proc/self/fd/${session.directory}/`;
 // Publish only complete fsynced bytes. link is atomic and refuses an existing
 // destination; unlike rename it cannot overwrite a prior publication. After
 // the pending link is removed the consumer can require a single-link inode.
 fs.linkSync(directory+'host-offer.pending',directory+'host-offer.json');
 fs.unlinkSync(directory+'host-offer.pending');fs.fsyncSync(session.directory);
 return raw;
}
