import fs from 'node:fs';
import {GuestdControl,parseKey} from '../isolation/m4/guestd/control-client.mjs';
import {routeFor,openSplice} from '../isolation/m4/guestd/supervisor-splice.mjs';

// The app-bound TUNA broker reaches the authenticated guest manager directly.
// The control CVM, public DNS and SNI are not needed to select the guest. No
// pairing credential or manager socket is passed into a circuit sandbox.
export class GuestdIngress {
  constructor({url,keyFile,dataAddr,expected}){
    const u=new URL(url),data=typeof dataAddr==='string'?new URL('tcp://'+dataAddr):null;
    if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||!data||data.hostname!=='127.0.0.1'||!data.port)throw new Error('explicit loopback guest manager endpoints required');
    const st=fs.lstatSync(keyFile);
    if(!st.isFile()||(st.mode&0o077)!==0||(typeof process.getuid==='function'&&st.uid!==process.getuid()))throw new Error('private manager pairing key required');
    const client=new GuestdControl(url,parseKey(fs.readFileSync(keyFile,'utf8')));
    this.transport={request:(method,path,_body,timeoutMs)=>{if(method!=='GET')throw new Error('ingress manager access is read-only');return client.request(method,path,undefined,{timeoutMs:timeoutMs||10000,idempotent:true});}};
    this.dataAddr=dataAddr;this.expected=expected;
  }
  async open(id){
    const expected=this.expected(id);if(!expected||!/^0x[0-9a-f]{64}$/.test(id))throw new Error('unknown deployment');
    const response=await this.transport.request('GET','/vms',null,10000);
    const matches=response.status===200&&Array.isArray(response.body?.vms)?response.body.vms.filter(v=>v.name===id&&v.status==='running'):[];
    if(matches.length!==1)throw new Error('deployment has no unique running guest');
    const instance=matches[0];
    const route=await routeFor(this.transport,instance.id,expected.appSha256);
    if(route.runtimeId!==expected.runtimeId||route.measurement!==expected.measurement)throw new Error('guest manager identity changed');
    return openSplice(this.dataAddr,route);
  }
  forward=async(socket,id)=>{
    const guest=await this.open(id);if(socket.destroyed){guest.destroy();return;}
    const close=()=>{socket.destroy();guest.destroy();};
    socket.on('error',close);guest.on('error',close);socket.once('close',close);guest.once('close',close);
    socket.pipe(guest).pipe(socket);socket.resume();
  };
}
