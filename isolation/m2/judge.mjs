// The M2 verdict: what a client may conclude from a domain's attestation document, and whether that
// conclusion opens the gate for application traffic. One function, shared by client.mjs and the
// negative tests, so the rule that is tested is the rule that runs.
//
// Verdicts:
//   attested         a T1 report whose AMD signature chain (VCEK -> ASK -> pinned ARK) VERIFIED, whose VCEK
//                    names this chip and TCB, whose reported TCB meets the caller's minimum-TCB policy, and
//                    whose policy, VMPL, measurement, key binding and app naming all check out
//   no-tcb-policy    all of that except the TCB: no minimum-TCB policy was supplied, so the platform's
//                    firmware level is unjudged. Authenticated, but not accepted
//   unauthenticated  the field checks pass but the AMD chain did NOT verify. Nothing authenticates those
//                    fields: a host could have written every one of them. Lab diagnostic only
//   not-attested     a T0 domain, which has no hardware report
//   reject           anything else
//
// Modes, and the only verdicts that open the gate in each:
//   trusted          (default) attested
//   lab-unsigned     attested, no-tcb-policy, unauthenticated   explicit lab-only diagnostic
//   t0-diagnostic    not-attested                               explicit; a T0 domain is never trusted
//
// want = { measurement, appSha, mode, minTcb?, vcek?, kds?, runtime?, hostData?, release? }
//   release the domain release(s) the CALLER knows the pinned measurement to be an image of - from its own trusted
//           knowledge (the relay prediction the measurement matched; the tree guestd built the guest from), NEVER from
//           the document. A string or an array of 64-hex ids. Only when EVERY named release is in LEGACY_WX_RELEASES,
//           and the measurement is pinned, may the document state the legacy runtime self-test (see below).
//   hostData the DEPLOYMENT the caller means to reach: the full 32-byte deployment id (hex, 0x optional). A per-app
//           guest is launched with it as SEV-SNP HOST_DATA (m2/run-domain.sh, m4/guestd), which the PSP signs into
//           every report and which is outside the launch measurement - so two instances of one app version share a
//           measurement and an AppID and differ here. Supplied, it must equal report.host_data byte for byte (an
//           all-zero expectation is refused: it names nothing). Omitted, host_data is unchecked and the reasons say
//           so. It does not stop a host from launching a second genuine instance under the same id.
//   runtime the runtime identity the caller expects the domain to state (isolation/contract/RUNTIME.md).
//           Supplying it pins the runtime field for field AND requires ABI/2, so a domain cannot silently
//           drop to a binding that covers no runtime. Omitting it accepts either ABI and says in the
//           reasons that the runtime is unpinned.
//   minTcb  the caller's floor, passed to relay/snp-verify.mjs checkMinTcb unchanged; nothing picks one here
//   vcek    a VCEK (DER) the caller already holds, used exactly like one in the report's certificate table:
//           it must sign the report, chain to AMD's pinned root and name this chip and TCB
//   kds     false: never contact AMD KDS (the VCEK and the chain must then be supplied)
//   expectedVmpl  the plane the report must come from, passed through to relay/snp-verify.mjs. Default 0.
//                 A domain running beneath a VMPL0 monitor reports its own level, and every level shares
//                 one launch measurement, so this field is what tells them apart.
//
//                 IT DOES NOT, ON ITS OWN, SHOW CONFINEMENT. A guest at VMPL0 holds every VMPCK, so it can
//                 request a signed report naming a LOWER privilege level than it has; a report reading
//                 VMPL2 is therefore consistent both with being confined beneath a VMPL0 monitor and with
//                 being VMPL0 and saying otherwise. What distinguishes them is being REFUSED a report at
//                 level 0, which a guest holding VMPCK0 cannot honestly claim. So whenever expectedVmpl is
//                 above 0 this judge additionally REQUIRES the monitor's boundary tuple (doc.boundary) to
//                 be coherent and to record that refusal, and rejects when it is absent, contradictory or
//                 disagrees with the signed report. See checkBoundary.
import { verifyQuote, parseSnpReport } from '../../relay/snp-verify.mjs';
import { ABI1, ABI2, EXEC_JIT, bind1, bind2, runtimeId, validateRuntimeIdentity } from '../contract/runtime.mjs';

export const MODES = ['trusted', 'lab-unsigned', 't0-diagnostic'];

// checkBoundary judges the monitor's boundary self-test, relayed in the attestation document over the
// connection whose key is bound into the report. `reportVmpl` is the level the PSP signed, so the tuple is
// also cross-checked against it: a relayed claim that disagrees with the signed field is a reject.
//
// Returns { ok, reasons }. The rules mirror boundaryFault in isolation/m3/monitor/main.go deliberately -
// the monitor refuses to serve on a fault, and a verifier must not accept what the monitor would refuse.
//
// What this is worth, CORRECTED 2026-09-23 after an independent review and two runs of our own: LESS than
// this file used to say, and on some paths nothing.
//
// The refusal does not test key absence. tsm-report refuses a privlevel below `privlevel_floor` in its own
// floor check, and the floor comes from `sev-guest`'s `vmpck_id` module parameter - the guest's command line -
// so no VMPCK is ever consulted. Measured on ONE image, on a plain SNP guest with no SVSM, therefore at
// VMPL0: with vmpck_id=0 it got a signed report naming vmpl=0 and level 0 was GRANTED (the control that
// proves it is unconfined); with vmpck_id=2 the same guest reported privlevel_floor=2 and level 0 was
// REFUSED with EINVAL. That is byte for byte the tuple below, produced by configuration alone.
//
// So this function cannot distinguish a confined guest from an unconfined one that sets a parameter, and it
// does not claim to. What it still does, and what is still worth doing: it rejects an INCOHERENT tuple -
// vmpl0=GRANTED, a probe that never ran, a claim that contradicts the signed report - which is a fault in
// measured code whatever the topology. Confinement itself is established by the MEASUREMENT the caller pins:
// on the IGVM path the digest covers the SVSM that holds VMPL0, and on the kernel-hashes path the command
// line and initrd are measured, so vmpck_id cannot be changed without changing that digest.
//
// The probe that WOULD test key absence is loading sev-guest with vmpck_id=0 and requiring it to FAIL, since
// a guest beneath a VMPL0 SVSM has no VMPCK0. That is isolation/DESIGN.md's replacement and is not yet wired.
export function checkBoundary(boundary, expectedVmpl, reportVmpl) {
  const reasons = [];
  const want = expectedVmpl ?? 0;
  if (boundary === undefined || boundary === null || boundary === '') {
    if (want === 0) return { ok: true, reasons: ['no boundary self-test in the document, and none is required at VMPL0: no confinement above the guest is claimed'] };
    return { ok: false, reasons: [`REJECT: the document carries no boundary self-test, so nothing shows this guest cannot reach VMPL0; a report naming VMPL${want} alone is consistent with a VMPL0 guest claiming a lower level`] };
  }
  if (typeof boundary !== 'string' || boundary.length > 200) return { ok: false, reasons: ['REJECT: the boundary self-test is not a short string'] };
  const f = {};
  for (const part of boundary.trim().split(/\s+/)) {
    const i = part.indexOf('=');
    if (i <= 0) return { ok: false, reasons: [`REJECT: malformed boundary self-test ${JSON.stringify(boundary)}`] };
    const k = part.slice(0, i);
    if (k in f) return { ok: false, reasons: [`REJECT: the boundary self-test names ${k} more than once: ${JSON.stringify(boundary)}`] };
    f[k] = part.slice(i + 1);
  }
  for (const k of ['tier', 'vmpl', 'vmpl_floor', 'vmpl0']) {
    if (!(k in f)) return { ok: false, reasons: [`REJECT: the boundary self-test is missing ${k}: ${JSON.stringify(boundary)}`] };
  }
  if (f.vmpl0 === 'GRANTED') return { ok: false, reasons: [`REJECT: the monitor obtained a report at VMPL0 (vmpl0=GRANTED), so nothing more privileged is above it, whatever level its report names`] };
  if (!['refused', 'n/a'].includes(f.vmpl0)) return { ok: false, reasons: [`REJECT: vmpl0=${JSON.stringify(f.vmpl0)} is not one of refused, GRANTED, n/a`] };
  if (want === 0) {
    if (f.vmpl0 !== 'n/a') reasons.push(`the monitor probed level 0 and recorded ${f.vmpl0}`);
    if (f.tier === 't1' && !(f.vmpl === '0' && f.vmpl_floor === '0')) {
      return { ok: false, reasons: [`REJECT: VMPL0 was expected but the self-test reads vmpl=${f.vmpl} vmpl_floor=${f.vmpl_floor}`] };
    }
    reasons.push('at VMPL0: no confinement above the guest is claimed, and none is checked');
    return { ok: true, reasons };
  }
  if (f.tier !== 't1') return { ok: false, reasons: [`REJECT: confinement at VMPL${want} was demanded but the self-test says tier=${f.tier}`] };
  if (f.vmpl !== String(want) || f.vmpl_floor !== String(want)) {
    return { ok: false, reasons: [`REJECT: VMPL${want} was demanded but the self-test reads vmpl=${f.vmpl} vmpl_floor=${f.vmpl_floor}; both must equal ${want}`] };
  }
  if (reportVmpl !== undefined && String(reportVmpl) !== f.vmpl) {
    return { ok: false, reasons: [`REJECT: the SIGNED report says VMPL${reportVmpl} but the relayed self-test claims vmpl=${f.vmpl}`] };
  }
  if (f.vmpl0 !== 'refused') {
    return { ok: false, reasons: [`REJECT: a report at VMPL0 must have been REFUSED to show this guest is confined, but the probe recorded vmpl0=${f.vmpl0}`] };
  }
  reasons.push(`the monitor reports VMPL${want} and a refused level-0 probe (vmpl=${f.vmpl} vmpl_floor=${f.vmpl_floor} vmpl0=refused), coherent with the signed report`);
  reasons.push('that refusal does NOT show this guest lacks VMPCK0: tsm-report refuses a level below its floor locally, and the floor is set by the sev-guest vmpck_id parameter, so a VMPL0 guest reproduces this tuple by configuration (measured 2026-09-23). What identifies the confining SVSM is the MEASUREMENT pinned above, not this tuple; see judge.mjs checkBoundary');
  return { ok: true, reasons };
}
// checkRuntime judges the ABI the domain used and, under ABI/2, the runtime identity it states - and
// returns the 32 bytes report_data[0:32] must equal. The app is a portable WebAssembly component
// compiled INSIDE the domain (isolation/contract/RUNTIME.md), so the runtime that compiled it, its
// version, its execution mode, the ISA it targeted and its CPU-feature policy are part of what a report
// vouches for. A verifier that ignored them would accept "some runtime compiled this component somehow".
//
// Rules, all fail-closed:
//   - an ABI this judge does not implement is a reject, never a fall-back to the one it does;
//   - under ABI/2 the identity must be admissible on the SAME rules the domain applied
//     (validateRuntimeIdentity mirrors contract.Validate): W^X enforced, a stated feature policy, a
//     cache that is none or authenticated, and an execution mode whose target ISA matches it;
//   - the binding is recomputed from the handshake's own key, the caller's own nonce and that identity,
//     so a document naming a different runtime than the one that asked for the report cannot verify. Under
//     ABI/1 it returns null, which leaves verifyQuote to compute the binding it always has;
//   - want.runtime, when the caller supplies it, pins the identity field for field: without it the
//     runtime is authenticated but UNPINNED, and the verdict says so rather than implying otherwise;
//   - the domain's runtime self-test must be present and coherent (see below).
//
// The self-test is the front's own measurement of this domain before it stated the identity
// (isolation/m2/front/runtime.go): whether the domain may hold an executable page at all, and whether
// any page in it is both writable and executable. Same standing as the boundary tuple: measured code's
// own word over an attested connection, and the front exits rather than serving on a fault. Not
// hardware proof.
export function checkRuntime(doc, handshakeSpki, nonce, want = {}) {
  const reasons = [];
  const abi = doc.abi ?? ABI1;
  if (abi !== ABI1 && abi !== ABI2) return { ok: false, reasons: [`REJECT: the document states abi ${JSON.stringify(abi)}, which this verifier does not implement`] };
  if (want.runtime !== undefined && abi !== ABI2) {
    return { ok: false, reasons: [`REJECT: a runtime identity was expected (abi ${ABI2}) but the document states ${abi}: a domain that dropped to ${ABI1} binds no runtime, and accepting that would be a silent downgrade`] };
  }
  if (abi === ABI1) {
    if (doc.runtime !== undefined || doc.runtimeSelfTest !== undefined) {
      return { ok: false, reasons: [`REJECT: the document states ${ABI1} but carries runtime fields; the binding it signed does not cover them, so they are unauthenticated decoration`] };
    }
    reasons.push(`${ABI1}: the binding covers the transport key and the nonce; no runtime identity is bound, so nothing here says what compiled this app`);
    // binding null means "the default": verifyQuote computes sha256(spki || nonce) itself, exactly as it
    // did before ABI/2 existed, so the path every domain in production uses today is untouched.
    return { ok: true, reasons, binding: null };
  }

  const why = validateRuntimeIdentity(doc.runtime);
  if (why) return { ok: false, reasons: [`REJECT: the runtime identity is not admissible: ${why}`] };
  const r = doc.runtime;
  if (want.runtime !== undefined) {
    const wr = want.runtime;
    const diff = Object.keys(r).filter((k) => r[k] !== wr[k]);
    if (diff.length) {
      return { ok: false, reasons: [`REJECT: the runtime identity differs from the expected one in ${diff.join(', ')}: got ${JSON.stringify(r)}`] };
    }
    reasons.push(`the runtime identity is the expected one: ${r.name}/${r.version} execution=${r.execution} target=${r.targetIsa} host=${r.hostIsa} features=${r.cpuFeatures} wx=${r.wx} cache=${r.cache}`);
  } else {
    reasons.push(`the runtime identity is bound into the report but UNPINNED by this caller: ${r.name}/${r.version} execution=${r.execution} target=${r.targetIsa} host=${r.hostIsa} features=${r.cpuFeatures} wx=${r.wx} cache=${r.cache} (pass want.runtime to pin it)`);
  }

  const st = checkRuntimeSelfTest(doc.runtimeSelfTest, r, { legacy: want.legacyWx });
  reasons.push(...st.reasons);
  if (!st.ok) return { ok: false, reasons };

  let rid;
  try { rid = runtimeId(r); } catch (e) { return { ok: false, reasons: [`REJECT: ${e.message}`] }; }
  reasons.push(`${ABI2}: report_data[0:32] must bind the transport key, the nonce AND runtime id ${rid.toString('hex').slice(0, 16)}…`);
  return { ok: true, reasons, binding: bind2(handshakeSpki, nonce, rid), wxCoverage: st.coverage };
}

// checkRuntimeSelfTest judges "exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 scope=cgroup:/dom1".
//
// The scan is made for EACH document (enclave-b4's finding, enclave-87's ruling): a document issued before the runtime
// runs covers no runtime and says runtime=0, and this judge REJECTS it wherever the runtime is a separate process. Who
// relies on the wx claim, and who does not (enclave-87: "decide per consumer; never silently accept runtime=0 where the
// claim is relied on"):
//   RELIES, and so attests only a SERVING domain (the app is up):
//     - guestd's admission (m4/guestd server.go launch and persist.go adoption -> client.mjs): only after the console
//       says "DOM serving", which the front prints once the app LISTENS (m2/front main.go);
//     - the node supervisor's SNP guest certificate (supervisor.js guestCertPass -> m4/guestd/supervisor-guestcert.mjs):
//       only for a record guestd reported running, so after that admission;
//     - isolation/m2/client.mjs and the lab harnesses that call it (test-m2.sh, test-m3.sh, test-m4.sh);
//   EXEMPT, because it never sees or reads the claim:
//     - the attested release and config handoff, which runs BEFORE the app starts: its evidence (m2/release
//       client.go Evidence) is a report with no self-test field;
//     - the production verifier (verifier/envelope.mjs validates runtimeSelfTest for SHAPE only, str(4096), "the
//       binding decides"), and so the relay, the site's and CLI's trusted mode;
//     - the NucBox (T0-hv): its readiness judge and its certificate pass both use judge-hv.mjs, which never reads it.
//
// PER RELEASE, NO FLAG DAY (enclave-87's ruling, 2026-09-26). A release built before this scan existed states the LEGACY
// form, "exec_pages=allowed wx=clean maps=3 scope=all-processes": one scan at front start, before the runtime existed,
// with no coverage by role. It is accepted ONLY for a release in LEGACY_WX_RELEASES that the CALLER names (want.release),
// with the measurement pinned, and then as "W^X of the runtime UNMEASURED" (coverage: runtime-unmeasured), never clean.
// A form that names roles is judged by the full rule whatever the release; a legacy form for any release not listed,
// or with no release named, is refused. A release's entry is REMOVED when that release is retired (the relay's rs-N;
// a guest on it can then neither be released to nor certified), and this judge then refuses its legacy form.
//
// The releases the relay could still predict when this table was written (enclave-e3, from nan's live env at
// 2026-09-26T04:29:16Z), every one built before the attest-time scan. Retired, so NOT listed: 52156652 (rs-8),
// 79c5ecf2 and a4f22748 (rs-6).
export const LEGACY_WX_RELEASES = Object.freeze({
  'f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca': 'domain release f7888d86 (image b63c2def): admitted, rs-7',
  '5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2': 'domain release 5c3561f9 (image 0181bce3): installed, KAT-only; the legacy tree\'s run-mode guests',
  '6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb': 'domain release 6f14ce75 (release-6757d139): installed, KAT-only; the legacy tree\'s other guests',
});

// legacyWxFor: whether a caller's named release(s) admit the legacy self-test. null = none named (the full rule applies);
// { ok: false, why } = a malformed name (the caller's fault: refused, never read as "none"); { ok: true, legacy } where
// legacy is a label ONLY when every named release is listed and the measurement is pinned, else null.
export function legacyWxFor(release, measurement, table = LEGACY_WX_RELEASES) {
  if (release === undefined || release === null) return null;
  const ids = (Array.isArray(release) ? release : [release]).map((x) => String(x).toLowerCase());
  if (!ids.length) return null;
  const bad = ids.find((x) => !/^[0-9a-f]{64}$/.test(x));
  if (bad !== undefined) return { ok: false, why: `REJECT: the caller names release ${JSON.stringify(bad)}, not a 64-hex release id` };
  if (!/^[0-9a-f]{96}$/.test(String(measurement || '').toLowerCase())) return { ok: true, legacy: null };
  if (!ids.every((x) => Object.hasOwn(table, x))) return { ok: true, legacy: null };
  return { ok: true, legacy: ids.map((x) => table[x]).join('; ') };
}
const SELFTEST_ROLES = ['runtime', 'front', 'init', 'root', 'other'];
export function checkRuntimeSelfTest(selfTest, identity, { legacy = null } = {}) {
  if (typeof selfTest !== 'string' || selfTest === '') {
    return { ok: false, reasons: [`REJECT: the document carries no runtime self-test, so nothing says this domain checked W^X or whether it may hold an executable page at all`] };
  }
  if (selfTest.length > 300) return { ok: false, reasons: ['REJECT: the runtime self-test is not a short string'] };
  const f = {};
  for (const part of selfTest.trim().split(/\s+/)) {
    const i = part.indexOf('=');
    if (i <= 0) return { ok: false, reasons: [`REJECT: malformed runtime self-test ${JSON.stringify(selfTest)}`] };
    const k = part.slice(0, i);
    if (k in f) return { ok: false, reasons: [`REJECT: the runtime self-test names ${k} more than once: ${JSON.stringify(selfTest)}`] };
    f[k] = part.slice(i + 1);
  }
  for (const k of ['exec_pages', 'wx', 'maps', 'scope']) {
    if (!(k in f)) return { ok: false, reasons: [`REJECT: the runtime self-test is missing ${k}: ${JSON.stringify(selfTest)}`] };
  }
  if (f.wx !== 'clean') {
    return { ok: false, reasons: [`REJECT: the runtime self-test says wx=${JSON.stringify(f.wx)}; W^X holds only when the domain found NO writable-and-executable mapping (wx=clean)`] };
  }
  const maps = Number(f.maps);
  if (!Number.isInteger(maps) || maps < 1) {
    return { ok: false, reasons: [`REJECT: the runtime self-test scanned maps=${JSON.stringify(f.maps)} processes; a scan that saw nothing is not a clean scan`] };
  }
  // the coverage BY ROLE: each count a whole number, all of them adding up to maps
  const roles = SELFTEST_ROLES.filter((r) => r in f);
  for (const r of roles) {
    const n = Number(f[r]);
    if (!/^\d+$/.test(f[r]) || !Number.isInteger(n)) return { ok: false, reasons: [`REJECT: the runtime self-test's ${r}=${JSON.stringify(f[r])} is not a count`] };
  }
  if (roles.length && roles.reduce((a, r) => a + Number(f[r]), 0) !== maps) {
    return { ok: false, reasons: [`REJECT: the runtime self-test's roles (${roles.map((r) => `${r}=${f[r]}`).join(' ')}) do not add up to maps=${maps}`] };
  }
  // The scope is a closed vocabulary, not free text. "wx=clean" means nothing without knowing WHAT was
  // scanned, and if any word were accepted a domain could invent a scope that merely reads broad
  // ("scope=everything") for a scan that covered one process. Each value says what coverage it claims:
  //
  //   all-processes   every process with an address space in this domain (M2/M4a: the domain is the guest)
  //   cgroup:<path>   every process in this domain's cgroup (M3: several domains share a guest, and a scan
  //                   reaching into a neighbour would let one domain fault another's attestation)
  //   self            the reporting process alone. Complete coverage ONLY where the runtime executes in
  //                   that same process - a library-embedded runtime, as in the Pixel pVM payload, rather
  //                   than a separate `wasmtime serve`. A verifier cannot check in-process-ness, so this
  //                   value carries a residual assumption and says so, and it must have scanned exactly one.
  const reasons = [];
  let coverage = 'runtime-covered';
  if (f.scope === 'self') {
    coverage = 'self';
    if (maps !== 1) {
      return { ok: false, reasons: [`REJECT: scope=self scanned maps=${maps}; scanning the reporting process alone is exactly one process`] };
    }
    reasons.push('the scan covered the reporting process ALONE (scope=self), which is complete only because the runtime is a library in that process; a separate runtime process would be unscanned, and the hardware does not attest which it is');
  } else if (f.scope === 'all-processes' || f.scope.startsWith('cgroup:/')) {
    // the runtime is a separate process here, so a clean scan means something only if it SAW the runtime
    if (!('runtime' in f) && legacy && !roles.length) {
      // the LEGACY form, for a release the caller named and this judge lists: accepted, and said to cover nothing
      coverage = 'runtime-unmeasured';
      reasons.push(`the LEGACY runtime self-test, accepted ONLY because the caller names ${legacy}, built before the attest-time scan: `
        + `it was made once at front start, before the runtime existed, and covered NO runtime process - W^X of the runtime is UNMEASURED here, not clean`);
    } else if (!('runtime' in f)) {
      return { ok: false, reasons: [`REJECT: the runtime self-test (scope=${f.scope}) does not say how many runtime processes it covered; a scan made before the runtime ran covered none (runtime=<n> is required)`] };
    } else if (Number(f.runtime) < 1) {
      return { ok: false, reasons: [`REJECT: the runtime self-test covered NO runtime process (runtime=${f.runtime}): measured before the runtime ran, or unable to see it; nothing shows W^X of the runtime`] };
    } else {
      reasons.push(f.scope === 'all-processes'
        ? `the scan covered every process with an address space in this domain (${maps}: ${roles.map((r) => `${r}=${f[r]}`).join(', ')})`
        : `the scan covered this domain's own cgroup ${f.scope.slice(7)} (${maps} processes: ${roles.map((r) => `${r}=${f[r]}`).join(', ')}), and no neighbour's`);
    }
  } else {
    return { ok: false, reasons: [`REJECT: scope=${JSON.stringify(f.scope)} is not one of all-processes, cgroup:/<path>, self; "wx=clean" says nothing without knowing what was scanned`] };
  }
  if (identity.execution === EXEC_JIT) {
    if (f.exec_pages !== 'allowed') {
      return { ok: false, reasons: [`REJECT: the identity says execution=${EXEC_JIT} but the domain measured exec_pages=${JSON.stringify(f.exec_pages)}: no JIT can run where an executable page is refused`] };
    }
    reasons.push(`the domain measured that it may hold an executable page (exec_pages=allowed), which execution=${EXEC_JIT} requires, and found no writable-and-executable mapping among ${maps} processes in scope ${f.scope}`);

  } else {
    reasons.push(`the domain interprets ${identity.targetIsa} bytecode (exec_pages=${f.exec_pages}) and found no writable-and-executable mapping among ${maps} processes in scope ${f.scope}`);
  }
  reasons.push("that self-test is the measured front's own word, relayed over this attested connection; the hardware does not attest it (see judge.mjs checkRuntime)");
  return { ok: true, reasons, coverage };
}
const OPENS = { trusted: ['attested'], 'lab-unsigned': ['attested', 'no-tcb-policy', 'unauthenticated'], 't0-diagnostic': ['not-attested'] };

// the certificate table configfs-tsm returns, holding one VCEK: {guid, offset, length}, zero-terminated
export function vcekTable(vcekDer) {
  const hdr = Buffer.alloc(48);
  Buffer.from('63da758de6644564adc5f4b93be8accd', 'hex').copy(hdr, 0);
  hdr.writeUInt32LE(48, 16);
  hdr.writeUInt32LE(vcekDer.length, 20);
  return Buffer.concat([hdr, vcekDer]);
}

export async function judge(doc, handshakeSpki, nonce, { measurement, appSha, mode = 'trusted', minTcb, vcek, kds = true, expectedVmpl, runtime, hostData, release }) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  const out = (verdict, reasons, extra = {}) => ({ verdict, reasons, gateOpen: OPENS[mode].includes(verdict), ...extra });

  if (doc.format === 'none') {
    const reasons = [doc.reason || 'no hardware report'];
    if (mode !== 't0-diagnostic') reasons.push(`a T0 domain is never trusted; ${mode} mode refuses it (--t0-diagnostic talks to it explicitly)`);
    else reasons.push('T0 diagnostic: the pin is trust-on-first-use and the host can read and change this traffic');
    return out('not-attested', reasons);
  }
  if (mode === 't0-diagnostic') return out('reject', [`t0-diagnostic mode expects a T0 domain, got format ${doc.format}`]);
  // The formats this verifier knows, and what each one IMPLIES. A new format is admitted by adding a row here
  // with its constraints, never by widening a condition: the whole value of an allowlist is that an unrecognised
  // format is refused rather than judged by whichever rules happen to run next.
  //
  //   sev-snp-guest-domain-v1  the domain fetched its own report and composed report_data itself.
  //
  //   WHAT THE LABEL IS WORTH: nothing on its own. It is a field in an unauthenticated document, and the same
  //   report relabelled sev-snp-guest-domain-v1 still verifies - a WEAKER claim, not a wider acceptance. What
  //   establishes that the SVSM composed report_data is the MEASUREMENT the caller pins, because the digest
  //   covers the SVSM and the tables it answers from. The same reasoning is why the boundary tuple was NOT
  //   extended with a "this plane holds no VMPCK" field when that evidence became available: a VMPL0 guest
  //   could write such a field as easily as it can set tsm-report's floor. Properties of the confining monitor
  //   belong to the digest, and under the digests this repo pins, app planes hold no VMPCK - see
  //   isolation/m4/evidence/plane-handshake-binding-2026-09-24.txt for the kernel's own words on that run
  //   ("Empty VMPCK0/2 communication key"), which is run evidence FOR THAT DIGEST and not a document field.
  //
  //   sev-snp-svsm-plane-v1    the measured SVSM composed report_data. The domain supplied only a nonce, so
  //                            report_data[0:32] is the SVSM's Bind2 over a key registered at plane start and a
  //                            RuntimeID compiled into the SVSM's measured image, and report_data[32:64] comes
  //                            from its APP_TABLE indexed by the calling plane. That is only stronger than the
  //                            self-composed shape if the report really comes from a plane BENEATH the composer,
  //                            so this format requires a non-zero VMPL and ABI/2 - at VMPL0 there is nothing
  //                            above the guest, and under ABI/1 the binding folds in no runtime identity, so in
  //                            either case the document would claim an authority it does not have.
  const FORMATS = {
    'sev-snp-guest-domain-v1': { requireNonZeroVmpl: false, requireAbi2: false },
    'sev-snp-svsm-plane-v1': { requireNonZeroVmpl: true, requireAbi2: true },
  };
  const fmt = FORMATS[doc.format];
  if (!fmt || !doc.report) return out('reject', [`unknown attestation format ${doc.format}`]);

  const report = Buffer.from(doc.report, 'base64');
  let p;
  try { p = parseSnpReport(report); } catch (e) { return out('reject', [`unparseable report: ${e.message}`]); }
  const extra = { measurement: p.measurement.toString('hex'), reportData: p.reportData.toString('hex'),
    vmpl: p.vmpl };   // which privilege level the report came from, so a caller can show it, not just pin it
  const auxblob = doc.certs ? Buffer.from(doc.certs, 'base64') : vcek ? vcekTable(vcek) : null;
  // Which ABI, and therefore which binding report_data[0:32] must equal. Judged BEFORE the report is
  // verified, for the same reason as the boundary tuple below: an inadmissible runtime identity or an
  // incoherent self-test is a security fault in every mode, including the lab-unsigned diagnostic.
  const lw = legacyWxFor(release, measurement);
  if (lw && !lw.ok) return out('reject', [lw.why], extra);
  const rt = checkRuntime(doc, handshakeSpki, nonce, { runtime, legacyWx: lw ? lw.legacy : null });
  if (rt.wxCoverage) extra.wxCoverage = rt.wxCoverage;
  extra.abi = doc.abi ?? ABI1;
  if (doc.runtime !== undefined) extra.runtime = doc.runtime;
  if (doc.runtimeSelfTest !== undefined) extra.runtimeSelfTest = doc.runtimeSelfTest;
  if (!rt.ok) return out('reject', rt.reasons, extra);
  if (fmt.requireAbi2 && extra.abi !== ABI2) {
    return out('reject', [`format ${doc.format} states the SVSM computed the binding, which folds in a runtime `
      + `identity, so it requires ${ABI2}; this document says ${extra.abi}`], extra);
  }
  if (fmt.requireNonZeroVmpl && p.vmpl === 0) {
    return out('reject', [`format ${doc.format} claims a measured monitor above this guest composed report_data, `
      + 'but the signed report names VMPL0, where nothing is above it'], extra);
  }
  const v = await verifyQuote(report, {
    challenge: nonce, transportKeySpki: handshakeSpki, allowedMeasurements: [measurement], auxblob, kds,
    requireVcek: mode === 'trusted',      // lab-unsigned alone may continue without the chain
    ...(rt.binding !== null ? { expectedBinding: rt.binding } : {}),
    ...(minTcb !== undefined ? { minTcb } : {}),
    ...(expectedVmpl !== undefined ? { expectedVmpl } : {}),
  });
  const reasons = [...rt.reasons, ...v.reasons];
  if (v.tcb) extra.tcb = v.tcb;
  if (!v.ok) return out('reject', reasons, extra);
  if (p.reportData.subarray(32, 64).toString('hex') !== appSha) {
    reasons.push('report_data[32:64] does not name the expected app');
    return out('reject', reasons, extra);
  }
  reasons.push('report_data[32:64] names the expected app');
  // Which deployment: HOST_DATA (report bytes 0xC0..0xE0), judged in every mode like the app half above.
  const hd = report.subarray(0xc0, 0xe0);
  extra.hostData = hd.toString('hex');
  if (hostData !== undefined && hostData !== null) {
    const s = String(hostData).toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(s)) {
      reasons.push('REJECT: the expected deployment (hostData) must be exactly 32 bytes of hex, the full deployment id');
      return out('reject', reasons, extra);
    }
    if (/^0{64}$/.test(s)) {
      reasons.push('REJECT: an all-zero expected host_data names no deployment');
      return out('reject', reasons, extra);
    }
    if (hd.toString('hex') !== s) {
      reasons.push(`REJECT: report host_data ${hd.toString('hex').slice(0, 16)}… is not the expected deployment 0x${s.slice(0, 16)}…`
        + (/^0{64}$/.test(hd.toString('hex')) ? ' (the guest was launched with no deployment bound)' : ''));
      return out('reject', reasons, extra);
    }
    reasons.push(`host_data names the expected deployment 0x${s.slice(0, 16)}… (signed by the PSP; outside the measurement)`);
  } else {
    reasons.push('host_data NOT CHECKED: no expected deployment was given, so another instance of this same app version would verify identically');
  }
  // The boundary self-test is judged BEFORE the chain verdict, deliberately. An incoherent tuple - vmpl0
  // GRANTED, a probe that never ran, a claim that disagrees with the signed level - is a security fault
  // and must be a REJECT in every mode, including the lab-unsigned diagnostic. It sat after the
  // `unauthenticated` return at first, which meant lab-unsigned never reached it and accepted every bad
  // tuple; that was found by replaying a real report from hardware, not by the unit tests.
  const b = checkBoundary(doc.boundary, expectedVmpl, p.vmpl);
  extra.boundary = doc.boundary ?? null;
  reasons.push(...b.reasons);
  if (!b.ok) return out('reject', reasons, extra);
  if (v.vcekVerified !== true) {
    reasons.push('UNAUTHENTICATED: the AMD signature chain did not verify, so every field above is unauthenticated '
      + '(a host could have written them); lab diagnostic only, not attestation');
    return out('unauthenticated', reasons, extra);
  }
  if (!v.tcb || v.tcb.checked !== true) {
    reasons.push('NOT ACCEPTED: the AMD chain verified, but no minimum-TCB policy was supplied, so the firmware level '
      + 'is unjudged (supply --min-tcb)');
    return out('no-tcb-policy', reasons, extra);
  }
  return out('attested', reasons, extra);
}
