// Shared offline S3 test environment: a REAL S3 server (MinIO, $MINIO_BIN) on loopback with random per-run
// credentials, and a fault-injecting fake S3. Test-only: nothing here is used by the gateway or the backend.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { s3Request, canonicalJson } from '../../network/s3-witness-cache.mjs';

export const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Random per-run credentials (no credential literal in source); alphanumeric, as the backend requires. */
export const testCredentials = () => ({ accessKeyId: 'enclavetest' + randomBytes(4).toString('hex'), secretAccessKey: randomBytes(18).toString('base64url').replace(/[-_]/g, 'A') });

/** Start MinIO in `dir` with `creds`; create `bucket`. -> {endpoint, stop()} */
export async function startMinio({ bin = process.env.MINIO_BIN, dir, creds, bucket = 'witness' }) {
  const port = await freePort(), cport = await freePort();
  fs.mkdirSync(dir, { recursive: true });
  const p = spawn(bin, ['server', '--quiet', '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${cport}`, dir],
    { env: { PATH: process.env.PATH, HOME: path.dirname(dir), MINIO_ROOT_USER: creds.accessKeyId, MINIO_ROOT_PASSWORD: creds.secretAccessKey, MINIO_BROWSER: 'off' }, stdio: 'ignore' });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) { try { if ((await fetch(endpoint + '/minio/health/ready')).ok) break; } catch {} await sleep(250); }
  const mk = await s3Request({ method: 'PUT', url: `${endpoint}/${bucket}`, region: 'us-east-1', credentials: creds, timeoutMs: 5000, maxBytes: 65536 });
  if (mk.status !== 200) throw new Error('bucket not created: HTTP ' + mk.status);
  return { endpoint, bucket, stop: () => p.kill('SIGKILL') };
}

/** A raw signed S3 request as a bucket writer (the tests' attacker or inspector). */
export const raw = (s3, creds, o) => s3Request({ region: 'us-east-1', credentials: creds, timeoutMs: 10000, maxBytes: 8 << 20, ...o, url: `${s3.endpoint}/${s3.bucket}/${o.key ?? ''}${o.query ? '?' + o.query : ''}` });
/** The object keys under a prefix (one page, up to 1000). */
export async function listAll(s3, creds, prefix) {
  const r = await raw(s3, creds, { method: 'GET', query: `list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}` });
  return [...r.body.toString().matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}
/** The v1 envelope the backend reads (format, chain id, block hash, request, result). */
export const envelope = (w, result, over = {}) => canonicalJson({ format: 'enclave-witness-s3/v1', chainId: 8453, blockHash: w.blockHash, request: w.norm, result, ...over });

/** A fake S3 driven by `handler(req, res)`. -> {endpoint, close()} */
export async function fakeS3(handler) {
  const s = http.createServer(handler);
  const sockets = new Set();
  s.on('connection', (k) => { sockets.add(k); k.on('close', () => sockets.delete(k)); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { endpoint: `http://127.0.0.1:${s.address().port}`, close: () => { for (const k of sockets) k.destroy(); s.close(); } };
}
