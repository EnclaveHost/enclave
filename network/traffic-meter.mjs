import {Duplex} from 'node:stream';
import {DurableState} from './durable-state.mjs';
import {createHash} from 'node:crypto';

const GiB=1073741824n;
export function bandwidthCost6(bytes,pricePerGiB6) {
  if(typeof bytes!=='bigint'||typeof pricePerGiB6!=='bigint'||bytes<0n||pricePerGiB6<0n)throw new Error('invalid bandwidth amount');
  return (bytes*pricePerGiB6+GiB-1n)/GiB;
}
// Counters and cumulative cost survive restart. The settlement authorizer must
// reserve backed USDC and bind its receipt to this exact deployment and policy.
// It may never authorize by trusting an operator-supplied balance or owner.
export class TrafficMeter {
  constructor({directory,deploymentId,policyHash,terms,authorizeDebit,now=Date.now}) {
    if(!/^0x[0-9a-f]{64}$/.test(deploymentId)||!/^([0-9a-f]{64})$/.test(policyHash))throw new Error('bound meter identity required');
    Object.assign(this,{deploymentId,policyHash,terms,authorizeDebit,now});this.state=new DurableState(directory);
    this.key='traffic-'+createHash('sha256').update(deploymentId+':'+policyHash).digest('hex');
    if(BigInt(terms.pricePerGiB6)>0n&&typeof authorizeDebit!=='function')throw new Error('backed USDC settlement required');
  }
  async consume(direction,size) {
    if(!['in','out'].includes(direction)||!Number.isSafeInteger(size)||size<0)throw new Error('invalid byte counter');
    return this.state.update(this.key,async prior=>{
      if(this.terms.expiresAt<=this.now())throw new Error('bandwidth authorization expired');
      const old=prior||{in:'0',out:'0',cost6:'0'};
      const next={...old,[direction]:(BigInt(old[direction])+BigInt(size)).toString()};
      const cost=bandwidthCost6(BigInt(next.in)+BigInt(next.out),BigInt(this.terms.pricePerGiB6));
      if(cost>BigInt(this.terms.budget6))throw new Error('bandwidth budget exhausted');
      if(cost>BigInt(old.cost6))await this.authorizeDebit({deploymentId:this.deploymentId,policyHash:this.policyHash,
        cumulativeBytes:(BigInt(next.in)+BigInt(next.out)).toString(),cumulativeCost6:cost.toString()});
      next.cost6=cost.toString();return next;
    });
  }
}

// Charge before admitting bytes in either direction; the shared meter serializes
// concurrent sockets. Socket buffers cannot race a per-app spending ceiling.
export function meteredSocket(socket,consume,allowed) {
  socket.pause();let reading=false;
  const stream=new Duplex({
    read(){if(!reading){reading=true;socket.resume();}},
    write(chunk,encoding,done){
      if(!allowed())return done(new Error('network authorization expired'));
      Promise.resolve().then(()=>consume('out',chunk.length)).then(()=>{
        if(!allowed())throw new Error('network authorization expired');socket.write(chunk,encoding,done);
      }).catch(done);
    },
    final(done){socket.end(done);},
    destroy(error,done){socket.destroy();done(error);},
  });
  stream.on('error',()=>{});
  socket.on('data',chunk=>{
    socket.pause();reading=false;
    Promise.resolve().then(()=>{if(!allowed())throw new Error('network authorization expired');return consume('in',chunk.length);})
      .then(()=>{if(!allowed())throw new Error('network authorization expired');if(stream.push(chunk)){reading=true;socket.resume();}})
      .catch(e=>stream.destroy(e));
  });
  socket.on('end',()=>stream.push(null));socket.on('error',e=>stream.destroy(e));
  socket.on('close',()=>stream.destroy());return stream;
}
