// netns e2e helper: a public visitor: TLS to the exit with an SNI; prints the presented certificate's fingerprint and reply.
import tls from 'node:tls';
const [host,name]=process.argv.slice(2);
const s=tls.connect({host,port:443,servername:name,rejectUnauthorized:false},()=>{s.write('hello');});
s.setTimeout(8000,()=>{console.log('TIMEOUT');process.exit(0);});
s.on('data',d=>{console.log(JSON.stringify({fp:s.getPeerCertificate().fingerprint256,reply:String(d)}));process.exit(0);});
s.on('error',e=>{console.log('ERROR '+e.code);process.exit(0);});s.on('close',()=>{console.log('CLOSED');process.exit(0);});
