// The runtime identity, on the VERIFIER side (ABI/2, isolation/contract/RUNTIME.md).
//
// The app is distributed as one portable WebAssembly component and compiled INSIDE the domain, so a
// report that names only the bundle under-describes what is running: the same component compiled by a
// different runtime version, for a different ISA, under a different CPU-feature policy, or interpreted
// rather than JIT-compiled, is different code. ABI/2 folds the runtime identity into report_data[0:32];
// these cases pin that a verifier
//
//   - computes the SAME identity digest and binding as the Go domain and the Rust launcher (the vectors),
//   - refuses an identity the contract calls inadmissible instead of downgrading it,
//   - refuses a silent drop to ABI/1 when a runtime was expected,
//   - refuses a runtime self-test that does not substantiate W^X or the execution mode,
//   - and ends up with a DIFFERENT expected binding whenever any of that changes, which is what makes a
//     document naming another runtime than the one that asked for the report fail to verify.
//
//   run: node --test test/isolation-runtime-identity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { checkRuntime, checkRuntimeSelfTest, judge } from '../isolation/m2/judge.mjs';
import { ABI1, ABI2, bind1, bind2, cacheKey, canonical, runtimeId, validateRuntimeIdentity }
  from '../isolation/contract/runtime.mjs';

const V = JSON.parse(fs.readFileSync(new URL('../isolation/contract/vectors.json', import.meta.url), 'utf8'));
const SPKI = randomBytes(91), NONCE = randomBytes(32);
const JIT = { name: 'wasmtime', version: '48.0.1', execution: 'jit', targetIsa: 'x86_64',
  hostIsa: 'x86_64', cpuFeatures: 'baseline', wx: 'enforced', cache: 'none' };
const PULLEY = { ...JIT, execution: 'interpreter', targetIsa: 'pulley64', hostIsa: 'aarch64' };
const ST = 'exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 scope=cgroup:/dom1';
const doc2 = (over = {}) => ({ abi: ABI2, runtime: JIT, runtimeSelfTest: ST, ...over });

// 1. CROSS-LANGUAGE CONFORMANCE. The vectors are produced by the Go implementation and passed by the
// Rust launcher; if this verifier disagreed by a byte, every honest domain would look like a liar.
test('the verifier computes the same identity digests, bindings and cache keys as the contract', () => {
  const spki = Buffer.from(V.bind[0].spki_hex, 'hex');
  const nonce = Buffer.from(V.bind[0].nonce_hex, 'hex');
  const appId = Buffer.from(V.bundles[0].app_id, 'hex');
  assert.ok(V.runtime.length >= 12, 'the runtime vectors are missing');
  let valid = 0, refused = 0;
  for (const v of V.runtime) {
    const why = validateRuntimeIdentity(v.identity);
    assert.equal(why === null, v.valid, `${JSON.stringify(v.identity)}: ${why ?? 'accepted'}`);
    if (!v.valid) { refused++; continue; }
    valid++;
    const rid = runtimeId(v.identity);
    assert.equal(rid.toString('hex'), v.runtime_id, 'runtime id');
    assert.equal(bind2(spki, nonce, rid).toString('hex'), v.bind2, 'bind2');
    assert.equal(cacheKey(appId, rid).toString('hex'), v.cache_key, 'cache key');
  }
  assert.ok(valid >= 5 && refused >= 7, `${valid} admissible / ${refused} refused vectors exercised`);
});

test('canonical JSON sorts keys at every level, so field order cannot change an identity', () => {
  const shuffled = Object.fromEntries(Object.keys(JIT).reverse().map((k) => [k, JIT[k]]));
  assert.equal(canonical(shuffled).toString(), canonical(JIT).toString());
  assert.deepEqual(runtimeId(shuffled), runtimeId(JIT));
});

// 2. THE BINDING CHANGES WITH THE RUNTIME. This is the property the whole ABI rests on.
test('every field of the identity changes the binding, and ABI/2 never collides with ABI/1', () => {
  const base = checkRuntime(doc2(), SPKI, NONCE, {});
  assert.equal(base.ok, true, base.reasons.join('; '));
  assert.notEqual(base.binding, null, 'an ABI/2 document must pin an explicit binding');
  assert.notEqual(base.binding.toString('hex'), bind1(SPKI, NONCE).toString('hex'),
    'an ABI/2 binding must not equal the ABI/1 binding for the same key and nonce');
  const seen = new Set([base.binding.toString('hex')]);
  for (const [k, v] of [['name', 'wasmer'], ['version', '49.0.0'], ['cpuFeatures', '+avx2'],
    ['cache', 'authenticated']]) {
    const r = checkRuntime(doc2({ runtime: { ...JIT, [k]: v } }), SPKI, NONCE, {});
    assert.equal(r.ok, true, `${k}: ${r.reasons.join('; ')}`);
    assert.ok(!seen.has(r.binding.toString('hex')), `changing ${k} must change the binding`);
    seen.add(r.binding.toString('hex'));
  }
  // and the execution mode: a Pulley interpreter is not the same thing as a JIT
  const p = checkRuntime({ abi: ABI2, runtime: PULLEY, runtimeSelfTest: 'exec_pages=refused:EACCES wx=clean maps=2 runtime=1 root=1 scope=all-processes' }, SPKI, NONCE, {});
  assert.equal(p.ok, true, p.reasons.join('; '));
  assert.ok(!seen.has(p.binding.toString('hex')), 'the execution mode must change the binding');
});

// 3. INADMISSIBLE IDENTITIES ARE REFUSED, NOT DOWNGRADED.
test('every identity the contract refuses is refused here too, with no binding produced', () => {
  for (const v of V.runtime.filter((x) => !x.valid)) {
    const r = checkRuntime(doc2({ runtime: v.identity }), SPKI, NONCE, {});
    assert.equal(r.ok, false, `${JSON.stringify(v.identity)} was accepted`);
    assert.equal(r.binding, undefined, 'a refused identity must not yield a binding');
    assert.match(r.reasons.join(' '), /not admissible/);
  }
  // an extra field is a different identity than the one we would hash, so it is refused too
  assert.equal(checkRuntime(doc2({ runtime: { ...JIT, extra: 'x' } }), SPKI, NONCE, {}).ok, false);
  for (const junk of [null, undefined, 'wasmtime', 42, []]) {
    assert.equal(checkRuntime(doc2({ runtime: junk }), SPKI, NONCE, {}).ok, false, `${JSON.stringify(junk)} was accepted`);
  }
});

// 4. NO SILENT DOWNGRADE.
test('a caller that expects a runtime refuses a document that binds none', () => {
  const r = checkRuntime({ abi: ABI1 }, SPKI, NONCE, { runtime: JIT });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /silent downgrade/);
  // no abi field at all is ABI/1, and refused for the same reason
  assert.equal(checkRuntime({}, SPKI, NONCE, { runtime: JIT }).ok, false);
});

test('an ABI this verifier does not implement is a reject, never a fall-back', () => {
  for (const abi of ['enclave-domain-abi/3', 'enclave-domain-abi/0', '', 'abi/2']) {
    const r = checkRuntime({ abi, runtime: JIT, runtimeSelfTest: ST }, SPKI, NONCE, {});
    assert.equal(r.ok, false, `${JSON.stringify(abi)} was accepted`);
  }
});

test('an ABI/1 document carrying runtime fields is refused as unauthenticated decoration', () => {
  const r = checkRuntime({ abi: ABI1, runtime: JIT, runtimeSelfTest: ST }, SPKI, NONCE, {});
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /does not cover them/);
  // the plain ABI/1 document still passes, with the runtime explicitly unbound
  const ok = checkRuntime({ abi: ABI1 }, SPKI, NONCE, {});
  assert.equal(ok.ok, true, ok.reasons.join('; '));
  // null, not a computed value: ABI/1 leaves verifyQuote to bind exactly as it did before ABI/2 existed
  assert.equal(ok.binding, null);
  assert.match(ok.reasons.join(' '), /nothing here says what compiled this app/);
});

test('want.runtime pins the identity field for field and names what differed', () => {
  const same = checkRuntime(doc2(), SPKI, NONCE, { runtime: JIT });
  assert.equal(same.ok, true, same.reasons.join('; '));
  for (const k of Object.keys(JIT)) {
    const other = { ...JIT, [k]: k === 'execution' ? 'interpreter' : `${JIT[k]}-other` };
    const r = checkRuntime(doc2({ runtime: other }), SPKI, NONCE, { runtime: JIT });
    assert.equal(r.ok, false, `a document differing in ${k} was accepted`);
  }
  // unpinned is allowed but must SAY it is unpinned
  assert.match(checkRuntime(doc2(), SPKI, NONCE, {}).reasons.join(' '), /UNPINNED/);
});

// 5. THE SELF-TEST HAS TO SUBSTANTIATE THE CLAIM.
test('the runtime self-test is required and must record a clean W^X scan', () => {
  for (const st of [undefined, null, '', 42, 'x'.repeat(301)]) {
    assert.equal(checkRuntimeSelfTest(st, JIT).ok, false, `${JSON.stringify(st)} was accepted`);
  }
  for (const st of [
    'wx=clean maps=3 scope=all-processes',                                  // no exec_pages
    'exec_pages=allowed maps=3 scope=all-processes',                        // no wx
    'exec_pages=allowed wx=clean scope=all-processes',                      // no maps
    'exec_pages=allowed wx=clean maps=3',                                   // no scope
    'exec_pages=allowed wx=clean wx=clean maps=3 scope=all-processes',      // duplicate
    'exec_pages=allowed wx maps=3 scope=all-processes',                     // malformed
    'exec_pages=allowed wx=dirty maps=3 scope=all-processes',               // W^X violated
    'exec_pages=allowed wx=unknown maps=3 scope=all-processes',
    'exec_pages=allowed wx=clean maps=0 scope=all-processes',               // saw nothing
    'exec_pages=allowed wx=clean maps=-1 scope=all-processes',
    'exec_pages=allowed wx=clean maps=many scope=all-processes',
  ]) {
    assert.equal(checkRuntimeSelfTest(st, JIT).ok, false, `${JSON.stringify(st)} was accepted`);
  }
  assert.equal(checkRuntimeSelfTest(ST, JIT).ok, true);
});

// 5b. ...AND IT HAS TO HAVE SEEN THE RUNTIME (enclave-b4's finding, enclave-87's ruling): the SNP front used to scan once
// at its own start, before the app existed, and the NucBox front can no longer read the runtime at all. So the self-test
// is made for each document and names its coverage by role, and where the runtime is a separate process a document that
// covered no runtime is REJECTED, never read as clean.
test('the runtime self-test must have covered the runtime, by role, and the roles must add up', () => {
  for (const st of [
    'exec_pages=allowed wx=clean maps=3 scope=all-processes',                              // no coverage by role: a start-time scan
    'exec_pages=allowed wx=clean maps=3 scope=cgroup:/dom1',
    'exec_pages=allowed wx=clean maps=2 runtime=0 root=2 scope=all-processes',             // covered no runtime
    'exec_pages=allowed wx=clean maps=2 runtime=0 front=1 init=1 scope=cgroup:/dom1',
    'exec_pages=allowed wx=clean maps=3 runtime=1 root=1 scope=all-processes',             // roles do not add up
    'exec_pages=allowed wx=clean maps=3 runtime=x root=2 scope=all-processes',             // not a count
    'exec_pages=allowed wx=clean maps=3 runtime=-1 root=4 scope=all-processes',
    'exec_pages=allowed wx=unmeasured maps=0 scope=monitor',                                // the monitor did not measure
  ]) {
    assert.equal(checkRuntimeSelfTest(st, JIT).ok, false, `${JSON.stringify(st)} was accepted`);
  }
  for (const st of [
    'exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 scope=cgroup:/dom1',      // the NucBox monitor's scan
    'exec_pages=allowed wx=clean maps=3 runtime=1 root=2 scope=all-processes',             // the SNP front's own
    'exec_pages=allowed wx=clean maps=1 scope=self',                                        // library-embedded runtime (pVM)
  ]) {
    const r = checkRuntimeSelfTest(st, JIT);
    assert.equal(r.ok, true, `${st}: ${r.reasons.join('; ')}`);
  }
  assert.match(checkRuntimeSelfTest('exec_pages=allowed wx=clean maps=2 runtime=0 root=2 scope=all-processes', JIT).reasons.join(' '), /covered NO runtime process/);
});

test('the scan scope is a closed vocabulary, so a domain cannot invent one that reads broad', () => {
  // each admissible scope, with what it claims
  const ok = [
    ['exec_pages=allowed wx=clean maps=3 runtime=1 root=2 scope=all-processes', /every process with an address space/],
    ['exec_pages=allowed wx=clean maps=2 runtime=1 front=1 scope=cgroup:/dom7', /own cgroup \/dom7 \(2 processes: runtime=1, front=1\), and no neighbour/],
    ['exec_pages=allowed wx=clean maps=1 scope=self', /reporting process ALONE/],
  ];
  for (const [st, re] of ok) {
    const r = checkRuntimeSelfTest(st, JIT);
    assert.equal(r.ok, true, `${st}: ${r.reasons.join('; ')}`);
    assert.match(r.reasons.join(' '), re);
  }
  // scope=self must say it is incomplete for a separate runtime process, since nothing attests which it is
  assert.match(checkRuntimeSelfTest('exec_pages=allowed wx=clean maps=1 scope=self', JIT).reasons.join(' '),
    /separate runtime process would be unscanned/);
  // and anything else is refused, however broad it reads
  for (const st of [
    'exec_pages=allowed wx=clean maps=3 scope=everything',
    'exec_pages=allowed wx=clean maps=3 scope=all',
    'exec_pages=allowed wx=clean maps=3 scope=vm',
    'exec_pages=allowed wx=clean maps=3 scope=cgroup:',       // no path
    'exec_pages=allowed wx=clean maps=3 scope=cgroup:dom1',   // not absolute
    'exec_pages=allowed wx=clean maps=3 scope=',
    'exec_pages=allowed wx=clean maps=3 scope=self-and-friends',
  ]) {
    assert.equal(checkRuntimeSelfTest(st, JIT).ok, false, `${JSON.stringify(st)} was accepted`);
  }
  // scope=self claiming to have scanned more than the one process it can see is refused
  assert.equal(checkRuntimeSelfTest('exec_pages=allowed wx=clean maps=9 scope=self', JIT).ok, false);
});

test('a JIT identity from a domain that may not hold an executable page is refused', () => {
  const st = 'exec_pages=refused:EACCES wx=clean maps=3 runtime=1 front=1 init=1 scope=cgroup:/dom1';
  const r = checkRuntimeSelfTest(st, JIT);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /no JIT can run where an executable page is refused/);
  // the same domain stating the interpreter is coherent: that is the Pixel pVM and VBS-enclave case
  assert.equal(checkRuntimeSelfTest(st, PULLEY).ok, true);
});

test('the self-test says out loud that it is measured code\'s own word, not a hardware fact', () => {
  assert.match(checkRuntimeSelfTest(ST, JIT).reasons.join(' '), /hardware does not attest it/);
});

// 6. END TO END THROUGH judge(), so the binding reaches the report check.
const MEAS = '44'.repeat(48), APP = '55'.repeat(32);
function report(binding) {
  const r = Buffer.alloc(0x4a0);
  r.writeUInt32LE(5, 0x00);
  r.writeBigUInt64LE(0x30000n, 0x08);
  binding.copy(r, 0x50);
  Buffer.from(APP, 'hex').copy(r, 0x70);
  Buffer.from(MEAS, 'hex').copy(r, 0x90);
  r[0x188] = 0x1a; r[0x189] = 0x02;
  Buffer.from('0103020500000075', 'hex').copy(r, 0x180);
  return r;
}
const want = { measurement: MEAS, appSha: APP, mode: 'lab-unsigned', kds: false };

test('an ABI/2 document verifies only against the report that bound ITS runtime identity', async () => {
  const rid = runtimeId(JIT);
  const good = report(bind2(SPKI, NONCE, rid));
  const v = await judge(doc2({ format: 'sev-snp-guest-domain-v1', report: good.toString('base64') }),
    SPKI, NONCE, want);
  assert.equal(v.verdict, 'unauthenticated', v.reasons.join('; ')); // lab mode: no AMD chain here
  assert.equal(v.abi, ABI2);
  assert.match(v.reasons.join(' '), /report_data binds the caller's expected binding/);

  // the SAME report, presented with a document naming a different runtime version: the binding no
  // longer matches, which is the whole point of ABI/2
  const lie = await judge(doc2({ runtime: { ...JIT, version: '49.0.0' }, format: 'sev-snp-guest-domain-v1',
    report: good.toString('base64') }), SPKI, NONCE, want);
  assert.equal(lie.verdict, 'reject', lie.reasons.join('; '));
  assert.match(lie.reasons.join(' '), /does not bind/);

  // and an ABI/1 report cannot be replayed as an ABI/2 document
  const old = report(bind1(SPKI, NONCE));
  const replay = await judge(doc2({ format: 'sev-snp-guest-domain-v1', report: old.toString('base64') }),
    SPKI, NONCE, want);
  assert.equal(replay.verdict, 'reject', replay.reasons.join('; '));
});

test('an ABI/1 domain still verifies exactly as before', async () => {
  const r = report(bind1(SPKI, NONCE));
  const v = await judge({ abi: ABI1, format: 'sev-snp-guest-domain-v1', report: r.toString('base64') },
    SPKI, NONCE, want);
  assert.equal(v.verdict, 'unauthenticated', v.reasons.join('; '));
  assert.match(v.reasons.join(' '), /report_data binds transport key \+ fresh challenge/);
  // a document with no abi field at all is ABI/1, unchanged: nothing regresses for M2/M3/M4 today
  const legacy = await judge({ format: 'sev-snp-guest-domain-v1', report: r.toString('base64') },
    SPKI, NONCE, want);
  assert.equal(legacy.verdict, 'unauthenticated', legacy.reasons.join('; '));
});

test('a bad runtime identity is rejected in EVERY mode, including the lab diagnostic', async () => {
  const rid = runtimeId(JIT);
  const r = report(bind2(SPKI, NONCE, rid));
  for (const mode of ['trusted', 'lab-unsigned']) {
    const v = await judge(doc2({ runtime: { ...JIT, wx: 'best-effort' }, format: 'sev-snp-guest-domain-v1',
      report: r.toString('base64') }), SPKI, NONCE, { ...want, mode });
    assert.equal(v.verdict, 'reject', `${mode}: ${v.reasons.join('; ')}`);
    assert.equal(v.gateOpen, false);
  }
});
