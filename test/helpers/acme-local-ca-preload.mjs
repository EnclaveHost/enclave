// TEST-ONLY preload (`node --import`) for the PACKAGED service-tls role child in test/public-rpc-https.test.mjs. It changes the
// child's environment, never the package: the role's bundle bytes, its configuration ("ca": "letsencrypt") and its
// certificate checks are the production ones. Three substitutions, all recorded in ACME_LOCAL_LOG:
//   - fetch to the Let's Encrypt origin goes to the local ACME CA (test/helpers/acme-local-ca.mjs), path for path; every
//     such fetch must be bounded (signal) and non-redirecting (redirect "error"), else a "violation" line is written;
//   - the local CA's root joins node:tls rootCertificates for the role bundle (a resolve hook to acme-tls-roots-shim.mjs),
//     as a test-signed root stands in for a public one; acceptance itself (Node's verifier, names, EKU, dates) is unchanged;
//   - every other NON-loopback fetch or socket is refused ("refused <host>"): the role may reach only loopback (its
//     verifier, the fronted role, the local chain) - no public provider, mirror or redirect target is reachable.
// Inactive in any process whose main script is not the packaged service-tls bundle.
import fs from 'node:fs';
import net from 'node:net';
import { registerHooks } from 'node:module';

const LE = 'https://acme-v02.api.letsencrypt.org';
const active = /[\\/]service-tls\.mjs$/.test(process.argv[1] || '') && process.env.ACME_LOCAL_CA;
if (active) {
  const note = (m) => fs.appendFileSync(process.env.ACME_LOCAL_LOG, m + '\n');
  const loop = (h) => /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i.test(String(h || ''));
  const shim = new URL('./acme-tls-roots-shim.mjs', import.meta.url).href;
  const main = new URL(`file://${process.argv[1]}`).pathname;
  registerHooks({ resolve(spec, ctx, next) {
    if ((spec === 'node:tls' || spec === 'tls') && ctx.parentURL && new URL(ctx.parentURL).pathname === main) return { url: shim, shortCircuit: true };
    return next(spec, ctx);
  } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (u.origin === LE) {
      if (init.redirect !== 'error' || !init.signal) note(`violation unbounded-or-redirecting ${u.href}`);
      note(`acme ${init.method || 'GET'} ${u.pathname}`);
      return realFetch(process.env.ACME_LOCAL_CA + u.pathname + u.search, init);
    }
    if (loop(u.hostname)) return realFetch(input, init);
    note(`refused ${u.href}`);
    throw new TypeError(`no route to ${u.hostname} (test: only loopback is reachable)`);
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) {
    const o = Array.isArray(a[0]) ? a[0][0] : (a[0] && typeof a[0] === 'object' ? a[0] : null);
    if (o && o.host !== undefined && !loop(o.host)) { note(`refused socket ${o.host}`); const e = Object.assign(new Error(`blocked ${o.host}`), { code: 'ENOTFOUND' }); process.nextTick(() => this.destroy(e)); return this; }
    return connect.apply(this, a);
  };
  note(`preload active pid=${process.pid}`);
}
