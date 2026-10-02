import {routeFor,openSplice} from '../isolation/m4/guestd/supervisor-splice.mjs';

// The trusted parent binds its broker to one deployment before any visitor
// bytes arrive. The partition manager verifies the complete route preamble;
// TLS bytes then reach the domain untouched, including a ClientHello with no
// SNI. The manager endpoints are never handed to the circuit's AppContainer.
export class ShieldIngress {
  constructor({url,dataAddr,expected,key,fetchFn=fetch,open=openSplice}) {
    const u=new URL(url),d=new URL('tcp://'+dataAddr);
    if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||
       d.hostname!=='127.0.0.1'||!d.port||d.username||d.password||d.pathname||d.search||d.hash)
      throw new Error('explicit loopback partition manager endpoints required');
    Object.assign(this,{url:u,expected,key,dataAddr,openSplice:open});
    this.transport={request:async(method,path)=>{
      if(method!=='GET'||!/^\/vms(?:\/[A-Za-z0-9-]{1,64})?$/.test(path))throw new Error('partition ingress is read-only');
      const response=await fetchFn(new URL(path,u),{signal:AbortSignal.timeout(10000),redirect:'error'});
      const text=await response.text();if(Buffer.byteLength(text)>1048576)throw new Error('partition manager reply too large');
      return {status:response.status,body:JSON.parse(text)};
    }};
  }
  async open(id) {
    const expected=this.expected(id);
    if(!expected||!/^0x[0-9a-f]{64}$/.test(id))throw new Error('unknown deployment');
    const response=await this.transport.request('GET','/vms');
    const matches=response.status===200&&Array.isArray(response.body?.vms)?response.body.vms.filter(v=>v.name===id&&v.status==='running'):[];
    if(matches.length!==1)throw new Error('deployment has no unique running partition');
    const route=await routeFor(this.transport,matches[0].id,expected.appSha256);
    if(!route.image||route.runtimeId!==expected.runtimeId)throw new Error('partition manager identity changed');
    const key=this.key?.(id);if(key&&route.key!==key)throw new Error('partition transport key changed');
    return this.openSplice(this.dataAddr,route);
  }
  forward=async(socket,id)=>{
    const guest=await this.open(id);if(socket.destroyed){guest.destroy();return;}
    const close=()=>{socket.destroy();guest.destroy();};
    socket.on('error',close);guest.on('error',close);socket.once('close',close);guest.once('close',close);
    socket.pipe(guest).pipe(socket);socket.resume();
  };
}
