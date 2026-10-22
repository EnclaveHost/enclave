import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [verifier, channel, version, zip, setup, manifest, out, at] = process.argv.slice(2);
const { STATEMENT_FORMAT, validateStatement } = await import(pathToFileURL(verifier).href);
function file(path) {
  const fd = fs.openSync(path, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error('not a regular artifact');
    const h = createHash('sha256'), buf = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0, n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null))) { h.update(buf.subarray(0,n)); bytes += n; }
    const after = fs.fstatSync(fd);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('artifact changed during hashing');
    return {sha256:h.digest('hex'), bytes};
  } finally { fs.closeSync(fd); }
}
const z=file(zip), s=file(setup), m=file(manifest), issuedAt=new Date(at || Date.now()).toISOString();
const statement=validateStatement({format:STATEMENT_FORMAT,channel,version,issuedAt,
  file:`enclave-host-${version}.zip`,sha256:z.sha256,bytes:z.bytes,
  setup:`EnclaveSetup-${version}.exe`,setupSha256:s.sha256,setupBytes:s.bytes,
  manifest:`manifest-${version}.json`,manifestSha256:m.sha256,manifestBytes:m.bytes}, {channel,now:Date.parse(issuedAt)});
fs.writeFileSync(out, JSON.stringify(statement,null,1)+'\n', {flag:'wx'});
