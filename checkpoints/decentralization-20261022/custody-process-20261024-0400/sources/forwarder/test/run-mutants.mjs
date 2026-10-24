// Mutation check: each mutant is forwarder.mjs with one guard weakened (exact text substitutions, each asserted to apply).
// The full suite runs against every mutant through FORWARDER_MODULE; a mutant that still passes is a SURVIVOR and fails this
// run. The unmutated module runs first as the control and must pass.
//   node test/run-mutants.mjs [name ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'forwarder.mjs'), 'utf8');
const MUTANTS = {
  'implicit-origin': [["const mount=c.mount??'prefix';","const mount=c.mount??'origin';"]],
  'origin-prefix-not-empty': [["if(c.prefix!=='')throw new Error('origin mount requires an explicitly empty prefix');",""]],
  'unsafe-wildcard': [["return ROUTES.has(route) && ROUTES.get(route) === method ? route : null;", "return route.startsWith('/v2/custody/') ? route : null;"],
                      ["const method = ROUTES.get(route);", "const method = req.method;"]],
  'case-insensitive': [["if (typeof target !== 'string' || !target.startsWith(prefix + '/')) return null;", "if (typeof target !== 'string' || !target.toLowerCase().startsWith(prefix + '/')) return null;"],
                       ["const route = target.slice(prefix.length);", "const route = target.slice(prefix.length).toLowerCase();"]],
  'percent-decode': [["const route = target.slice(prefix.length);", "const route = decodeURIComponent(target.slice(prefix.length));"]],
  'whatwg-normalize': [["const route = target.slice(prefix.length);", "const route = new URL(target.slice(prefix.length), 'http://x').pathname;"]],
  'ignore-query': [["const route = target.slice(prefix.length);", "const route = target.slice(prefix.length).split('?')[0];"]],
  'strip-trailing-slash': [["const route = target.slice(prefix.length);", "const route = target.slice(prefix.length).replace(/\\/+$/, '');"]],
  'method-agnostic': [["ROUTES.get(route) === method ? route : null;", "true ? route : null;"], ["const method = ROUTES.get(route);", "const method = req.method;"]],
  'forward-client-headers': [["headers: { host: `127.0.0.1:${c.upstreamPort}`,", "headers: { ...req.headers, host: `127.0.0.1:${c.upstreamPort}`,"]],
  'pass-upstream-headers': [["send(res, result.status, result.body, retry);", "send(res, result.status, result.body, { ...retry, 'set-cookie': 'x=1' });"]],
  'no-declared-size-check': [["Number(declared) <= c.maxBodyBytes)) { done(413", "true)) { done(413"]],
  'no-streamed-size-cap': [["if (n > c.maxBodyBytes) return finish('too_large');", ""]],
  'no-body-deadline': [["setTimeout(() => finish('timeout'), c.bodyTimeoutMs)", "setTimeout(() => finish('timeout'), 1e9)"]],
  'get-body-allowed': [["if (method === 'GET' && (chunked", "if (false && (chunked"]],
  'no-upstream-deadline': [["setTimeout(() => end({ fail: 504 }), c.upstreamTimeoutMs)", "setTimeout(() => end({ fail: 504 }), 1e9)"]],
  'pass-redirects': [["if (!(s >= 200 && s < 300) && !(s >= 400 && s < 600))", "if (!(s >= 200 && s < 400) && !(s >= 400 && s < 600))"]],
  'no-json-check': [["if (!/^application\\/json(\\s*;|$)/i.test(type))", "if (false)"]],
  'no-response-cap': [["if (declaredUp !== undefined && !(Number(declaredUp) <= c.maxResponseBytes))", "if (false)"],
                      ["if (n > c.maxResponseBytes) return end({ fail: 502 });", ""]],
  'accept-truncated': [["if (r.complete) end({", "if (true) end({"], ["r.once('aborted', () => end({ fail: 502 }));", ""], ["r.once('error', () => end({ fail: 502 }));", "r.once('error', () => end({ status: 200, body: Buffer.from('{}') }));"]],
  'no-abort-on-client-gone': [["const onGone = () => { if (!res.writableEnded) ac.abort(); };", "const onGone = () => {};"]],
  'no-gone-check-before-upstream': [["if (ac.signal.aborted || res.destroyed || req.socket?.destroyed) { done(499, 'client_gone'); return; }", ""],
                                    ["      if (ac.signal.aborted) return end({ gone: true });   // aborted before the listener existed: it would never fire\n", ""]],
  'no-in-flight-limit': [["if (stats.inFlight > c.maxInFlight)", "if (false)"]],
  'non-loopback-listen': [["if (!LOOPBACK.has(l.host))", "if (false)"]],
  'prefix-under-relay-tunnels': [["c.prefix.startsWith('/t/') || ", ""]],
  'no-upgrade-guard': [["server.on('upgrade', (_req, socket) => socket.destroy());", ""], ["server.on('connect', (_req, socket) => socket.destroy());", ""]],
  'expect-continue-before-checks': [["server.on('checkContinue', (req, res) => {", "server.on('checkContinue', (req, res) => { res.writeContinue();"]],
};
function mutate(name) {
  let s = SRC;
  for (const [a, b] of MUTANTS[name]) { if (!s.includes(a)) throw new Error(`${name}: substitution does not apply: ${a}`); s = s.replace(a, b); }
  return s;
}
function runSuite(file) {
  const r = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-timeout=30000', '--test-concurrency=1', 'test/allowlist.test.mjs', 'test/forwarder.test.mjs', 'test/origin.test.mjs'],
                      { cwd: ROOT, env: { ...process.env, FORWARDER_MODULE: file }, encoding: 'utf8', timeout: 180000 });
  const failed = [...(r.stdout || '').matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, signal: r.signal, failed, assertion: /ERR_ASSERTION/.test(r.stdout || ''), timedOut: Boolean(r.error) || /test timed out/.test(r.stdout || '') };
}
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MUTANTS);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-mutants-'));
const control = runSuite(path.join(ROOT, 'forwarder.mjs'));
console.log(`control (unmutated): exit ${control.code}${control.failed.length ? ' FAILED ' + control.failed.join(' | ') : ''}`);
let survivors = 0;
for (const n of names) {
  const f = path.join(tmp, `${n}.mjs`); fs.writeFileSync(f, mutate(n));
  const r = runSuite(f);
  const killed = r.code === 1 && !r.signal && !r.timedOut && r.failed.length > 0 && r.assertion;
  if (!killed) survivors++;
  console.log(`${killed ? 'KILLED  ' : 'NOT PROVEN'} ${n}: exit ${r.code}${r.signal ? ' ' + r.signal : ''}; failing tests: ${r.failed.join(' | ') || '-'}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`mutants ${names.length}, killed ${names.length - survivors}, survived ${survivors}; control ${control.code === 0 ? 'passed' : 'FAILED'}`);
process.exit(control.code === 0 && survivors === 0 ? 0 : 1);
