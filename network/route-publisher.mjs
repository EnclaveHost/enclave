// Signs and distributes an app's route record (network/route-record.mjs) under the owner's v5 Enclave-network policy.
import {createPrivateKey,createPublicKey,randomBytes} from 'node:crypto';
import {DurableState} from './durable-state.mjs';
import {recordHash,signDelegation,signRoute,validateRoutePolicy} from './route-record.mjs';
import {namingKey,encodeDiscovery} from './discovery.mjs';

function routeKey(seed) {
  return createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
}
export class RoutePublisher {
  constructor({directory,account,lease,policy,qualification,distribute,now=Date.now}) {
    Object.assign(this,{account,lease,policy,qualification,distribute,now});this.state=new DurableState(directory);this.tails=new Map();
  }
  publish(id,routes) {
    const operation=(this.tails.get(id)||Promise.resolve()).catch(()=>{}).then(()=>this.write(id,routes));
    this.tails.set(id,operation);return operation;
  }
  async write(id,routes) {
    const lease=this.lease(id),policy=validateRoutePolicy(this.policy(id)),now=this.now();
    if(!lease||lease.validUntil<=now||!lease.active||!lease.isPublic||lease.runnerOperator.toLowerCase()!==this.account.address.toLowerCase()){
      await this.state.set('published-'+id,null);
      await this.distribute(id,null);return null;
    }
    const state=await this.state.update('identity-'+id,async old=>{
      const value=old||{seed:randomBytes(32).toString('hex'),sequence:0};
      if(!/^[0-9a-f]{64}$/.test(value.seed)||!Number.isSafeInteger(value.sequence)||value.sequence<0)throw new Error('damaged route identity');
      const seed=Buffer.from(value.seed,'hex'),key=routeKey(seed),{name}=await namingKey(seed);
      const previous=value.authorization?.delegation;
      if(!previous||previous.expiresAt<now+300000||previous.runner!==lease.runner||previous.policyHash!==recordHash(policy)||previous.deployments!==lease.deployments||previous.chainId!==lease.chainId){
        const epoch=Math.max(now,(previous?.epoch||0)+1);
        if(epoch>now)throw new Error('clock moved behind route delegation');
        value.authorization=await signDelegation(this.account,{version:2,deploymentId:id,runner:lease.runner,chainId:lease.chainId,
          deployments:lease.deployments,policyHash:recordHash(policy),epoch,notBefore:epoch,expiresAt:epoch+86400000,
          publicKey:createPublicKey(key).export({format:'der',type:'spki'}).toString('base64'),ipns:name},now);
      }
      value.sequence++;if(!Number.isSafeInteger(value.sequence))throw new Error('route sequence exhausted');return value;
    });
    // a direct route carries the host's current direct-hosting qualification, and lives no longer than it
    const qualification=policy.mode==='direct'&&routes.length?await this.qualification?.(id):undefined;
    if(policy.mode==='direct'&&routes.length&&(!qualification||qualification.report.expiresAt<=now))throw new Error('current provider qualification required');
    // a v5 policy carries no expiry of its own: the route lives at most a minute and is re-signed
    const expiresAt=Math.min(now+60000,lease.validUntil,lease.leaseUntil,state.authorization.delegation.expiresAt,qualification?.report.expiresAt??Infinity);
    if(expiresAt<=now)throw Error('route authorization expired');
    const signed=signRoute(routeKey(Buffer.from(state.seed,'hex')),{version:2,deploymentId:id,delegationHash:recordHash(state.authorization.delegation),
      sequence:state.sequence,issuedAt:now,expiresAt,routes,...(qualification?{qualification}:{})});
    const bundle={...signed,authorization:state.authorization};
    const encoded=await encodeDiscovery(bundle,Buffer.from(state.seed,'hex'));
    await this.state.set('published-'+id,{bundle,policy,name:encoded.name,cid:encoded.cid,ipns:Buffer.from(encoded.ipns).toString('base64')});
    await this.distribute(id,{bundle,policy,...encoded});return bundle;
  }
}
