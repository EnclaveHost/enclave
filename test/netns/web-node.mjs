// netns e2e helper: "the internet": HTTP on :80 that echoes the caller's address, a listener on :25, DNS for web.test.
import http from 'node:http';import net from 'node:net';import dgram from 'node:dgram';
http.createServer((q,s)=>s.end('remote='+q.socket.remoteAddress)).listen(80,'0.0.0.0');
net.createServer(c=>c.end('220 smtp\r\n')).listen(25,'0.0.0.0');
const d=dgram.createSocket('udp4');d.on('message',(m,r)=>{
 // minimal DNS: answer any A question with 44.0.0.1
 const q=m.subarray(12);let i=0;while(q[i])i+=q[i]+1;const question=m.subarray(12,12+i+5);
 const ans=Buffer.concat([m.subarray(0,2),Buffer.from([0x81,0x80,0,1,0,1,0,0,0,0]),question,Buffer.from([0xc0,0x0c,0,1,0,1,0,0,0,60,0,4,44,0,0,1])]);
 d.send(ans,r.port,r.address);}).bind(53,'0.0.0.0');
console.error('[web] up');
