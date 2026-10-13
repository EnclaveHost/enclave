// The server name (SNI) of a TLS ClientHello, read without terminating TLS: the app ingress gate, the direct runtime
// and the Enclave-network providers' SNI router route raw TCP by it (TLS itself ends inside the enclave).
// -> name (lowercase), '' (a valid ClientHello without SNI), null (need more bytes) or false (not a valid ClientHello).
export function clientHelloName(buf) {
  if (buf.length < 5) return null;
  if (buf[0] !== 22 || buf.readUInt16BE(3) > 18432) return false;
  const end = 5 + buf.readUInt16BE(3);
  if (buf.length < end) return null;
  try {
    let p = 5;
    if (buf[p++] !== 1) return false;
    const length = buf.readUIntBE(p, 3); p += 3;
    if (p + length !== end) return false;
    p += 34;
    const sid = buf[p++]; p += sid;
    const cipher = buf.readUInt16BE(p); p += 2 + cipher;
    const comp = buf[p++]; p += comp;
    if (p === end) return ''; // valid ClientHello with no extensions/SNI
    const extEnd = p + 2 + buf.readUInt16BE(p); p += 2;
    if (extEnd !== end) return false;
    while (p + 4 <= end) {
      const type = buf.readUInt16BE(p), len = buf.readUInt16BE(p + 2); p += 4;
      if (p + len > end) return false;
      if (type === 0) {
        if (len < 5 || buf.readUInt16BE(p) !== len - 2 || buf[p + 2] !== 0) return false;
        const n = buf.readUInt16BE(p + 3);
        if (n !== len - 5) return false;
        const name = buf.subarray(p + 5, p + 5 + n).toString('ascii').toLowerCase();
        return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name) ? name : false;
      }
      p += len;
    }
    if (p === end) return ''; // valid extensions, with no server_name
  } catch {}
  return false;
}
