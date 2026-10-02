import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomBytes,generateKeyPairSync} from 'node:crypto';
import {buildHvNodeFrame} from '../windows/node/hvnode-evidence.mjs';
import {makeCredential} from '../relay/vbs-credential.mjs';
import {verifyHvNodeEvidence} from '../relay/hvnode-verify.mjs';

// A private TPM tool instance owns a transient AIK. It neither changes the boot
// policy nor replaces the production node's attestation session. No Nan input is
// used to mint the challenge, activate the credential, or verify the response.
export class ShieldHostProof {
  constructor({binary,sha256,policy,now=Date.now,spawnProcess=spawn}){
    if(!path.isAbsolute(binary)||!/^[0-9a-f]{64}$/.test(sha256)||!policy?.ekRoots||!Array.isArray(policy.platforms)||!policy.platforms.length)throw new Error('pinned TPM tool and explicit platform policy required');
    Object.assign(this,{binary,sha256,policy,now,spawnProcess});this.pending=null;this.current=null;this.closed=false;
  }
  async get(){
    if(this.closed)throw new Error('host proof collector closed');
    if(this.current?.expiresAt>this.now())return this.current.session;
    if(this.pending)return this.pending;
    this.pending=this.collect().finally(()=>this.pending=null);return this.pending;
  }
  close(){this.closed=true;this.stop?.();this.current=null;}
  async collect(){
    const startedAt=this.now();
    if(createHash('sha256').update(fs.readFileSync(this.binary)).digest('hex')!==this.sha256)throw new Error('TPM executable does not match its pin');
    const child=this.spawnProcess(this.binary,[],{stdio:['pipe','pipe','ignore'],windowsHide:true});
    const lines=createInterface({input:child.stdout});let waiter,readyResolve,readyReject,done=false;
    const finish=e=>{if(done)return;done=true;clearTimeout(startTimer);waiter?.reject(e);waiter=null;readyReject(e);lines.close();child.stdin.destroy();child.kill();};
    this.stop=()=>finish(new Error('host proof collector stopped'));
    const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j});
    const startTimer=setTimeout(()=>finish(new Error('TPM tool startup timeout')),10000);
    child.on('error',finish);child.once('exit',()=>finish(new Error('TPM tool exited')));child.stdin.on('error',finish);
    lines.on('line',line=>{
      if(line.length>131072){finish(new Error('oversized TPM response'));return;}
      if(line.startsWith('ready ')){clearTimeout(startTimer);readyResolve();return;}
      if(!waiter)return;
      if(line==='ok'){const w=waiter;waiter=null;w.resolve(w.values);return;}
      if(line.startsWith('err ')){const w=waiter;waiter=null;w.reject(new Error('TPM command refused'));return;}
      const i=line.indexOf(' ');if(i>0)waiter.values[line.slice(0,i)]=line.slice(i+1);
    });
    const tpm=command=>new Promise((resolve,reject)=>{
      if(done||waiter){reject(new Error('TPM command unavailable'));return;}
      const timer=setTimeout(()=>finish(new Error('TPM command timeout')),10000);
      waiter={values:{},resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}};
      child.stdin.write(command+'\n');
    });
    try{
      await ready;
      const keys=await tpm('keys');
      for(const key of ['ek-cert','aik-name'])if(typeof keys[key]!=='string'||!/^([0-9a-f]{2})+$/i.test(keys[key]))throw new Error('invalid TPM identity response');
      const ekCert=Buffer.from(keys['ek-cert'],'hex'),aikName=Buffer.from(keys['aik-name'],'hex');
      if(ekCert.length>16384||aikName.length!==34)throw new Error('TPM identity exceeds limits');
      const nonce=randomBytes(32),expectedCredential=randomBytes(32),key=generateKeyPairSync('ed25519'),spki=key.publicKey.export({format:'der',type:'spki'});
      const {credentialBlob,secret}=makeCredential(ekCert,aikName,expectedCredential);
      const frame=await buildHvNodeFrame({nonce,credentialBlob,secret,spki,privateKey:key.privateKey,tpm});
      const session={evidence:JSON.parse(Buffer.from(frame.rad.body,'base64')),nonce,transportKeySpki:spki,expectedCredential,mintedFor:{ekCert,aikName}};
      const verdict=verifyHvNodeEvidence(session,this.policy);
      if(!verdict.ok||!verdict.admissible||!this.policy.platforms.some(p=>p.ekCertSha256===verdict.boot?.ekCertSha256&&p.pcr0===verdict.boot?.pcr0))throw new Error('fresh TPM/platform proof refused: '+(verdict.reasons||[]).join('; '));
      if(this.closed||startedAt+30000<=this.now())throw new Error('host proof expired during collection');
      this.current={session,expiresAt:startedAt+30000};return session;
    }finally{finish(new Error('TPM proof complete'));this.stop=null;}
  }
}
