// netns e2e helper: the "enclave": a TLS server on loopback (the key never leaves this namespace).
import tls from 'node:tls';import fs from 'node:fs';
const [port,key,cert]=process.argv.slice(2);
tls.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},s=>{s.on('data',d=>s.write('enclave says: '+d));}).listen(+port,'127.0.0.1');
console.error('[worker] up');
