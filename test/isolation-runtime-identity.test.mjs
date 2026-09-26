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
import { checkRuntime, checkRuntimeSelfTest, judge, legacyWxFor, LEGACY_WX_RELEASES } from '../isolation/m2/judge.mjs';
import { ABI1, ABI2, bind1, bind2, cacheKey, canonical, runtimeId, validateRuntimeIdentity }
  from '../isolation/contract/runtime.mjs';

const V = JSON.parse(fs.readFileSync(new URL('../isolation/contract/vectors.json', import.meta.url), 'utf8'));
const SPKI = randomBytes(91), NONCE = randomBytes(32);
const JIT = { name: 'wasmtime', version: '48.0.1', execution: 'jit', targetIsa: 'x86_64',
  hostIsa: 'x86_64', cpuFeatures: 'baseline', wx: 'enforced', cache: 'none' };
const PULLEY = { ...JIT, execution: 'interpreter', targetIsa: 'pulley64', hostIsa: 'aarch64' };
// every current document states the runtime's filter (judge.mjs SECCOMP_UNSTATED_RELEASES)
const SC = 'seccomp=' + 'd4'.repeat(32);
const ST = `exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 ${SC} scope=cgroup:/dom1`;
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
  const p = checkRuntime({ abi: ABI2, runtime: PULLEY, runtimeSelfTest: `exec_pages=refused:EACCES wx=clean maps=2 runtime=1 root=1 ${SC} scope=all-processes` }, SPKI, NONCE, {});
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
    `exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 ${SC} scope=cgroup:/dom1`,      // the NucBox monitor's scan
    `exec_pages=allowed wx=clean maps=3 runtime=1 root=2 ${SC} scope=all-processes`,             // the SNP front's own
    'exec_pages=allowed wx=clean maps=1 scope=self',                                        // library-embedded runtime (pVM)
  ]) {
    const r = checkRuntimeSelfTest(st, JIT, st.includes('scope=self') ? { allowSelfScope: true } : {});   // the pVM's verifier opts in
    assert.equal(r.ok, true, `${st}: ${r.reasons.join('; ')}`);
  }
  assert.match(checkRuntimeSelfTest('exec_pages=allowed wx=clean maps=2 runtime=0 root=2 scope=all-processes', JIT).reasons.join(' '), /covered NO runtime process/);
});

test('the scan scope is a closed vocabulary, so a domain cannot invent one that reads broad', () => {
  // each admissible scope, with what it claims
  const ok = [
    [`exec_pages=allowed wx=clean maps=3 runtime=1 root=2 ${SC} scope=all-processes`, /every process with an address space/],
    [`exec_pages=allowed wx=clean maps=2 runtime=1 front=1 ${SC} scope=cgroup:/dom7`, /own cgroup \/dom7 \(2 processes: runtime=1, front=1\), and no neighbour/],
    ['exec_pages=allowed wx=clean maps=1 scope=self', /reporting process ALONE/],
  ];
  for (const [st, re] of ok) {
    const r = checkRuntimeSelfTest(st, JIT, st.includes('scope=self') ? { allowSelfScope: true } : {});
    assert.equal(r.ok, true, `${st}: ${r.reasons.join('; ')}`);
    assert.match(r.reasons.join(' '), re);
  }
  // scope=self must say it is incomplete for a separate runtime process, since nothing attests which it is
  assert.match(checkRuntimeSelfTest('exec_pages=allowed wx=clean maps=1 scope=self', JIT, { allowSelfScope: true }).reasons.join(' '),
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
  assert.equal(checkRuntimeSelfTest('exec_pages=allowed wx=clean maps=9 scope=self', JIT, { allowSelfScope: true }).ok, false);
});

test('a JIT identity from a domain that may not hold an executable page is refused', () => {
  const st = `exec_pages=refused:EACCES wx=clean maps=3 runtime=1 front=1 init=1 ${SC} scope=cgroup:/dom1`;
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

// 4. PER RELEASE, NO FLAG DAY (enclave-87's ruling). A release built before the attest-time scan states the LEGACY form;
// it is accepted only for a release the CALLER names that the judge lists, and then as runtime W^X UNMEASURED.
const LEGACY_ST = 'exec_pages=allowed wx=clean maps=3 scope=all-processes';
const L5C = '5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2';    // installed (the legacy tree), pre-chain
const L6F = '6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb';    // installed (the legacy tree), pre-chain
const F7 = 'f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca';     // admitted by rs-7, retired by rs-10
const RETIRED = '52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1'; // retired by rs-8
const NEW = '11'.repeat(32);                                                        // a release built from this chain
const docWith = (st) => doc2({ runtimeSelfTest: st, format: 'sev-snp-guest-domain-v1',
  report: report(bind2(SPKI, NONCE, runtimeId(JIT))).toString('base64') });

test('the legacy self-test is accepted ONLY for a listed release the caller names, and only as UNMEASURED', async () => {
  for (const release of [L5C, [L5C], [L5C, L6F], L5C.toUpperCase()]) {
    const v = await judge(docWith(LEGACY_ST), SPKI, NONCE, { ...want, release });
    assert.equal(v.verdict, 'unauthenticated', `${JSON.stringify(release)}: ${v.reasons.join('; ')}`);
    assert.equal(v.wxCoverage, 'runtime-unmeasured');
    assert.match(v.reasons.join(' '), /LEGACY runtime self-test.*covered NO runtime process - W\^X of the runtime is UNMEASURED here, not clean/);
    assert.doesNotMatch(v.reasons.join(' '), /the scan covered every process/);
  }
  // a release this chain built, a RETIRED one (f7888d86 since rs-10), one of each, or none named: the legacy form is refused
  for (const release of [NEW, RETIRED, F7, [L5C, NEW], [L5C, F7], undefined, []]) {
    const v = await judge(docWith(LEGACY_ST), SPKI, NONCE, { ...want, release });
    assert.equal(v.verdict, 'reject', `${JSON.stringify(release)} accepted the legacy form: ${v.reasons.join('; ')}`);
    assert.match(v.reasons.join(' '), /does not say how many runtime processes it covered/);
  }
  // a malformed name is the caller's fault, refused - never read as "none named"
  for (const release of ['5c3561f9', `${L5C}00`, [L5C, 'x'.repeat(64)]]) {
    const v = await judge(docWith(ST), SPKI, NONCE, { ...want, release });
    assert.equal(v.verdict, 'reject', JSON.stringify(release));
    assert.match(v.reasons.join(' '), /not a 64-hex release id/);
  }
  // the name counts only with the measurement pinned (it says what THAT measurement is an image of)
  assert.deepEqual(legacyWxFor(L5C, undefined), { ok: true, legacy: null });
  assert.deepEqual(legacyWxFor(L5C, 'ab'.repeat(20)), { ok: true, legacy: null });
  assert.equal(legacyWxFor(L5C, MEAS).legacy, LEGACY_WX_RELEASES[L5C]);
  assert.deepEqual(legacyWxFor(F7, MEAS), { ok: true, legacy: null }, 'f7888d86 is retired (rs-10): no legacy form');
});

test('the attest-time form is judged by the full rule whatever release is named', async () => {
  for (const release of [L5C, F7, NEW, undefined]) {
    const ok = await judge(docWith(ST), SPKI, NONCE, { ...want, release });
    assert.equal(ok.verdict, 'unauthenticated', `${release}: ${ok.reasons.join('; ')}`);
    assert.equal(ok.wxCoverage, 'runtime-covered');
    // a listed release never excuses a scan that covered no runtime, or a form that names roles but not the runtime
    for (const st of ['exec_pages=allowed wx=clean maps=2 runtime=0 root=2 scope=all-processes',
      'exec_pages=allowed wx=clean maps=3 root=3 scope=all-processes',
      'exec_pages=allowed wx=clean maps=1 runtime=0 front=1 scope=cgroup:/dom1']) {
      const v = await judge(docWith(st), SPKI, NONCE, { ...want, release });
      assert.equal(v.verdict, 'reject', `${release} ${st}: ${v.reasons.join('; ')}`);
    }
  }
});

test('the legacy table holds full ids of releases the relay can still predict, and no retired one', () => {
  assert.ok(Object.isFrozen(LEGACY_WX_RELEASES));
  const ids = Object.keys(LEGACY_WX_RELEASES);
  assert.ok(ids.length >= 1 && ids.every((x) => /^[0-9a-f]{64}$/.test(x)), ids.join(' '));
  for (const retired of [RETIRED, F7, '79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4',
    'a4f227482df4830ab69b52e38dc5d6e2abea9e5c5fb71f5469f0c30e6b1cb784']) {
    assert.ok(!ids.includes(retired), `retired release ${retired.slice(0, 8)} still admits the legacy form`);
  }
});

// 5. THE RUNTIME'S SECCOMP FILTER, PER RELEASE (SECCOMP_UNSTATED_RELEASES; enclave-87: positive evidence). A release after
// 5db18199 states seccomp=<its program's sha256>; one built before may state none only when the caller names it.
const NOSC = 'exec_pages=allowed wx=clean maps=3 runtime=1 root=2 scope=all-processes';          // 5db18199's front
const R5DB = '5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77';
test('a release after 5db18199 must state its seccomp filter; one before may omit it only when the caller names it', async () => {
  const with_ = await judge(docWith(`exec_pages=allowed wx=clean maps=3 runtime=1 root=2 ${SC} scope=all-processes`), SPKI, NONCE, { ...want, release: NEW });
  assert.equal(with_.verdict, 'unauthenticated', with_.reasons.join('; '));
  assert.match(with_.reasons.join(' '), /under the seccomp filter with program sha256 d4d4/);
  // enclave-87's mutant, the filter skipped: no statement, so no seccomp= - refused for a new release or none named
  for (const release of [NEW, undefined, [R5DB, NEW], F7, [R5DB, F7]]) {   // f7888d86: retired by rs-10, no exemption left
    const v = await judge(docWith(NOSC), SPKI, NONCE, { ...want, release });
    assert.equal(v.verdict, 'reject', `${JSON.stringify(release)} accepted a self-test with no filter`);
    assert.match(v.reasons.join(' '), /states no seccomp filter/);
  }
  // 5db18199 (and every release before it) may omit it, named by the caller - said, not counted as attested
  for (const release of [R5DB, L5C]) {
    const st = release === L5C ? LEGACY_ST : NOSC;
    const v = await judge(docWith(st), SPKI, NONCE, { ...want, release });
    assert.equal(v.verdict, 'unauthenticated', `${release}: ${v.reasons.join('; ')}`);
    assert.match(v.reasons.join(' '), /NOT positively attested/);
  }
  // a hash that is not one is refused whatever the release
  for (const bad of ['seccomp=d4d4', 'seccomp=' + 'D4'.repeat(32), 'seccomp=' + 'd4'.repeat(33)]) {
    assert.equal(checkRuntimeSelfTest(`exec_pages=allowed wx=clean maps=3 runtime=1 root=2 ${bad} scope=all-processes`, JIT,
      { seccompUnstated: 'x' }).ok, false, bad);
  }
  // the pVM's embedded runtime (scope=self, its verifier opting in) has no separate process to filter
  assert.equal(checkRuntimeSelfTest('exec_pages=allowed wx=clean maps=1 scope=self', JIT, { allowSelfScope: true }).ok, true);
});

test('the seccomp table is the W^X legacy table plus 5db18199, frozen', async () => {
  const { SECCOMP_UNSTATED_RELEASES } = await import('../isolation/m2/judge.mjs');
  assert.ok(Object.isFrozen(SECCOMP_UNSTATED_RELEASES));
  assert.deepEqual(Object.keys(SECCOMP_UNSTATED_RELEASES).sort(), [...Object.keys(LEGACY_WX_RELEASES), R5DB].sort());
});

// scope=self belongs to the pVM carrier ALONE (enclave-bf's B1, enclave-87: required). An SNP or NucBox document stating
// it would skip the runtime's coverage and its seccomp statement, so it is refused whatever the release is.
test('an SNP or hv document stating scope=self is refused, whatever the release; only the pVM verifier may accept it', async () => {
  for (const st of ['exec_pages=allowed wx=clean maps=1 scope=self', 'exec_pages=allowed wx=clean maps=1 root=1 scope=self',
    'exec_pages=allowed wx=clean maps=1 runtime=0 front=1 scope=self']) {
    for (const release of [NEW, F7, R5DB, undefined]) {
      const v = await judge(docWith(st), SPKI, NONCE, { ...want, release });
      assert.equal(v.verdict, 'reject', `${st} (${JSON.stringify(release)}) was accepted`);
      assert.match(v.reasons.join(' '), /only the pVM carrier/);
    }
    assert.equal(checkRuntimeSelfTest(st, JIT).ok, false, `${st}: a caller that did not opt in accepted scope=self`);
  }
});
