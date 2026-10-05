import {randomBytes,timingSafeEqual} from 'node:crypto';
import net from 'node:net';
import {lookup} from 'node:dns/promises';
import {publicProviderAddress} from './provider-qualification.mjs';
import {meteredSocket} from './traffic-meter.mjs';
import {parseIp} from '../relay/net-guard.mjs';

export async function directDestination(host,port,{ownAddresses=[],resolve=lookup}={}) {
  if(!Number.isInteger(port)||port<1||port>65535||port===25||typeof host!=='string'||host.length>253)
    throw new Error('destination refused');
  const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await resolve(host,{all:true,verbatim:true});
  const own=ownAddresses.map(parseIp).filter(Boolean);
  if(!addresses.length||addresses.some(a=>!publicProviderAddress(a.address)||own.some(ip=>{
    const target=parseIp(a.address);return target&&target.family===ip.family&&target.value===ip.value;
  })))
    throw new Error('destination refused');
  return addresses[0]; // connect to the judged literal, never resolve twice
}
export async function createDirectEgress({authorize,meter,ownAddresses=[],resolve=lookup,connect=net.connect}) {
  const username=randomBytes(16).toString('hex'),password=randomBytes(16).toString('hex');
  const sockets=new Set();
  const server=net.createServer(socket=>{
    if(sockets.size>=1024||!authorize())return socket.destroy();
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    socket.setTimeout(10000,()=>socket.destroy());let buffer=Buffer.alloc(0),phase=0;
    const fail=()=>socket.end(Buffer.from([5,2,0,1,0,0,0,0,0,0]));
    const read=async chunk=>{
      buffer=Buffer.concat([buffer,chunk]);if(buffer.length>65536)return socket.destroy();
      if(phase===0){
        if(buffer.length<2)return;
        if(buffer[0]!==5)return socket.destroy();
        const length=2+buffer[1];if(buffer.length<length)return;
        if(!buffer.subarray(2,length).includes(2))return socket.end(Buffer.from([5,255]));
        buffer=buffer.subarray(length);phase=1;socket.write(Buffer.from([5,2]));
      }
      if(phase===1){
        if(buffer.length<2)return;
        if(buffer[0]!==1)return socket.destroy();
        const userEnd=2+buffer[1];if(buffer.length<=userEnd)return;
        const end=userEnd+1+buffer[userEnd];if(buffer.length<end)return;
        const user=buffer.subarray(2,userEnd),pass=buffer.subarray(userEnd+1,end);
        if(user.length!==32||pass.length!==32||!timingSafeEqual(user,Buffer.from(username))||!timingSafeEqual(pass,Buffer.from(password)))
          return socket.end(Buffer.from([1,1]));
        buffer=buffer.subarray(end);phase=2;socket.write(Buffer.from([1,0]));
      }
      if(phase!==2||buffer.length<4)return;
      if(buffer[0]!==5||buffer[1]!==1||buffer[2]!==0)return fail();
      let length,host;
      if(buffer[3]===1){length=10;if(buffer.length<length)return;host=[...buffer.subarray(4,8)].join('.');}
      else if(buffer[3]===3){if(buffer.length<5)return;length=7+buffer[4];if(buffer.length<length)return;host=buffer.subarray(5,length-2).toString('ascii');}
      else if(buffer[3]===4){length=22;if(buffer.length<length)return;host=Array.from({length:8},(_,i)=>buffer.readUInt16BE(4+i*2).toString(16)).join(':');}
      else return fail();
      const port=buffer.readUInt16BE(length-2),tail=buffer.subarray(length);phase=3;socket.pause();socket.removeListener('data',read);
      try{
        const destination=await directDestination(host,port,{ownAddresses,resolve});
        if(!authorize()||socket.destroyed)throw new Error('egress authorization expired');
        const upstream=connect({host:destination.address,port,family:destination.family});
        socket.once('close',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
        upstream.setTimeout(10000,()=>upstream.destroy());
        upstream.once('connect',()=>{
          if(!authorize()||socket.destroyed)return upstream.destroy();
          socket.setTimeout(0);upstream.setTimeout(0);
          socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(tail.length)socket.unshift(tail);
          // From the guest's viewpoint bytes sent to the internet are outbound.
          const metered=meteredSocket(socket,(direction,size)=>meter.consume(direction==='in'?'out':'in',size),authorize);
          metered.pipe(upstream).pipe(metered);upstream.once('close',()=>metered.destroy());
        });
      }catch{fail();}
    };
    socket.on('data',read);
  });
  await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
  return {port:server.address().port,proxy:username+':'+password+'@127.0.0.1:'+server.address().port,revoke(){for(const s of sockets)s.destroy();},
    async close(){for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
