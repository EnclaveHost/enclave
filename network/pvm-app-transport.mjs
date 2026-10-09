import net from 'node:net';

// A pVM host's app (shielded/anchor/avf/PVM-CPU.md "Serving buyers"): the phone serves ONE app at a time on its VM's TLS
// port, which the phone's host app exposes on loopback and the owner's host reaches over `adb forward`. TLS ends inside the
// VM; this transport copies ciphertext to that port and never chooses an app (the circuit's admission decides which
// deployment may be forwarded at all; the VM's own evidence decides what the bytes reach).
export function pvmAppPort(cfg){
  const port=Number(cfg?.appPort);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('pvm.appPort must be the loopback port of the phone VM\'s TLS app port');
  return port;
}
export function openPvmApp(port){
  return new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port});
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('the pVM app port did not answer'));},10000);
    socket.once('connect',()=>{clearTimeout(timer);resolve(socket);});
    socket.once('error',e=>{clearTimeout(timer);reject(e);});
  });
}
export function pvmForwarder(port){
  return async socket=>{
    const stream=await openPvmApp(port);
    if(socket.destroyed){stream.destroy();return;}
    const close=()=>{socket.destroy();stream.destroy();};
    stream.on('error',close);socket.on('error',close);stream.once('close',close);socket.once('close',close);
    socket.pipe(stream).pipe(socket);socket.resume();
  };
}
