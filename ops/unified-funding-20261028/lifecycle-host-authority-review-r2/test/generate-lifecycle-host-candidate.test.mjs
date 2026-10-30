// The strict source-hash patch generator against the REAL pinned baseline host.mjs (read only).
import { BASELINE_HOST, GENERATOR_URL } from './helpers/baseline.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const G = await import(GENERATOR_URL);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const baseline = fs.readFileSync(BASELINE_HOST, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

test('the generator input is the pinned baseline', () => {
  assert.equal(G.BASELINE_HOST_SHA256, '8f0b92bb7b3eb0662d706ab0da0f80b07ec4621f78105384c59a907b89d469c7');
  assert.equal(sha(baseline), G.BASELINE_HOST_SHA256);
});

test('insertions only: removing them restores every baseline byte; each guard sits before its legacy effect', () => {
  const r = G.generateHostCandidate(baseline);
  assert.deepEqual(r.manifest.map((m) => m.name).sort(), G.EDITS.map((e) => e.name).sort());
  assert.equal(G.EDITS.length, 18);
  let restored = '', from = 0;
  for (const m of r.manifest) { restored += r.source.slice(from, m.candidateOffset); from = m.candidateOffset + m.length; }
  restored += r.source.slice(from);
  assert.equal(restored, baseline);
  assert.equal(r.source.length, baseline.length + G.EDITS.reduce((n, e) => n + e.text.length, 0));
  for (const e of G.EDITS) assert.equal(count(r.source, e.text), 1, e.name);
  for (const [header, guard, effect] of [
    ['  async consider(id, { force = false, invited = false } = {}) {', '#lifecycleOwns(id)', 'chain.claimDeployment('],
    ['  async scanLedger() {', '#lifecycleOwns(id)', 'this.consider(id)'],
    ['  renewDue() {', '#lifecycleOwns(id)', 'this.#renewKeep(id)'],
    ['  async #renewSend(id, d, permit) {', '#lifecycleOwns(id)', 'chain.renewDeployment('],
    ['  async #reconcileTracked(id, { deferClaim = false } = {}) {', '#lifecycleOwns(id)', 'chain.readDeployment(id)'],
    ['  #giveUp(id, why, opts = {}) {', 'this.lifecycle.restrict(id, why)', 'this.#giveUpOnce('],
    ['  async #stopApp(id, why) {', '#lifecycleOwns(id)', 'this.#retireIsolated(id, why)'],
    ['  async proveAll() {', '#lifecycleOwns(id)', 'checkpointBatch)(due)'],
    ['  async restart(id, d) {', '#lifecycleOwns(id)', 'this.ensureApp(id, d, { force: true })'],
    ['  async ensureApp(id, d, { force = false, version = null } = {}) {', '#lifecycleOwns(id)', 'this.#walletPolicyState('],
    ['  async retireForeignRecovered(client = null) {', '#lifecycleOwns(owner)', 'client.remove(v.id)'],
    ['  async proxy(id, { method, pathRest, headers, body, ip = null, target = null }) {', 'this.lifecycle.ingressRefusal(key)', 'this.platformPolicy.serviceRefusal()'],
  ]) {
    const h = r.source.indexOf(header);
    assert.ok(h >= 0, header);
    const g = r.source.indexOf(guard, h), x = r.source.indexOf(effect, h);
    assert.ok(g > h && x > g, `${header.trim()}: guard before ${effect}`);
  }
  // the platform ingress check is kept, byte for byte, for every unrouted app and skipped only for a routed id
  assert.equal(count(r.source, 'if (!this.#lifecycleOwns(key)) { const pr = this.platformPolicy.serviceRefusal();'), 1);
  // the host view hands the platform gate over as data, never as an unconditional restriction of a routed app
  const view = G.EDITS.find((e) => e.name === 'constructor').text;
  assert.ok(!/serviceRestriction|newWorkRestriction/.test(view));
  assert.match(view, /ownerRestriction: \(\) => \(this\.caps\.paused === true/);
  assert.match(view, /platformService: \(\) => this\.platformPolicy\.serviceRefusal\(\),/);
  assert.match(view, /platformNewWork: \(\) => this\.platformPolicy\.newWorkRefusal\(\),/);
  assert.match(view, /capacity: \(id\) =>/);
  assert.ok(!/process\.env\.\w*LIFECYCLE/i.test(r.source), 'no environment flag selects routes');
  assert.match(r.source, /cfg\.lifecycleDispatch \?\? null/);
  assert.equal(sha(baseline), G.BASELINE_HOST_SHA256, 'the input string is unchanged');
});

test('refuses a changed baseline hash', () => {
  assert.throws(() => G.generateHostCandidate(baseline + ' '), /not the pinned/);
  assert.throws(() => G.generateHostCandidate(baseline.replace('TICK_MS = 30_000', 'TICK_MS = 30_001')), /not the pinned/);
});

test('refuses missing, duplicate and overlapping anchors, duplicate edit names and double application', () => {
  const restart = G.EDITS.find((e) => e.name === 'restart');
  const cases = [
    [[{ name: 'x', before: 'NO SUCH ANCHOR\n', after: 'X', text: '// y\n' }], /missing/],
    [[{ name: 'x', before: '  }\n', after: '  /**', text: '// y\n' }], /duplicated/],
    [[restart, { name: 'r2', before: '    id = String(id).toLowerCase();\n', after: '    const refuse = this.restartRefusal(id, d);', text: '// q\n' }], /overlap/],
    [[restart, restart], /duplicate/],
    [[{ name: 'x', before: 'import fs from "node:fs";\n', after: 'import crypto', text: '' }], /incomplete/],
  ];
  for (const [edits, err] of cases) assert.throws(() => G.generateHostCandidate(baseline, { edits }), err);
  const once = G.generateHostCandidate(baseline).source;
  assert.throws(() => G.generateHostCandidate(once, { expectedSha256: sha(once) }), /already carries/);
});

test('writes a separate candidate: never into the baseline directory, never over an existing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-gen-'));
  try {
    const out = path.join(dir, 'host.lifecycle-candidate.mjs');
    const r = G.writeHostCandidate(BASELINE_HOST, out);
    assert.equal(sha(fs.readFileSync(out, 'utf8')), r.sha256);
    assert.throws(() => G.writeHostCandidate(BASELINE_HOST, out), /EEXIST/);
    assert.throws(() => G.writeHostCandidate(BASELINE_HOST, path.join(path.dirname(BASELINE_HOST), 'host.lifecycle-candidate.mjs')), /outside the baseline/);
    assert.throws(() => G.writeHostCandidate('relative/host.mjs', out), /absolute/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(sha(fs.readFileSync(BASELINE_HOST, 'utf8')), G.BASELINE_HOST_SHA256);
});
