// OPTIONAL immutable witness ARCHIVE on S3 (Sia-S3, or any S3 with conditional PUT and ListObjectsV2) for
// network/witness-gateway.mjs: the proof-aware candidate contract {candidates(w), put(w, result), get(w)}, keyed by
// witnessKey(). Its answers are UNTRUSTED: the gateway verifies every candidate with the witness checker against an
// authenticated state root before using it, and archives only answers it has verified.
//
// What it is: downstream EVIDENCE AVAILABILITY for block-hash-pinned witnesses (eth_getProof / eth_getCode at
// {blockHash}). What it is NOT: a consensus authority, a source of freshness, or a bootstrap dependency (with S3
// unconfigured or down, every read is an empty candidate list and the gateway behaves as without it).
//   * Content-addressed and create-only: one immutable object per distinct answer,
//       <prefix>/<chainId>/<blockHash>/<sha256(request)>/<sha256(canonical result)>.json
//     so a wrong first write (a lying source's answer from an older, unverifying writer, or a tampered bucket) can
//     never shadow a valid answer for the same request: the valid one is another object. The single-slot layout of the
//     first version (<…>/<sha256(request)>.json) is still read, as the LAST candidate.
//   * An object is a candidate only if its envelope (format, chain id, block hash, full normalized request) matches
//     exactly and its name is the hash of its result. Anything else (tampered, misnamed, oversized, truncated, slow,
//     unreachable) is skipped and counted, never an error that could stall or fail the gateway.
//   * Bounded reads: ListObjectsV2 pages of at most maxCandidates keys, at most maxListPages pages and maxListBytes per
//     page, at most maxCandidates objects fetched, all inside one read budget (readBudgetMs, and the caller's
//     deadline). ADVERSARIAL BUCKET OWNER: whoever can write the bucket can bury valid answers under more than
//     maxCandidates junk objects (names are hashes, but junk can be ground to sort first) or delete them: an
//     availability loss for those requests, never a wrong answer, because nothing here is trusted.
//   * Writes are OFF unless `archive: true`: an archived eth_getProof names the accounts and storage slots this node
//     read, at which block (PRIVACY). Even read-only, every lookup reveals to the S3 operator which request hash was
//     asked and when (request hashes of guessable slots can be recognised): reads are metadata too.
//     Writes are create-only (If-None-Match: *); a 412 re-reads the object and compares it exactly, and a different
//     object under that content name is never overwritten (`conflicts`).
//   * Writes never block reads or the caller: put() returns as soon as the write is queued (bounded queue, bounded
//     in-flight writes, per-write timeout); idle() resolves when the queue has drained. close() kills every request.
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
 * -> { candidates(w, {deadline}), get(w), put(w, result), idle(), close(), stats(), privacy }
 */
export function s3WitnessCache({ endpoint, bucket, region = 'us-east-1', prefix = 'enclave-witness', chainId, credentials, archive = false,
  timeoutMs = 4000, readBudgetMs = 8000, putTimeoutMs = 60000, maxObjectBytes = 4 << 20, maxCandidates = 8, maxListPages = 2, maxListBytes = 256 << 10,
  maxInflightPuts = 2, maxQueuedPuts = 64, maxInflightGets = 8, curl = 'curl' } = {}) {
  const ep = rpcEndpoint(endpoint);  // throws RpcUrlError without echoing the URL
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket || '')) throw new Error('invalid bucket name');
  if (!/^[a-z0-9-]{1,32}$/.test(region)) throw new Error('invalid region');
  if (!/^[a-z0-9-]{1,64}$/.test(prefix)) throw new Error('invalid prefix');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('chainId required (keys are chain-namespaced)');
  if (!credentials || !ACCESS_KEY.test(credentials.accessKeyId || '') || !SECRET.test(credentials.secretAccessKey || '')) throw new Error('invalid S3 credentials');
  if (typeof archive !== 'boolean') throw new Error('archive must be true or false');
  for (const [n, v, lo, hi] of [['timeoutMs', timeoutMs, 200, 60000], ['readBudgetMs', readBudgetMs, 200, 300000], ['putTimeoutMs', putTimeoutMs, 1000, 600000],
    ['maxObjectBytes', maxObjectBytes, 1024, 16 << 20], ['maxCandidates', maxCandidates, 1, 64], ['maxListPages', maxListPages, 1, 16], ['maxListBytes', maxListBytes, 4096, 4 << 20],
    ['maxInflightPuts', maxInflightPuts, 1, 16], ['maxQueuedPuts', maxQueuedPuts, 0, 4096], ['maxInflightGets', maxInflightGets, 1, 64]])
    if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new Error(`invalid ${n}`);
  const creds = { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey };
  const base = ep.url.origin + ep.url.pathname.replace(/\/+$/, '');
  const children = new Set();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 's3wc-'));  // 0700 (mkdtemp); request bodies only, removed on close
  const stats = { lists: 0, candidates: 0, hits: 0, misses: 0, rejected: {}, errors: {}, puts: 0, putsExisting: 0, conflicts: 0, putsFailed: 0, putsDropped: 0, putsSkipped: 0 };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  let closed = false, gets = 0;
  const waiting = [], queue = [];
  let puts = 0;

  const valid = (w) => w && KEY.test(w.key || '') && HASH.test(w.blockHash || '') && typeof w.norm === 'string';
  const folder = (w) => `${prefix}/${chainId}/${w.blockHash}/${w.key}/`;            // content-addressed answers
  const legacyKey = (w) => `${prefix}/${chainId}/${w.blockHash}/${w.key}.json`;       // version-1 single slot
  const contentName = (result) => createHash('sha256').update(canonicalJson(result)).digest('hex');
  const urlOf = (key) => `${base}/${bucket}/${key}`;
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

  const left = (deadline) => deadline - Date.now();
  async function fetchEntry(w, key, deadline) {
    const t = Math.min(timeoutMs, left(deadline));
    if (t < 50) { bump(stats.errors, 'budget'); return undefined; }
    if (!(await acquire())) { bump(stats.errors, 'busy'); return undefined; }
    if (closed) { release(); return undefined; }
    try {
      const r = await req({ method: 'GET', url: urlOf(key), timeoutMs: t, maxBytes: maxObjectBytes });
      if (r.status === 404) { stats.misses++; return undefined; }
      if (r.status !== 200) { bump(stats.errors, 'http' + r.status); return undefined; }
      return accept(w, r.body);
    } catch (e) { bump(stats.errors, e.code || 'error'); return undefined; }
    finally { release(); }
  }
  /** Up to maxCandidates content-addressed object keys for w, in listing (lexicographic) order; bounded pages. */
  async function listKeys(w, deadline) {
    const pfx = folder(w), keys = [];
    const ok = new RegExp('^' + pfx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[0-9a-f]{64}\\.json$');
    let token = null;
    for (let page = 0; page < maxListPages && keys.length < maxCandidates; page++) {
      const t = Math.min(timeoutMs, left(deadline));
      if (t < 50) { bump(stats.errors, 'budget'); break; }
      const q = `list-type=2&max-keys=${maxCandidates}&prefix=${encodeURIComponent(pfx)}` + (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
      if (!(await acquire())) { bump(stats.errors, 'busy'); break; }
      let r;
      try { r = await req({ method: 'GET', url: `${base}/${bucket}?${q}`, timeoutMs: t, maxBytes: maxListBytes }); }
      catch (e) { bump(stats.errors, 'list-' + (e.code || 'error')); break; }
      finally { release(); }
      stats.lists++;
      if (r.status !== 200) { bump(stats.errors, 'list' + r.status); break; }
      const xml = r.body.toString('utf8');
      for (const m of xml.matchAll(/<Key>([^<]{1,512})<\/Key>/g)) {
        if (ok.test(m[1])) { if (keys.length < maxCandidates) keys.push(m[1]); } else bump(stats.rejected, 'listed-name');
      }
      const more = /<IsTruncated>true<\/IsTruncated>/.test(xml), next = /<NextContinuationToken>([^<]{1,1024})<\/NextContinuationToken>/.exec(xml);
      if (!more || !next) break;
      token = next[1];
    }
    return keys;
  }
  /**
   * Every stored answer for w that passes the envelope and content-address checks (UNVERIFIED: the gateway checks
   * each against an authenticated root). Bounded by maxCandidates, listing bounds and one read budget; never throws.
   */
  async function candidates(w, { deadline = Date.now() + readBudgetMs } = {}) {
    if (closed || !valid(w)) return [];
    deadline = Math.min(deadline, Date.now() + readBudgetMs);
    const out = [];
    try {
      for (const key of await listKeys(w, deadline)) {
        const got = await fetchEntry(w, key, deadline);
        if (!got) continue;
        const [ok, v] = got;
        if (!ok) { bump(stats.rejected, v); continue; }
        if (contentName(v) !== key.slice(-69, -5)) { bump(stats.rejected, 'address'); continue; }   // name = hash of content
        out.push(v);
      }
      if (out.length < maxCandidates) {
        const got = await fetchEntry(w, legacyKey(w), deadline);
        if (got) { if (got[0]) out.push(got[1]); else bump(stats.rejected, got[1]); }
      }
    } catch (e) { bump(stats.errors, e?.code || 'error'); }
    stats.candidates += out.length;
    if (out.length) stats.hits++; else stats.misses++;
    return out;
  }
  /** Compatibility: the first candidate (unverified, like every read). */
  async function get(w) { return (await candidates(w))[0]; }

  async function write(w, result, body) {
    const key = folder(w) + contentName(result) + '.json';
    const sha = createHash('sha256').update(body).digest('hex');
    const r = await req({ method: 'PUT', url: urlOf(key), timeoutMs: putTimeoutMs, maxBytes: 64 << 10, body,
      headers: ['If-None-Match: *', 'Content-Type: application/json', `x-amz-content-sha256: ${sha}`] });
    if (r.status === 200) { stats.puts++; return; }
    if (r.status !== 412) { stats.putsFailed++; bump(stats.errors, 'put' + r.status); return; }
    // create-only: the content name exists. Equal bytes = done; different bytes = conflict, never overwritten.
    const g = await req({ method: 'GET', url: urlOf(key), timeoutMs, maxBytes: maxObjectBytes });
    if (g.status === 200 && g.body.equals(Buffer.from(body))) stats.putsExisting++;
    else stats.conflicts++;
  }
  const idlers = [];
  function pump() {
    while (!closed && puts < maxInflightPuts && queue.length) {
      const [w, result, body] = queue.shift();
      puts++;
      write(w, result, body).catch((e) => { stats.putsFailed++; bump(stats.errors, 'put-' + (e.code || 'error')); })
        .finally(() => { puts--; pump(); });
    }
    if (!puts && !queue.length) for (const r of idlers.splice(0)) r();
  }
  /** Never throws and never waits for the write: queues it (bounded) and returns. Call only with VERIFIED answers. */
  function put(w, result) {
    if (!archive || closed) { stats.putsSkipped++; return Promise.resolve(); }
    if (!valid(w) || result === undefined) { stats.putsSkipped++; return Promise.resolve(); }
    const body = entry(w, result);
    if (Buffer.byteLength(body) > maxObjectBytes) { stats.putsSkipped++; return Promise.resolve(); }
    if (queue.length >= maxQueuedPuts) { stats.putsDropped++; return Promise.resolve(); }
    queue.push([w, result, body]);
    pump();
    return Promise.resolve();
  }
  /** Resolves when no write is queued or in flight (tests, orderly shutdown). */
  function idle() { return !puts && !queue.length ? Promise.resolve() : new Promise((r) => idlers.push(r)); }
  async function close() {
    closed = true;
    stats.putsDropped += queue.splice(0).length;
    const exits = [...children].map((p) => { p.kill('SIGKILL'); return p.exited; });
    await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 2000))]);  // bounded: killed curls reaped
    for (const waiter of waiting.splice(0)) waiter();  // they see `closed` and return a miss
    for (const r of idlers.splice(0)) r();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return {
    candidates, get, put, idle, close,
    stats: () => structuredClone({ ...stats, inflight: { gets, puts, queued: queue.length, children: children.size } }),
    privacy: archive ? 'ARCHIVE ON: requested accounts, storage slots and block hashes are written to the bucket' : 'read-only: nothing is written',
  };
}
