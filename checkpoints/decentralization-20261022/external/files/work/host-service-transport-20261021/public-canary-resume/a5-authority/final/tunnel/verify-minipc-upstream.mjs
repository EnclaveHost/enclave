// Root, ON minipc after the tunnel is up: one TCP DNS query to 127.0.0.1:31053 (the control challenge daemon through the
// tunnel) for app.enclave.host SOA, and one TXT query for a challenge name. Prints rcode/counts only. Read-only.
import net from 'node:net';
const q = (name, type) => { const h = Buffer.alloc(12); h.writeUInt16BE(0x5151, 0); h.writeUInt16BE(0x0100, 2); h.writeUInt16BE(1, 4);
  return Buffer.concat([h, ...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, type, 0, 1])]); };
for (const [name, type] of [['app.enclave.host', 6], ['_acme-challenge.7ae476a3.app.enclave.host', 16]]) {
  const r = await new Promise((resolve) => { const s = net.connect(31053, '127.0.0.1', () => { const m = q(name, type), n = Buffer.alloc(2); n.writeUInt16BE(m.length); s.write(Buffer.concat([n, m])); });
    let b = Buffer.alloc(0); const t = setTimeout(() => { s.destroy(); resolve('timeout'); }, 3000); s.on('error', (e) => { clearTimeout(t); resolve('error ' + e.code); });
    s.on('data', (d) => { b = Buffer.concat([b, d]); if (b.length >= 2 + b.readUInt16BE(0)) { clearTimeout(t); s.destroy(); const m = b.subarray(2); resolve(`rcode ${m.readUInt16BE(2) & 15} aa ${!!(m[2] & 4)} answers ${m.readUInt16BE(6)}`); } }); });
  console.log(name, type, r);
}
