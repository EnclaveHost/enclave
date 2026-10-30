// Is a host's DNS role answering THROUGH its tunnel? (wg-provider DNS 53 assignment, provider.mjs dnsTarget; hs-transport
// review B5: a WireGuard handshake alone is not DNS.) One SOA question for the zone to <tunnel address>:53 over UDP;
// healthy = an answer with the same id, the response bit set and NOERROR within timeoutMs. The answer's records are not
// read or used: this is liveness only, never DNS authority on the transport.
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

export function soaQuestion(zone, id = randomBytes(2).readUInt16BE(0)) {
  const labels = String(zone).split('.').filter(Boolean);
  if (!labels.length || labels.some((l) => l.length > 63)) throw new Error('dns probe: a zone is required');
  return Buffer.concat([Buffer.from([id >> 8, id & 255, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')])), Buffer.from([0, 0, 6, 0, 1])]);
}

/** -> true | false (never throws) */
export function probeDns({ address, zone, port = 53, timeoutMs = 2000 }) {
  return new Promise((resolve) => {
    let q; try { q = soaQuestion(zone); } catch { resolve(false); return; }
    const id = q.readUInt16BE(0), s = dgram.createSocket('udp4');
    let done = false; const end = (v) => { if (done) return; done = true; clearTimeout(t); try { s.close(); } catch {} resolve(v); };
    const t = setTimeout(() => end(false), timeoutMs);
    s.on('error', () => end(false));
    s.on('message', (m) => { if (m.length < 12 || m.readUInt16BE(0) !== id) return; end((m[2] & 0x80) !== 0 && (m[3] & 0x0f) === 0); });
    s.send(q, port, address, (e) => { if (e) end(false); });
  });
}
