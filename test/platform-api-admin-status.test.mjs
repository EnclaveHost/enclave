// `scripts/platform-api-admin.mjs status`: an ADVISORY, unauthenticated read of a member's role status (nothing is verified,
// signed or sent). Against a local HTTP fixture that records exactly what arrives, the tool must issue a body-less GET of
// STATUS_PATH and print the answer, both in process (main with injected io) and through the real command-line entry.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATUS_PATH } from '../metal/guest/platform-api-role.mjs';
import * as ADMIN_CLI from '../scripts/platform-api-admin.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS = { format: 'enclave-platform-api-role/v1', member: 1, role: 'follower', haveKey: true, leader: 0 };
const seen = [];
const srv = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, bodyBytes: Buffer.concat(c).length, contentType: req.headers['content-type'] ?? null,
      contentLength: req.headers['content-length'] ?? null, chunked: /chunked/i.test(req.headers['transfer-encoding'] || '') });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(STATUS));
  });
});
after(() => { srv.closeAllConnections?.(); srv.close(); });

test('status: one body-less GET of the status path; the answer is printed as is (in process and through the real entry)', { timeout: 30000 }, async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${srv.address().port}`, expected = JSON.stringify(STATUS, null, 1) + '\n';
  const out = [], err = [];
  const code = await ADMIN_CLI.main(['node', 'platform-api-admin.mjs', 'status', '--target', target], { io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
  assert.equal(code, 0);
  assert.equal(out.join(''), expected, 'the status answer is the output');
  assert.deepEqual(err, []);
  const child = await new Promise((resolve) => execFile(process.execPath, [path.join(REPO, 'scripts/platform-api-admin.mjs'), 'status', '--target', target], { timeout: 20000 },
    (e, stdout, stderr) => resolve({ code: e ? (e.code ?? 1) : 0, stdout, stderr })));
  assert.equal(child.code, 0, child.stderr); assert.equal(child.stdout, expected); assert.equal(child.stderr, '');
  assert.equal(seen.length, 2, 'exactly one request per run');
  for (const s of seen) assert.deepEqual(s, { method: 'GET', url: STATUS_PATH, bodyBytes: 0, contentType: null, contentLength: null, chunked: false });
});
