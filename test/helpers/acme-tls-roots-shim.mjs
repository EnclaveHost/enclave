// TEST-ONLY (acme-local-ca-preload.mjs): node:tls for the packaged service-tls bundle, with the local ACME CA's root added to
// rootCertificates. Everything else is node:tls itself.
import tls from 'node:tls';
import fs from 'node:fs';
const roots = Object.freeze([...tls.rootCertificates, fs.readFileSync(process.env.ACME_LOCAL_ROOT, 'utf8')]);
export default new Proxy(tls, { get: (t, k) => (k === 'rootCertificates' ? roots : Reflect.get(t, k)) });
