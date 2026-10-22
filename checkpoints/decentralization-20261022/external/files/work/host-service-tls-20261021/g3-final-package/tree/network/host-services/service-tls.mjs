// HTTPS for a host's OWN service names (work/host-service-tls-20261021, G3 of work/host-service-transport-20261021), as an
// Enclave HOST-SERVICE ROLE run by network/host-services/runner.mjs (bundle entry entries/service-tls.mjs). A WireGuard
// provider forwards raw TCP for the derived names (G1: port 80 by Host, port 443 by SNI) to this host's ingress worker,
// which hands them to this role on loopback:
//   httpPort     every derived name's port 80: GET /.well-known/acme-challenge/<token> answered here for a pending
//                http-01 authorization of that exact name (404 otherwise, never forwarded); anything else is passed RAW
//                (the bytes read, then a byte pipe) to that name's role port. Unknown Host -> 421.
//   tlsPorts     one TLS listener per role: only that role's name as SNI (no default certificate), TLS >= 1.2, ALPN
//                http/1.1; after the handshake a raw byte pipe to the role's loopback port.
// The certificate: ONE per host, exactly the derived names of the roles in tlsPorts (host-service-names.mjs, from the
// host's registry id), ordered from Let's Encrypt over http-01 by this host (acme-http01.mjs). Nobody can ask for a name.
//
// What the role guarantees:
//   - THE KEYS STAY HERE. The ACME account key and the TLS key are generated in this process and written only to
//     <stateRoot>/service-tls/keys, which must pass an ACL preflight before anything starts (checkKeyDir): POSIX, owned by
//     this user with no group/other access; Windows, owner and every allow entry within SYSTEM, Administrators, LOCAL
//     SERVICE and CREATOR OWNER (the hs2 installer's state ACL). Anything else refuses to start: no silent repair.
//   - CRASH-SAFE PAIRS. Key and chain are ONE document (keys/current.pem) replaced by temp + fsync + rename (+ directory
//     fsync on POSIX). A crash at any point leaves either the previous pair or the new one, never a mismatch; a failed
//     order, a refused chain or a failed write keeps the previous valid certificate serving.
//   - STRICT ACCEPTANCE (verifyCertificate). A chain is used only if Node's own TLS client (OpenSSL's verifier: path
//     building, CA and basic constraints, key usage and purpose, validity of every certificate, name constraints, the
//     hostname check) accepts it for EVERY name against the trusted roots (Node's Mozilla store; tests inject a fixture
//     root), in an in-memory handshake with our key. Exact guards are added on top: the leaf SAN set equals the names,
//     the leaf is no CA, has serverAuth, holds our P-256 key and is inside its validity now.
//   - ADMIN POLICY. The platform host policy is required ("off" is refused when the runner binds the config). Before
//     EVERY order a fresh decision for this host (no cached admit) must be admit; every 60 s the role re-checks, and an
//     explicit refusal (ban, allowlist miss, inactive) closes every listener, aborts an order in flight and stops renewal
//     until a later admit. Nothing listens before the first admit. The runner's own gate also stops the role.
//   - ORDERS HELD UNTIL ROOT APPROVES. `orders` is "held" unless the configuration says exactly "approved" (absent = held):
//     while held the role starts, preflights its key directory, follows the platform host policy and serves the port-80
//     front (404 for unknown challenges, raw pass-through by Host), but it never contacts the CA - no account, no order, no
//     renewal. A stored valid certificate still serves until it expires. Approval is a reviewed configuration change, made
//     only after public DNS and every provider route for the derived names are proven (G3 activation, g3-final-package).
//   - NO CONTENT CAPTURE. The port-80 front reads at most 16 KiB of request head to find the Host and the target; it
//     logs neither, nor any header or body. TLS plaintext is never inspected. Logs carry names, events and CA errors.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { duplexPair } from 'node:stream';
import { spawn as spawnChild } from 'node:child_process';
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { keccak256, toBytes } from 'viem';
import { HOST_SERVICE_ROLES, hostServiceNames, validServiceZone } from '../host-service-names.mjs';
import { ACME_DIRECTORIES, createAcmeClient, newKey, pemBlocks } from './acme-http01.mjs';

const ROLE = 'service-tls';
const fail = (m) => { throw new Error(`${ROLE}: ${m}`); };
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;
const FRONTED = Object.keys(HOST_SERVICE_ROLES);              // directory-replica, bootstrap-replica, policy-mirror
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const HEAD_MAX = 16 * 1024;
// A host needs one certificate per ~60 days (renewal at 2/3 of a 90-day lifetime). Two per rolling week leaves room for one
// re-issue (zone or key change) and bounds what a misissuing CA or a crash loop can spend of the registered domain's shared
// allowance, without assuming the CA's exact numbers (relay/certs.js paces the whole platform to 40/week for enclave.host).
export const ISSUANCE_BUDGET = Object.freeze({ count: 2, windowMs: 7 * 86400e3 });
export const POLICY_FIELDS = ['platformHostPolicy', 'platformHostPolicyMirrors', 'platformHostPolicyRpcs', 'platformHostPolicyCarriers', 'serviceIndex'];

// ---- configuration ------------------------------------------------------------------------------------------------------
/**
 * The operator's role config: { hostId, zone, httpPort, tlsPorts: { <role>: port }, ca: "letsencrypt", orders?: "held" | "approved" }.
 * No secret, no names. `orders` absent = "held" (no CA contact at all; see ORDERS HELD above).
 * hostId: this host's REGISTRY id (the runner id G1's agent uses, EnclaveRegistry idOf = keccak256(endpoint bytes as
 * registered)); the names are derived from it, and the runner refuses it unless host.endpoint hashes to exactly it.
 */
export function validateServiceTlsConfig(c) {
  if (!plain(c)) fail('config must be an object');
  for (const k of Object.keys(c)) if (!['hostId', 'zone', 'httpPort', 'tlsPorts', 'ca', 'orders'].includes(k)) fail(`unknown config field ${JSON.stringify(k)} (names are derived from the host id; keys are generated on the host)`);
  if (typeof c.hostId !== 'string' || !/^0x[0-9a-f]{64}$/.test(c.hostId) || /^0x0{64}$/.test(c.hostId)) fail('hostId must be this host\'s registry id (0x + 64 lowercase hex)');
  try { validServiceZone(c.zone); } catch (e) { fail(e.message); }
  if (!isPort(c.httpPort)) fail('httpPort must be a port');
  if (!plain(c.tlsPorts) || !Object.keys(c.tlsPorts).length) fail(`tlsPorts: a loopback TLS port for one or more of ${FRONTED.join(', ')}`);
  for (const [r, p] of Object.entries(c.tlsPorts)) {
    if (!FRONTED.includes(r)) fail(`tlsPorts: ${JSON.stringify(r)} has no derived service name`);
    if (!isPort(p)) fail(`tlsPorts.${r} must be a port`);
  }
  const ports = [c.httpPort, ...Object.values(c.tlsPorts)];
  if (new Set(ports).size !== ports.length) fail('httpPort and tlsPorts must be distinct');
  // staging roots are not in the trust store and acceptance is never weakened, so only the production CA is offered
  if (!Object.hasOwn(ACME_DIRECTORIES, c.ca)) fail(`ca must be one of ${Object.keys(ACME_DIRECTORIES).join(', ')}`);
  const orders = c.orders === undefined ? 'held' : c.orders;
  if (orders !== 'held' && orders !== 'approved') fail('orders must be "held" or "approved" (absent = "held")');
  return { hostId: c.hostId, zone: c.zone, httpPort: c.httpPort, tlsPorts: Object.fromEntries(FRONTED.filter((r) => c.tlsPorts[r]).map((r) => [r, c.tlsPorts[r]])), ca: c.ca, orders };
}

/**
 * Bind the validated role config to the host-services configuration (runner.mjs validateHostServicesConfig): this host's
 * endpoint and id, the loopback ports of the roles it fronts, its state directory and the SAME platform host policy the
 * runner's gate uses. Refuses "off", a fronted role this host does not run or that is not on loopback, and port clashes.
 */
export function bindServiceTls(config, cfg) {
  if (cfg.platformHostPolicy === 'off') fail('refused with platformHostPolicy "off": certificates are ordered only for an admitted host');
  const endpoint = String(cfg.host?.endpoint || '');
  if (!/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(endpoint.replace(/\/+$/, ''))) fail('host.endpoint (this host\'s registry endpoint) is required');
  // The AUTHORITY is the registry id: EnclaveRegistry idOf = keccak256 of the endpoint bytes EXACTLY as registered (G1's
  // cfg.runner). The configured hostId must equal that hash of the endpoint as written, byte for byte; nothing is
  // normalized or rewritten (a host registered with a trailing slash keeps it, and its id).
  if (keccak256(toBytes(endpoint)).toLowerCase() !== config.hostId) fail('hostId must be keccak256 of host.endpoint exactly as registered (the registry id; nothing is normalized)');
  const byRole = Object.fromEntries(cfg.services.map((s) => [s.role, s.config]));
  const upstreams = {};
  for (const r of FRONTED) {
    const rc = byRole[r];
    if (!rc) { if (config.tlsPorts[r]) fail(`tlsPorts.${r}: this host does not run ${r}`); continue; }
    if (!['127.0.0.1', '0.0.0.0'].includes(rc.bind)) fail(`${r} must listen on 127.0.0.1 or 0.0.0.0 to be fronted on loopback`);
    upstreams[r] = rc.port;
  }
  if (!Object.keys(upstreams).length) fail(`this host runs none of ${FRONTED.join(', ')}`);
  const used = [];
  for (const s of cfg.services) if (s.role !== ROLE) for (const k of ['port', 'apiPort', 'dnsPort']) if (isPort(s.config[k])) used.push(s.config[k]);
  for (const p of [config.httpPort, ...Object.values(config.tlsPorts)]) if (used.includes(p)) fail(`port ${p} is another role's`);
  const mirror = byRole['policy-mirror'];
  const policy = Object.fromEntries(POLICY_FIELDS.filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]]));
  if (mirror) policy.policyMirrorStateDir = mirror.stateDir;
  return { ...config, host: { endpoint, hostId: config.hostId }, upstreams, stateDir: path.join(cfg.stateRoot, ROLE), policy };
}

/** The bound config the runner writes for the role process (re-checked there; it holds no secret). */
export function validateLaunchConfig(c) {
  if (!plain(c)) fail('launch config must be an object');
  const { host, upstreams, stateDir, policy, ...own } = c;
  const v = validateServiceTlsConfig(own);
  if (!plain(host) || host.hostId !== v.hostId || keccak256(toBytes(String(host.endpoint))).toLowerCase() !== v.hostId) fail('host.hostId must be the configured registry id and keccak256 of host.endpoint');
  if (!plain(upstreams) || Object.entries(upstreams).some(([r, p]) => !FRONTED.includes(r) || !isPort(p))) fail('upstreams: loopback role ports');
  for (const r of Object.keys(v.tlsPorts)) if (!upstreams[r]) fail(`tlsPorts.${r} has no upstream`);
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) fail('stateDir must be absolute');
  if (!plain(policy) || !(policy.platformHostPolicy === 'production' || plain(policy.platformHostPolicy))) fail('policy.platformHostPolicy must be "production" or the explicit platform JSON ("off" is refused)');
  return { ...v, host: { endpoint: host.endpoint, hostId: host.hostId }, upstreams: { ...upstreams }, stateDir, policy };
}

/** The G1 values (enclaveNetwork.hostServices, e49's host-service-transport.mjs): the role ports, and tls = { httpPort,
 *  tlsPorts } (port 80 of every derived name -> httpPort, port 443 -> tlsPorts[role]). Root's integration checks equality. */
export const ingressPorts = (c) => ({ ports: { ...c.upstreams }, tls: { httpPort: c.httpPort, tlsPorts: { ...c.tlsPorts } } });

// ---- the private key directory ------------------------------------------------------------------------------------------
const WINDOWS_ALLOWED = new Set(['S-1-5-18', 'S-1-5-32-544', 'S-1-5-19', 'S-1-3-0']);   // SYSTEM, Administrators, LOCAL SERVICE, CREATOR OWNER
const WINDOWS_OWNERS = new Set(['S-1-5-18', 'S-1-5-32-544', 'S-1-5-19']);
/** Windows: { owner, rules: [{ sid, allow, rights, inherited }] } -> evidence, or throws. Deny entries only narrow access. */
export function evaluateWindowsAcl(acl) {
  if (!plain(acl) || !Array.isArray(acl.rules)) fail('key directory ACL could not be read');
  if (!WINDOWS_OWNERS.has(acl.owner)) fail(`key directory owner ${acl.owner} is not SYSTEM, Administrators or LOCAL SERVICE`);
  const allowed = acl.rules.filter((r) => r.allow);
  const extra = allowed.filter((r) => !WINDOWS_ALLOWED.has(r.sid)).map((r) => r.sid);
  if (extra.length) fail(`key directory grants access to ${[...new Set(extra)].join(', ')}: only SYSTEM, Administrators and LOCAL SERVICE may (fix the hs2 state ACL; nothing is repaired silently)`);
  if (!allowed.some((r) => r.sid === 'S-1-5-19')) fail('key directory grants LOCAL SERVICE nothing (not the hs2 state directory?)');
  return { platform: 'win32', owner: acl.owner, sids: [...new Set(allowed.map((r) => r.sid))].sort() };
}
// read-only: the directory's DACL as SIDs (Get-Acl), the path passed in the environment (no quoting), stdin closed
export const ACL_PS = "$ErrorActionPreference='Stop';$a=Get-Acl -LiteralPath $env:ENCLAVE_KEY_DIR;"
  + "$r=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');rights=[int64]$_.FileSystemRights;inherited=$_.IsInherited}});"
  + "'ACL '+(@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;rules=$r}|ConvertTo-Json -Compress -Depth 4)";
export function readWindowsAcl(dir, { spawn = spawnChild, timeoutMs = 30_000 } = {}) {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return new Promise((ok, no) => {
    const p = spawn(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ACL_PS],
      { env: { SystemRoot: root, ENCLAVE_KEY_DIR: dir }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    const t = setTimeout(() => { p.kill(); no(new Error('ACL read timed out')); }, timeoutMs);
    p.stdout.on('data', (d) => { if (out.length < 65536) out += d; });
    p.on('error', (e) => { clearTimeout(t); no(e); });
    p.on('exit', (code) => {
      clearTimeout(t);
      const line = out.split(/\r?\n/).find((l) => l.startsWith('ACL '));
      if (code !== 0 || !line) return no(new Error(`ACL read failed (exit ${code})`));
      try { ok(JSON.parse(line.slice(4))); } catch { no(new Error('ACL read returned no JSON')); }
    });
  });
}
/** Create (0700) and PREFLIGHT the key directory; refuse anything but a private directory. -> evidence */
export async function checkKeyDir(dir, { platform = process.platform, fsx = fs, getuid = () => process.getuid(), windowsAcl = readWindowsAcl } = {}) {
  fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') {
    if (fsx.lstatSync(dir).isSymbolicLink()) fail('the key directory is a link');
    let acl; try { acl = await windowsAcl(dir); } catch (e) { fail(`key directory ACL preflight failed: ${e.message}`); }
    return evaluateWindowsAcl(acl);
  }
  const st = fsx.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) fail('the key directory is not a directory');
  if (st.uid !== getuid()) fail('the key directory is owned by another user');
  if (st.mode & 0o077) fail(`the key directory is mode ${(st.mode & 0o777).toString(8)}: group/other access is refused (nothing is repaired silently)`);
  return { platform, mode: (st.mode & 0o777).toString(8), ownerIsSelf: true };
}

// ---- the crash-safe store -----------------------------------------------------------------------------------------------
const DOC = 'current.pem', ACCOUNT = 'account.json', LEDGER = 'issuance.json', TMP = /^\..+\.tmp-[0-9a-f]{12}$/;
function atomicWrite(fsx, dir, file, data, platform) {
  const tmp = path.join(dir, `.${file}.tmp-${randomBytes(6).toString('hex')}`);
  try {
    const fd = fsx.openSync(tmp, 'wx', 0o600);
    try { fsx.writeSync(fd, data); fsx.fsyncSync(fd); } finally { fsx.closeSync(fd); }
    fsx.renameSync(tmp, path.join(dir, file));
  } catch (e) { try { fsx.unlinkSync(tmp); } catch { /* absent or the crash itself */ } throw e; }
  // the rename itself must survive power loss (POSIX); Windows cannot open a directory for flushing
  if (platform !== 'win32') { const d = fsx.openSync(dir, 'r'); try { fsx.fsyncSync(d); } finally { fsx.closeSync(d); } }
}
/** keys/current.pem: the private key and the chain as ONE document; keys/account.json: the ACME account. */
export function createKeyStore(dir, { fsx = fs, platform = process.platform } = {}) {
  const read = (f) => { try { return fsx.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  return {
    cleanup() { for (const f of fsx.readdirSync(dir)) if (TMP.test(f)) { try { fsx.unlinkSync(path.join(dir, f)); } catch { /* next start */ } } },
    readDoc() {
      const s = read(DOC); if (s === null) return null;
      const keys = pemBlocks(s, 'PRIVATE KEY'), certs = pemBlocks(s, 'CERTIFICATE');
      if (keys.length !== 1 || !certs.length) throw new Error('the stored certificate document is malformed');
      return { keyPem: keys[0] + '\n', chainPem: certs.join('\n') + '\n' };
    },
    writeDoc(keyPem, chainPem) { atomicWrite(fsx, dir, DOC, `${keyPem.trim()}\n${chainPem.trim()}\n`, platform); },
    // what the CA has issued to this host (counted when a chain comes back, accepted or not) and the backoff, so a
    // restart or a crash loop neither forgets the budget nor starts the backoff over
    loadLedger() { try { const j = JSON.parse(read(LEDGER) || '{}'); return { issued: Array.isArray(j.issued) ? j.issued.filter(Number.isFinite) : [], failures: Number(j.failures) || 0, nextAt: Number(j.nextAt) || 0 }; } catch { return { issued: [], failures: 0, nextAt: 0 }; } },
    saveLedger(l) { atomicWrite(fsx, dir, LEDGER, JSON.stringify(l), platform); },
    account: {
      load() { const s = read(ACCOUNT); try { return s ? JSON.parse(s) : null; } catch { return null; } },
      save(rec) { atomicWrite(fsx, dir, ACCOUNT, JSON.stringify(rec), platform); },
      forget() { try { fsx.unlinkSync(path.join(dir, ACCOUNT)); } catch { /* absent */ } },
    },
  };
}

// ---- acceptance: Node's TLS verifier plus exact guards ------------------------------------------------------------------
// One in-memory handshake (no socket): a TLS server with the candidate key and chain, a TLS client that trusts only
// `roots`, checks `name` and rejects anything unauthorized. Node/OpenSSL do the path validation.
function tlsVerify(name, keyPem, chainPem, roots, timeoutMs) {
  return new Promise((ok, no) => {
    const [a, b] = duplexPair();
    let server = null, client = null, settled = false;
    const done = (e) => {
      if (settled) return; settled = true; clearTimeout(timer);
      for (const s of [client, server, a, b]) { try { s?.destroy(); } catch { /* closed */ } }
      e ? no(e) : ok();
    };
    const timer = setTimeout(() => done(new Error('certificate: the TLS verifier timed out')), timeoutMs);
    try {
      server = new tls.TLSSocket(a, { isServer: true, secureContext: tls.createSecureContext({ key: keyPem, cert: chainPem, minVersion: 'TLSv1.2' }) });
      server.on('error', () => {});
      client = tls.connect({ socket: b, servername: name, ca: roots, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    } catch (e) { return done(new Error(`certificate: unusable key or chain (${e.code || e.message})`)); }
    client.once('secureConnect', () => done(client.authorized ? null : new Error(`certificate: refused by the TLS verifier (${client.authorizationError})`)));
    client.once('error', (e) => done(new Error(`certificate: refused by the TLS verifier for ${name} (${e.code || e.message})`)));
  });
}
/**
 * -> { notBefore, notAfter, renewAt (2/3 of the lifetime, supervisor.js / acme.go), fingerprint } or throws.
 * roots: PEM strings of the trust anchors (production: tls.rootCertificates).
 */
export async function verifyCertificate({ names, keyPem, chainPem, roots = tls.rootCertificates, now = Date.now(), timeoutMs = 10_000 }) {
  const blocks = pemBlocks(chainPem, 'CERTIFICATE');
  if (blocks.length < 1 || blocks.length > 4) throw new Error('certificate: 1 to 4 PEM certificates, leaf first');
  let leaf, key;
  try { leaf = new X509Certificate(blocks[0]); key = createPrivateKey(keyPem); } catch (e) { throw new Error(`certificate: unparseable key or leaf (${e.message})`); }
  const sans = String(leaf.subjectAltName || '').split(', ');
  const want = [...names].sort();
  if (!sans.every((s) => s.startsWith('DNS:')) || sans.length !== want.length || sans.map((s) => s.slice(4)).sort().some((n, i) => n !== want[i])) throw new Error('certificate: the SAN set is not exactly this host\'s names');
  if (leaf.ca) throw new Error('certificate: the leaf is a CA');
  if (!Array.isArray(leaf.keyUsage) || !leaf.keyUsage.includes(SERVER_AUTH)) throw new Error('certificate: no serverAuth extended key usage');
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('certificate: the key is not P-256');
  if (!leaf.checkPrivateKey(key)) throw new Error('certificate: the leaf does not hold our key');
  const notBefore = Date.parse(leaf.validFrom), notAfter = Date.parse(leaf.validTo);
  if (!(notBefore <= now && now < notAfter)) throw new Error('certificate: outside its validity period');
  const chain = blocks.join('\n') + '\n';
  for (const n of names) await tlsVerify(n, keyPem, chain, roots, timeoutMs);
  return { notBefore, notAfter, renewAt: notBefore + Math.round((notAfter - notBefore) * 2 / 3), fingerprint: leaf.fingerprint256 };
}

// ---- the fronts ---------------------------------------------------------------------------------------------------------
function pipe(a, b, idleMs) {
  const end = () => { a.destroy(); b.destroy(); };
  for (const s of [a, b]) { s.on('error', end); s.on('close', end); s.setTimeout(idleMs, end); }
  a.pipe(b); b.pipe(a);
}
const reply = (sock, status, text, body = '') => sock.resume().end(`HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\ncache-control: no-store\r\n\r\n${body}`);
function track(server, set) { server.on('connection', (s) => { set.add(s); s.on('close', () => set.delete(s)); }); return server; }

/** port 80 of every fronted name: challenge answers for exact names, otherwise raw passthrough to the role. */
function createHttpFront({ routes, challenges, headTimeoutMs, idleMs, maxConnections }) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.setTimeout(headTimeoutMs, () => sock.destroy());
    sock.on('error', () => sock.destroy());
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > HEAD_MAX) { sock.off('data', onData); reply(sock, 431, 'Request Header Fields Too Large'); } return; }
      sock.off('data', onData); sock.pause();
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
      const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0]);
      const hosts = lines.slice(1).filter((l) => /^host:/i.test(l)).map((l) => l.slice(5).trim().toLowerCase().replace(/:80$/, ''));
      if (!m || hosts.length !== 1) return reply(sock, 400, 'Bad Request');
      const port = routes.get(hosts[0]);
      if (!port) return reply(sock, 421, 'Misdirected Request');
      const prefix = '/.well-known/acme-challenge/';
      if (m[2].startsWith(prefix)) {
        const answer = (m[1] === 'GET' || m[1] === 'HEAD') ? challenges.get(hosts[0])?.get(m[2].slice(prefix.length)) : null;
        if (!answer) return reply(sock, 404, 'Not Found');
        return sock.resume().end(`HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: ${answer.length}\r\nconnection: close\r\ncache-control: no-store\r\n\r\n${m[1] === 'GET' ? answer : ''}`);
      }
      sock.setTimeout(0);
      const up = net.connect(port, '127.0.0.1');
      up.write(buf); buf = null;
      pipe(sock, up, idleMs); sock.resume();
    };
    sock.on('data', onData);
  });
  server.maxConnections = maxConnections;
  return server;
}
/** one TLS listener per role: exactly its name as SNI, the host certificate, then a raw pipe to the role */
function createTlsFront({ name, port, context, idleMs, maxConnections }) {
  const server = tls.createServer({ minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'],
    SNICallback: (sni, cb) => { const ctx = context(); if (String(sni || '').toLowerCase() === name && ctx) cb(null, ctx); else cb(new Error('unknown server name')); } },
  (sock) => {
    if (String(sock.servername || '').toLowerCase() !== name) return sock.destroy();
    pipe(sock, net.connect(port, '127.0.0.1'), idleMs);
  });
  server.on('tlsClientError', () => {});
  server.maxConnections = maxConnections;
  return server;
}

// ---- the role -----------------------------------------------------------------------------------------------------------
/**
 * startServiceTls(launchConfig, { admit, ... }) -> { status(), checkPolicy(), tick(), stop(), ports }
 * admit(): a FRESH platform host policy decision for this host ({ admit, status, reason }); production: policyAdmission.
 * Injected for tests only: directoryUrl + fetch (a fixture CA), roots (fixture trust anchors), now, fsx/platform/aclCheck.
 */
export async function startServiceTls(c, { admit, directoryUrl = ACME_DIRECTORIES[c.ca], fetch = globalThis.fetch, roots = tls.rootCertificates,
  now = () => Date.now(), log = (m) => console.log(m), fsx = fs, platform = process.platform, aclCheck = checkKeyDir, loop = true,
  intervalMs = 60_000, backoffMs = 15 * 60_000, maxBackoffMs = 24 * 3600_000, headTimeoutMs = 10_000, idleMs = 120_000, maxConnections = 256,
  host = '127.0.0.1', acmeOptions = {}, budget = ISSUANCE_BUDGET } = {}) {
  if (typeof admit !== 'function') fail('a platform host policy admission is required');
  const all = hostServiceNames(c.hostId, c.zone);
  const tlsRoles = Object.keys(c.tlsPorts), certNames = tlsRoles.map((r) => all[r]);
  const routes = new Map(Object.entries(c.upstreams).map(([r, p]) => [all[r], p]));
  const keysDir = path.join(c.stateDir, 'keys');
  const acl = await aclCheck(keysDir, { platform, fsx });
  const store = createKeyStore(keysDir, { fsx, platform });
  store.cleanup();
  const challenges = new Map();
  const challengeStore = {
    set: (n, token, ka) => { if (!certNames.includes(n)) throw new Error('challenge for a name this host does not serve'); if (!challenges.has(n)) challenges.set(n, new Map()); challenges.get(n).set(token, ka); },
    delete: (n, token) => { challenges.get(n)?.delete(token); if (!challenges.get(n)?.size) challenges.delete(n); },
  };
  const acme = createAcmeClient({ directoryUrl, account: store.account, fetch, log, now, ...acmeOptions });
  const ledger = store.loadLedger();
  const st = { admitted: false, refused: null, policyError: null, failures: ledger.failures, nextAt: ledger.nextAt, lastError: null, orders: 0, unsaved: null };
  const saveLedger = () => { try { store.saveLedger({ issued: ledger.issued, failures: st.failures, nextAt: st.nextAt }); } catch (e) { log(`[service-tls] saving the issuance ledger failed (${e.code || e.message})`); } };
  let current = null, ordering = null, stopped = false, timer = null;
  const context = () => (current && now() < current.info.notAfter ? current.ctx : null);
  const install = (keyPem, chainPem, info) => { current = { keyPem, chainPem, info, ctx: tls.createSecureContext({ key: keyPem, cert: chainPem, minVersion: 'TLSv1.2' }) }; };

  try {
    const doc = store.readDoc();
    if (doc) { install(doc.keyPem, doc.chainPem, await verifyCertificate({ names: certNames, ...doc, roots, now: now() })); log(`[service-tls] loaded the stored certificate (valid until ${new Date(current.info.notAfter).toISOString()})`); }
  } catch (e) { current = null; log(`[service-tls] the stored certificate is not used (${e.message}); a new one will be ordered`); }

  const sockets = new Set();
  const http = { server: null, port: null }, fronts = Object.fromEntries(tlsRoles.map((r) => [r, { server: null, port: null }]));
  const listen = (slot, make, port) => new Promise((ok, no) => {
    if (slot.server) return ok();
    const s = track(make(), sockets);
    s.once('error', (e) => { slot.server = null; no(e); });
    s.listen(port, host, () => { slot.server = s; slot.port = s.address().port; ok(); });
  });
  const close = (slot) => { if (slot.server) { slot.server.close(); slot.server = null; } };
  async function openFronts() {
    await listen(http, () => createHttpFront({ routes, challenges, headTimeoutMs, idleMs, maxConnections }), c.httpPort);
    for (const r of tlsRoles) if (context()) await listen(fronts[r], () => createTlsFront({ name: all[r], port: c.upstreams[r], context, idleMs, maxConnections }), c.tlsPorts[r]);
  }
  function closeFronts() {
    close(http); for (const r of tlsRoles) close(fronts[r]);
    for (const s of sockets) s.destroy();
    challenges.clear();
  }
  function refuse(d) {
    const why = d?.reason || d?.status || 'refused';
    if (!st.refused) log(`[service-tls] the platform host policy REFUSES this host (${why}): every listener closed, no order or renewal`);
    st.refused = why; st.admitted = false;
    ordering?.abort(); closeFronts();
  }
  async function checkPolicy() {
    let d;
    try { d = await admit(); } catch (e) { st.policyError = String(e.message).slice(0, 200); return; }   // transient: no change
    st.policyError = null;
    if (d?.admit !== true) return refuse(d);
    if (st.refused) log('[service-tls] admitted again: serving resumes');
    st.refused = null; st.admitted = true;
    if (!stopped) await openFronts();
  }
  const backoff = (e) => {
    st.failures++;
    const wait = Math.min(maxBackoffMs, backoffMs * 2 ** (st.failures - 1));
    st.nextAt = Math.max(now() + wait, e?.retryAt || 0);
    st.lastError = String(e?.message || e).slice(0, 300);
    saveLedger();
    log(`[service-tls] order failed (${st.lastError}); the current certificate ${current ? 'keeps serving' : 'is absent'}; next attempt ${new Date(st.nextAt).toISOString()}`);
  };
  async function tick() {
    if (stopped || !st.admitted || st.refused || ordering) return;
    if (st.unsaved) { try { store.writeDoc(st.unsaved.keyPem, st.unsaved.chainPem); st.unsaved = null; } catch (e) { log(`[service-tls] saving the certificate failed again (${e.code || e.message})`); } }
    if (current && now() >= current.info.notAfter) { log('[service-tls] the certificate expired: TLS closed until a new one is issued'); current = null; for (const r of tlsRoles) close(fronts[r]); }
    if (c.orders !== 'approved') {                          // held (or anything else): never contact the CA
      if (!st.heldLogged) { st.heldLogged = true; log('[service-tls] ACME orders are HELD by configuration (orders != "approved"): no account, order or renewal; the port-80 front serves'); }
      return;
    }
    if ((current && now() < current.info.renewAt) || now() < st.nextAt) return;
    // the host's own share of the CA's per-registered-domain allowance: at most budget.count certificates per budget.windowMs
    ledger.issued = ledger.issued.filter((t) => t > now() - budget.windowMs);
    if (ledger.issued.length >= budget.count) {
      st.nextAt = Math.min(...ledger.issued) + budget.windowMs; st.lastError = `issuance budget spent (${budget.count} certificates per ${Math.round(budget.windowMs / 86400e3)} days)`;
      saveLedger(); log(`[service-tls] ${st.lastError}; next order ${new Date(st.nextAt).toISOString()}`); return;
    }
    // a FRESH admission right before every order (no cached admit)
    let d; try { d = await admit(); } catch (e) { return backoff(new Error(`platform host policy unavailable: ${e.message}`)); }
    if (d?.admit !== true) return refuse(d);
    ordering = new AbortController();
    const key = newKey(), keyPem = key.export({ type: 'pkcs8', format: 'pem' });
    try {
      st.orders++;
      const chainPem = await acme.issue(certNames, { key, challenges: challengeStore, signal: ordering.signal });
      if (ordering.signal.aborted) throw new Error('aborted');
      ledger.issued.push(now()); saveLedger();                 // the CA counted it, whether or not we accept it
      const info = await verifyCertificate({ names: certNames, keyPem, chainPem, roots, now: now() });
      try { store.writeDoc(keyPem, chainPem); } catch (e) { st.unsaved = { keyPem, chainPem }; log(`[service-tls] saving the new certificate failed (${e.code || e.message}); serving it from memory, saving again next round`); }
      install(keyPem, chainPem, info);
      st.failures = 0; st.nextAt = 0; st.lastError = null; saveLedger();
      log(`[service-tls] certificate issued for ${certNames.join(', ')} (valid until ${new Date(info.notAfter).toISOString()})`);
      if (st.admitted && !st.refused && !stopped) await openFronts();
    } catch (e) { backoff(e); }
    finally { ordering = null; }
  }
  const round = async () => { await checkPolicy(); await tick(); };
  await checkPolicy();
  if (loop) { void tick(); timer = setInterval(() => void round().catch((e) => log(`[service-tls] ${e.message}`)), intervalMs); timer.unref?.(); }
  return {
    checkPolicy, tick, round,
    get ports() { return { http: http.port, tls: Object.fromEntries(tlsRoles.map((r) => [r, fronts[r].port])) }; },
    status: () => ({ hostId: c.hostId, ordering: c.orders === 'approved' ? 'approved' : 'held', issuedInWindow: ledger.issued.length, names: certNames, keyDir: acl, admitted: st.admitted, refused: st.refused, policyError: st.policyError,
      certificate: current ? { notBefore: current.info.notBefore, notAfter: current.info.notAfter, renewAt: current.info.renewAt, fingerprint: current.info.fingerprint } : null,
      orders: st.orders, failures: st.failures, nextAt: st.nextAt, lastError: st.lastError, unsaved: !!st.unsaved,
      listening: { http: !!http.server, tls: Object.fromEntries(tlsRoles.map((r) => [r, !!fronts[r].server])) } }),
    async stop() { stopped = true; if (timer) clearInterval(timer); ordering?.abort(); closeFronts(); },
  };
}

/** The production admission: the runner's own policy inputs, a fresh decision per call (no cached admit). */
export async function policyAdmission(c, { fetch = globalThis.fetch, log = () => {} } = {}) {
  const { policyEnv, policyCarrierFetch } = await import('./runner.mjs');
  const { resolveHostPolicyConfig, createHostPolicyRuntime, fileStore } = await import('../host-policy-runtime.mjs');
  const { policyMirrorStateDir, ...p } = c.policy;
  const sub = { ...p, services: policyMirrorStateDir ? [{ role: 'policy-mirror', config: { stateDir: policyMirrorStateDir } }] : [] };
  const resolved = resolveHostPolicyConfig({ env: policyEnv(sub), chainId: 8453 });
  if (!resolved.on) fail(`the platform host policy resolved off (${resolved.reason}): refused`);
  const rt = createHostPolicyRuntime(resolved, { store: fileStore(path.join(c.stateDir, 'platform-host-policy.json')), fetch: await policyCarrierFetch(sub, { fetch, log }), log, ttlMs: 1 });
  return async () => (await rt.admissions([c.hostId]))[c.hostId];
}

/** The role, in the host-service role shape (roles.mjs). */
export const SERVICE_TLS_ROLE = Object.freeze({
  entry: 'network/host-services/service-tls.mjs', bundleEntry: 'network/host-services/entries/service-tls.mjs',
  kind: 'tls-front', runtime: 'node>=22 (host role; not a wasm component)',
  serves: 'HTTPS for this host\'s derived service names (one Let\'s Encrypt certificate, http-01 on the port-80 front, TLS terminated on loopback, raw pipe to each role); not advertised on its own',
  state: { durable: true, what: 'keys/current.pem (TLS key + chain, one atomic document) and keys/account.json (ACME account key), generated on this host', rebuild: 're-issued from the CA (Let\'s Encrypt duplicate-certificate limits apply)' },
  secrets: 'generated on the host and kept in its private key directory (ACL preflight): the ACME account key and the TLS key; none in its configuration',
  cold: ['an admit of this host by the platform host policy (fresh, before every order)', 'public DNS for the derived names pointing at the WireGuard providers that route them (G1)', 'Let\'s Encrypt (for a new or renewed certificate only; a stored valid one serves without it)'],
  notCold: ['the relay or certs.js', 'any central issuer', 'DigitalOcean (it forwards raw TCP only)', 'any app'],
  validate: validateServiceTlsConfig,
  launch(c) { return { configFile: c, env: {} }; },
});

/** The role process: the runner passes the bound configuration file. */
export async function main(file) {
  const c = validateLaunchConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  const log = (m) => console.log(new Date().toISOString(), m);
  const role = await startServiceTls(c, { admit: await policyAdmission(c, { log }), log });
  console.log(JSON.stringify({ serviceTls: { names: role.status().names, keyDir: role.status().keyDir } }));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { role.stop().then(() => process.exit(0)); });
  setInterval(() => {}, 1 << 30);
}
