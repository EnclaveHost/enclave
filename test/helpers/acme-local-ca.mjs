// A LOCAL ACME CA on loopback HTTP, for packaged service-tls runs (a role child process cannot take an injected fetch).
// Adapted from the in-process fixture CA of test/service-tls.test.mjs (G3 1c733d85): the same protocol checks - every POST
// a flattened JWS (ES256, our url, a fresh nonce) verified by jose against the account key, CSR signature and CN <= 64
// bytes (Let's Encrypt's Boulder refuses longer), the leaf's SAN exactly the order's identifiers - and REAL http-01
// validation: GET http://<name>/.well-known/acme-challenge/<token> sent to the role's port-80 front (127.0.0.1:httpPort,
// Host: <name>). Its directory and every URL it hands out are under the production Let's Encrypt origin, so the role sees
// only the CA it is configured for; test/helpers/acme-local-ca-preload.mjs maps that origin to this server in the child.
// The issuing chain is an openssl root + intermediate made here; the root is handed to the child as a trust root.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { flattenedVerify, importJWK, calculateJwkThumbprint } from 'jose';

export const LE_ORIGIN = 'https://acme-v02.api.letsencrypt.org';

function openssl(args, input = null) {
  return new Promise((ok, no) => {
    const p = spawn('openssl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => (code === 0 ? ok(out) : no(new Error(`openssl ${args[0]}: ${err.slice(0, 300)}`))));
    p.stdin.end(input ?? '');
  });
}
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, 'Z');
const pemWrap = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

/** startLocalAcmeCa({ dir, httpPort }) -> { url, rootFile, rootPem, st, close } */
export async function startLocalAcmeCa({ dir, httpPort, leafDays = 90 }) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  let serial = 1;
  async function makeCa(name, issuer = null) {
    await openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', f(`${name}.key`), '-subj', `/CN=Local ACME ${name}`, '-out', f(`${name}.csr`)]);
    fs.writeFileSync(f(`${name}.ext`), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign,digitalSignature\nsubjectKeyIdentifier=hash\n');
    const signer = issuer ? ['-CA', f(`${issuer}.pem`), '-CAkey', f(`${issuer}.key`)] : ['-key', f(`${name}.key`)];
    await openssl(['x509', '-req', '-in', f(`${name}.csr`), ...signer, '-extfile', f(`${name}.ext`), '-not_before', stamp(Date.now() - 86400e3),
      '-not_after', stamp(Date.now() + 3650 * 86400e3), '-set_serial', String(serial++), '-out', f(`${name}.pem`)]);
  }
  await makeCa('root'); await makeCa('int', 'root');
  const rootPem = fs.readFileSync(f('root.pem'), 'utf8');

  const st = { nonces: new Set(), accounts: new Map(), orders: new Map(), authzs: new Map(), newAccounts: 0, newOrders: [], validations: [], issued: [], badCsr: 0 };
  let n = 0;
  const nonce = () => { const v = `n${++n}x${Math.random().toString(36).slice(2)}`; st.nonces.add(v); return v; };
  const U = (p) => `${LE_ORIGIN}/${p}`;
  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'replay-nonce': nonce(), 'content-type': typeof body === 'string' ? 'application/pem-certificate-chain'
      : (status >= 400 ? 'application/problem+json' : 'application/json'), ...headers });
    res.end(text);
  };
  const problem = (res, status, type, detail = '') => send(res, status, { type: `urn:ietf:params:acme:error:${type}`, detail });
  // real http-01: the CA's own GET of the token from the name, through the role's port-80 front
  const validate = (name, token) => new Promise((ok) => {
    const r = http.get({ host: '127.0.0.1', port: httpPort, path: `/.well-known/acme-challenge/${token}`, headers: { host: name }, agent: false, timeout: 5000 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => ok(res.statusCode === 200 ? b : null));
    });
    r.on('error', () => ok(null)); r.on('timeout', () => { r.destroy(); ok(null); });
  });
  async function handle(u, method, raw, res) {
    if (u === U('directory')) return send(res, 200, { newNonce: U('nonce'), newAccount: U('acct'), newOrder: U('order'), meta: {} });
    if (u === U('nonce')) { res.writeHead(200, { 'replay-nonce': nonce() }); return res.end(); }
    if (method !== 'POST') return problem(res, 405, 'malformed', 'POST only');
    const jws = JSON.parse(raw);
    const prot = JSON.parse(Buffer.from(jws.protected, 'base64url'));
    if (prot.alg !== 'ES256' || prot.url !== u) return problem(res, 400, 'malformed', 'bad protected header');
    if (!st.nonces.delete(prot.nonce)) return problem(res, 400, 'badNonce', 'unknown nonce');
    let jwk;
    if (prot.jwk) { if (u !== U('acct')) return problem(res, 400, 'malformed', 'jwk only on newAccount'); jwk = prot.jwk; }
    else { jwk = st.accounts.get(prot.kid); if (!jwk) return problem(res, 400, 'accountDoesNotExist', 'no such account'); }
    try { await flattenedVerify(jws, await importJWK(jwk, 'ES256')); } catch { return problem(res, 400, 'malformed', 'signature'); }
    const payload = jws.payload ? JSON.parse(Buffer.from(jws.payload, 'base64url')) : null;
    if (u === U('acct')) {
      st.newAccounts++; const kid = U(`acct/${st.newAccounts}`); st.accounts.set(kid, jwk);
      return send(res, 201, { status: 'valid' }, { location: kid });
    }
    let m;
    if (u === U('order')) {
      const ids = payload.identifiers.map((i) => i.value); st.newOrders.push(ids);
      const oid = `o${st.orders.size + 1}`;
      const authorizations = ids.map((name, i) => { const aid = `${oid}a${i}`;
        st.authzs.set(aid, { status: 'pending', identifier: { type: 'dns', value: name }, token: `tok_${aid}_${'A'.repeat(20)}`, acct: prot.kid }); return U(`authz/${aid}`); });
      st.orders.set(oid, { status: 'pending', identifiers: ids.map((value) => ({ type: 'dns', value })), authorizations, names: ids });
      return send(res, 201, { status: 'pending', identifiers: ids.map((value) => ({ type: 'dns', value })), authorizations, finalize: U(`finalize/${oid}`) }, { location: U(`order/${oid}`) });
    }
    if ((m = new RegExp(`^${LE_ORIGIN}/authz/(\\w+)$`).exec(u))) {
      const a = st.authzs.get(m[1]);
      return send(res, 200, { status: a.status, identifier: a.identifier, challenges: [{ type: 'http-01', url: U(`chall/${m[1]}`), token: a.token, status: a.status }] });
    }
    if ((m = new RegExp(`^${LE_ORIGIN}/chall/(\\w+)$`).exec(u))) {
      const a = st.authzs.get(m[1]);
      const expect = `${a.token}.${await calculateJwkThumbprint(st.accounts.get(a.acct))}`;
      const got = await validate(a.identifier.value, a.token);
      st.validations.push({ name: a.identifier.value, ok: got === expect });
      a.status = got === expect ? 'valid' : 'invalid';
      return send(res, 200, { status: 'processing' });
    }
    if ((m = new RegExp(`^${LE_ORIGIN}/finalize/(\\w+)$`).exec(u))) {
      const o = st.orders.get(m[1]);
      if (o.authorizations.some((x) => st.authzs.get(x.split('/').pop()).status !== 'valid')) return problem(res, 403, 'orderNotReady', 'authorizations pending');
      const csrPem = pemWrap('CERTIFICATE REQUEST', Buffer.from(payload.csr, 'base64url'));
      let subject; try { subject = await openssl(['req', '-noout', '-verify', '-subject', '-nameopt', 'RFC2253'], csrPem); } catch { return problem(res, 400, 'badCSR', 'CSR signature or encoding'); }
      const cn = /CN=([^,\n]*)/.exec(subject)?.[1];
      if (cn && Buffer.byteLength(cn) > 64) { st.badCsr++; return problem(res, 400, 'badCSR', 'CN was longer than 64 bytes'); }
      const id = serial++;
      fs.writeFileSync(f(`l${id}.csr`), csrPem);
      fs.writeFileSync(f(`l${id}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${o.names.map((x) => `DNS:${x}`).join(',')}\n`);
      await openssl(['x509', '-req', '-in', f(`l${id}.csr`), '-CA', f('int.pem'), '-CAkey', f('int.key'), '-extfile', f(`l${id}.ext`), '-not_before', stamp(Date.now() - 3600e3),
        '-not_after', stamp(Date.now() + leafDays * 86400e3), '-set_serial', String(id), '-out', f(`l${id}.pem`)]);
      o.chain = fs.readFileSync(f(`l${id}.pem`), 'utf8') + fs.readFileSync(f('int.pem'), 'utf8');
      o.status = 'valid'; st.issued.push(o.names);
      return send(res, 200, { status: 'processing' });
    }
    if ((m = new RegExp(`^${LE_ORIGIN}/order/(\\w+)$`).exec(u))) {
      const o = st.orders.get(m[1]);
      return send(res, 200, { status: o.status, ...(o.status === 'valid' ? { certificate: U(`cert/${m[1]}`) } : {}) });
    }
    if ((m = new RegExp(`^${LE_ORIGIN}/cert/(\\w+)$`).exec(u))) return send(res, 200, st.orders.get(m[1]).chain);
    return problem(res, 404, 'malformed', 'no such resource');
  }
  const server = http.createServer((req, res) => {
    const c = []; req.on('data', (d) => c.push(d));
    req.on('end', () => handle(LE_ORIGIN + req.url, req.method, Buffer.concat(c).toString('utf8'), res).catch((e) => problem(res, 500, 'serverInternal', e.message)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, rootFile: f('root.pem'), rootPem, st,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
