// OPTIONAL immutable witness-cache backend on S3 (Sia-S3, or any S3 that supports conditional PUT) for
// network/witness-gateway.mjs: the same {get(w), put(w, result)} contract as dirWitnessCache, keyed by witnessKey().
//
// What it is: downstream EVIDENCE AVAILABILITY for block-hash-pinned witnesses (eth_getProof / eth_getCode at
// {blockHash}). What it is NOT: a consensus authority, a source of freshness, or a bootstrap dependency.
//   * The gateway consults get() only after every live upstream failed, and only for a block-hash-pinned request, so
//     a hit is availability for THAT block only. Helios re-verifies every returned witness against the signed head
//     (state root / code hash); a wrong, stale or tampered entry fails verification and is never an answer.
//   * Keys are chain-namespaced and pinned by block hash and request: <prefix>/<chainId>/<blockHash>/<sha256>.json,
//     and an entry is accepted only if its own format, chain id, block hash and full normalized request match exactly.
//     Anything else (tampered, oversized, truncated, slow, unreachable) is a miss, counted in stats, never an error that
//     could stall the gateway.
//   * Writes are OFF unless `archive: true`: an archived eth_getProof names the accounts and storage slots this node
//     read, at which block (PRIVACY). Writes are create-only (If-None-Match: *). A 412 compares the stored entry
//     with ours, and a different entry is never overwritten (a `conflicts` count shows two sources disagreed; the
//     first entry stays, and if it is wrong Helios rejects it: availability loss for that key, never a wrong answer).
//   * Writes never block reads: the gateway does not await put(); here puts queue (bounded) and run with a timeout,
//     dropping work beyond the bound. close() kills every in-flight request.
// Signing and transport: curl's maintained AWS SigV4 implementation (`--aws-sigv4`, libcurl; checked against AWS's
// published signing-suite vectors and a real MinIO server in test/s3-witness-cache.test.mjs). The access key travels
// to curl as a config file on its standard input: never in argv or the environment, never in errors or stats. A
// request body goes through a 0600 file in a private 0700 directory, removed after the request (Node's child stdio
// pipes are socketpairs, which curl cannot open as /dev/fd/N, and stdin carries the config).
// Endpoint URL policy is network/rpc-identity.mjs's: https, plain http only on loopback, no credentials in the URL.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rpcEndpoint } from './rpc-identity.mjs';

const FORMAT = 'enclave-witness-s3/v1';
const HASH = /^0x[0-9a-f]{64}$/, KEY = /^[0-9a-f]{64}$/;
const ACCESS_KEY = /^[A-Za-z0-9]{3,128}$/, SECRET = /^[A-Za-z0-9/+=]{8,256}$/;  // no quote, backslash or newline: safe in a curl config

/** Deterministic JSON (object keys sorted), so equal entries are equal bytes whatever key order an upstream used. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/**
 * One SigV4-signed S3 request through curl. -> { status, body: Buffer } or throws { code: 'timeout' | 'oversize' | 'curl' }.
 * Bounded: wall time (curl --max-time plus a kill), response bytes (curl --max-filesize plus a stream cap).
 */
export function s3Request({ method, url, region, credentials, headers = [], body = null, timeoutMs, maxBytes, curl = 'curl', children, scratch }) {
  let bodyFile = null;
  if (body !== null) {
    const dir = scratch || fs.mkdtempSync(path.join(os.tmpdir(), 's3wc-'));
    bodyFile = path.join(dir, 'b-' + randomBytes(12).toString('hex'));
    fs.writeFileSync(bodyFile, body, { flag: 'wx', mode: 0o600 });
    if (!scratch) bodyFile = { file: bodyFile, dir };
  }
  const cleanup = () => { if (!bodyFile) return; const f = bodyFile.file || bodyFile; fs.rmSync(f, { force: true }); if (bodyFile.dir) fs.rmSync(bodyFile.dir, { recursive: true, force: true }); };
  return new Promise((resolve, reject) => {
    const secs = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
    const args = ['-q', '--silent', '--show-error', '--config', '-', '--aws-sigv4', `aws:amz:${region}:s3`, '--proto', '=http,https',
      '--max-redirs', '0', '--noproxy', '*', '--max-time', secs, '--connect-timeout', secs, '--max-filesize', String(maxBytes),
      '--write-out', '%{stderr}\n@@status=%{http_code}', '-X', method];
    for (const h of headers) args.push('-H', h);
    if (bodyFile) args.push('--data-binary', '@' + (bodyFile.file || bodyFile));
    args.push(url);
    const p = spawn(curl, args, { env: { PATH: process.env.PATH || '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    p.exited = new Promise((r) => p.once('close', r));
    children?.add(p);
    const out = []; let size = 0, err = '', settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); children?.delete(p); cleanup(); fn(v); };
    const timer = setTimeout(() => { p.kill('SIGKILL'); done(reject, Object.assign(new Error('S3 request timed out'), { code: 'timeout' })); }, timeoutMs + 1000);
    p.stdout.on('data', (c) => { size += c.length; if (size > maxBytes) { p.kill('SIGKILL'); done(reject, Object.assign(new Error('S3 response too large'), { code: 'oversize' })); } else out.push(c); });
    p.stderr.on('data', (c) => { if (err.length < 4096) err += c; });
    p.on('error', () => done(reject, Object.assign(new Error('curl could not run'), { code: 'curl' })));
    p.on('close', (code) => {
      if (code === 28) return done(reject, Object.assign(new Error('S3 request timed out'), { code: 'timeout' }));
      if (code === 63) return done(reject, Object.assign(new Error('S3 response too large'), { code: 'oversize' }));
      const m = /@@status=(\d{3})\s*$/.exec(err);
      if (code !== 0 || !m) return done(reject, Object.assign(new Error(`S3 transport failed (curl exit ${code})`), { code: 'curl' }));
      done(resolve, { status: Number(m[1]), body: Buffer.concat(out) });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(`user = "${credentials.accessKeyId}:${credentials.secretAccessKey}"\n`);
  });
}

/**
 * endpoint: S3 base URL (https, or http on loopback). bucket, region. chainId: the gateway's chain (namespaces keys).
 * credentials: {accessKeyId, secretAccessKey}, loaded by the caller from a 0600 file (never logged).
 * archive: false (default) = read-only; true = also write witnesses (see PRIVACY above).
 * -> { get(w), put(w, result), close(), stats(), privacy }
 */
export function s3WitnessCache({ endpoint, bucket, region = 'us-east-1', prefix = 'enclave-witness', chainId, credentials, archive = false,
  timeoutMs = 4000, putTimeoutMs = 60000, maxObjectBytes = 4 << 20, maxInflightPuts = 2, maxQueuedPuts = 64, maxInflightGets = 8, curl = 'curl' } = {}) {
  const ep = rpcEndpoint(endpoint);  // throws RpcUrlError without echoing the URL
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket || '')) throw new Error('invalid bucket name');
  if (!/^[a-z0-9-]{1,32}$/.test(region)) throw new Error('invalid region');
  if (!/^[a-z0-9-]{1,64}$/.test(prefix)) throw new Error('invalid prefix');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('chainId required (keys are chain-namespaced)');
  if (!credentials || !ACCESS_KEY.test(credentials.accessKeyId || '') || !SECRET.test(credentials.secretAccessKey || '')) throw new Error('invalid S3 credentials');
  if (typeof archive !== 'boolean') throw new Error('archive must be true or false');
  for (const [n, v, lo, hi] of [['timeoutMs', timeoutMs, 200, 60000], ['putTimeoutMs', putTimeoutMs, 1000, 600000], ['maxObjectBytes', maxObjectBytes, 1024, 16 << 20],
    ['maxInflightPuts', maxInflightPuts, 1, 16], ['maxQueuedPuts', maxQueuedPuts, 0, 4096], ['maxInflightGets', maxInflightGets, 1, 64]])
    if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new Error(`invalid ${n}`);
  const creds = { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey };
  const base = ep.url.origin + ep.url.pathname.replace(/\/+$/, '');
  const children = new Set();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 's3wc-'));  // 0700 (mkdtemp); request bodies only, removed on close
  const stats = { hits: 0, misses: 0, rejected: {}, errors: {}, puts: 0, putsExisting: 0, conflicts: 0, putsFailed: 0, putsDropped: 0, putsSkipped: 0 };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  let closed = false, gets = 0;
  const waiting = [], queue = [];
  let puts = 0;

  const valid = (w) => w && KEY.test(w.key || '') && HASH.test(w.blockHash || '') && typeof w.norm === 'string';
  const objectUrl = (w) => `${base}/${bucket}/${prefix}/${chainId}/${w.blockHash}/${w.key}.json`;
  const entry = (w, result) => canonicalJson({ format: FORMAT, chainId, blockHash: w.blockHash, request: w.norm, result });
  const req = (o) => s3Request({ region, credentials: creds, curl, children, scratch, ...o });

  function accept(w, buf) {
    let e;
    try { e = JSON.parse(buf.toString('utf8')); } catch { return [false, 'malformed']; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) return [false, 'malformed'];
    const keys = Object.keys(e).sort().join(',');
    if (keys !== 'blockHash,chainId,format,request,result') return [false, 'fields'];
    if (e.format !== FORMAT) return [false, 'format'];
    if (e.chainId !== chainId) return [false, 'chain'];
    if (e.blockHash !== w.blockHash) return [false, 'block'];
    if (e.request !== w.norm) return [false, 'request'];
    return [true, e.result];
  }

  // read slots: a finished read hands its slot straight to the oldest waiter; a waiter gives up after one read's budget
  function acquire() {
    if (gets < maxInflightGets) { gets++; return Promise.resolve(true); }
    return new Promise((r) => {
      const waiter = () => { clearTimeout(t); r(true); };
      const t = setTimeout(() => { const i = waiting.indexOf(waiter); if (i >= 0) waiting.splice(i, 1); r(false); }, timeoutMs);
      waiting.push(waiter);
    });
  }
  function release() { const next = waiting.shift(); if (next) next(); else gets--; }

  async function get(w) {
    if (closed || !valid(w)) return undefined;
    if (!(await acquire())) { bump(stats.errors, 'busy'); return undefined; }
    if (closed) { release(); return undefined; }
    try {
      const r = await req({ method: 'GET', url: objectUrl(w), timeoutMs, maxBytes: maxObjectBytes });
      if (r.status === 404) { stats.misses++; return undefined; }
      if (r.status !== 200) { bump(stats.errors, 'http' + r.status); return undefined; }
      const [ok, v] = accept(w, r.body);
      if (!ok) { bump(stats.rejected, v); return undefined; }
      stats.hits++;
      return v;
    } catch (e) { bump(stats.errors, e.code || 'error'); return undefined; }
    finally { release(); }
  }

  async function write(w, body) {
    const sha = createHash('sha256').update(body).digest('hex');
    const r = await req({ method: 'PUT', url: objectUrl(w), timeoutMs: putTimeoutMs, maxBytes: 64 << 10, body,
      headers: ['If-None-Match: *', 'Content-Type: application/json', `x-amz-content-sha256: ${sha}`] });
    if (r.status === 200) { stats.puts++; return; }
    if (r.status !== 412) { stats.putsFailed++; bump(stats.errors, 'put' + r.status); return; }
    // create-only: something is already there. Equal entry = done; different entry = conflict, never overwritten.
    const g = await req({ method: 'GET', url: objectUrl(w), timeoutMs, maxBytes: maxObjectBytes });
    if (g.status === 200 && g.body.equals(Buffer.from(body))) stats.putsExisting++;
    else stats.conflicts++;
  }
  function pump() {
    while (!closed && puts < maxInflightPuts && queue.length) {
      const [w, body, resolve] = queue.shift();
      puts++;
      write(w, body).catch((e) => { stats.putsFailed++; bump(stats.errors, 'put-' + (e.code || 'error')); })
        .finally(() => { puts--; resolve(); pump(); });
    }
  }
  /** Never throws, never blocks the caller beyond queueing; resolves when the write finished, failed or was dropped. */
  function put(w, result) {
    if (!archive || closed) { stats.putsSkipped++; return Promise.resolve(); }
    if (!valid(w) || result === undefined) { stats.putsSkipped++; return Promise.resolve(); }
    const body = entry(w, result);
    if (Buffer.byteLength(body) > maxObjectBytes) { stats.putsSkipped++; return Promise.resolve(); }
    if (queue.length >= maxQueuedPuts) { stats.putsDropped++; return Promise.resolve(); }
    return new Promise((resolve) => { queue.push([w, body, resolve]); pump(); });
  }
  async function close() {
    closed = true;
    for (const [, , resolve] of queue.splice(0)) { stats.putsDropped++; resolve(); }
    const exits = [...children].map((p) => { p.kill('SIGKILL'); return p.exited; });
    await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 2000))]);  // bounded: killed curls reaped
    for (const waiter of waiting.splice(0)) waiter();  // they see `closed` and return a miss
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return {
    get, put, close,
    stats: () => structuredClone({ ...stats, inflight: { gets, puts, queued: queue.length, children: children.size } }),
    privacy: archive ? 'ARCHIVE ON: requested accounts, storage slots and block hashes are written to the bucket' : 'read-only: nothing is written',
  };
}
