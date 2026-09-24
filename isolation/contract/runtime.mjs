// The verifier's half of runtime.go: the runtime identity, its digest, the ABI/2 binding and the
// compiled-cache key, in JavaScript.
//
// Why a mirror and not a re-implementation: a verifier has to recompute report_data[0:32] from the
// identity a domain STATES in its attestation document. If the two sides disagree by a byte - a field
// order, a missing field, a laxer validation - every honest domain looks like a liar, or worse, a
// domain claiming an inadmissible runtime passes. So this file is driven by isolation/contract/
// vectors.json, the same vectors the Go implementation and the Rust launcher pass
// (test/isolation-runtime-identity.test.mjs), and the fail-closed rules are copied from Validate()
// deliberately rather than rephrased.
//
// The rules, from isolation/contract/RUNTIME.md:
//   - execution "jit": the target ISA is the host's own (x86_64 | aarch64) and equals hostIsa;
//   - execution "interpreter": the target is pulley64 and hostIsa names the real hardware. This is the
//     mode a domain that may not hold executable pages uses - a stock Pixel pVM (execmem denied,
//     measured) and a Windows VBS enclave (ERROR_DYNAMIC_CODE_BLOCKED, measured in windows/PARITY.md);
//   - W^X must be stated as enforced, the cache must be none or authenticated, and the CPU-feature
//     policy must be stated. An identity that cannot say these is refused, not downgraded.
import { createHash } from 'node:crypto';

export const ABI1 = 'enclave-domain-abi/1';
export const ABI2 = 'enclave-domain-abi/2';

export const ISA_X86_64 = 'x86_64';
export const ISA_AARCH64 = 'aarch64';
export const ISA_PULLEY64 = 'pulley64';
export const EXEC_JIT = 'jit';
export const EXEC_INTERPRETER = 'interpreter';
export const WX_ENFORCED = 'enforced';
export const CACHE_NONE = 'none';
export const CACHE_AUTHENTICATED = 'authenticated';

const BIND2_DOMAIN = Buffer.from('enclave-bind-v2\n');
const CACHE_KEY_DOMAIN = Buffer.from('enclave-compiled-cache-v1\n');

// the fields of RuntimeIdentity, and nothing else: an unknown field is a different identity than the
// one the Go type describes, so it is refused rather than ignored
const FIELDS = ['name', 'version', 'execution', 'targetIsa', 'hostIsa', 'cpuFeatures', 'wx', 'cache'];

// canonical is Canonical() from bundle.go: compact JSON, keys sorted at every level, no HTML escaping.
export function canonical(v) {
  const sort = (x) => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') {
      const out = {};
      for (const k of Object.keys(x).sort()) out[k] = sort(x[k]);
      return out;
    }
    return x;
  };
  return Buffer.from(JSON.stringify(sort(v)));
}

// validateRuntimeIdentity returns null when the identity is admissible, or the reason it is not.
// Fail closed: every reason is a refusal, never a downgrade.
export function validateRuntimeIdentity(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'the runtime identity is not an object';
  for (const k of Object.keys(r)) {
    if (!FIELDS.includes(k)) return `the runtime identity carries an unknown field ${JSON.stringify(k)}`;
  }
  for (const k of FIELDS) {
    if (typeof r[k] !== 'string') return `the runtime identity field ${k} is missing or not a string`;
  }
  if (r.name === '' || r.version === '') return 'runtime name and version are required';
  if (r.hostISA === '') return 'the host ISA must be stated';
  if (r.hostIsa !== ISA_X86_64 && r.hostIsa !== ISA_AARCH64) {
    return `host ISA ${JSON.stringify(r.hostIsa)} is not one of ${ISA_X86_64}, ${ISA_AARCH64}`;
  }
  if (r.execution === EXEC_JIT) {
    if (r.targetIsa !== r.hostIsa) {
      return `a JIT emits the host's own ISA: target ${JSON.stringify(r.targetIsa)} must equal host ${JSON.stringify(r.hostIsa)}`;
    }
  } else if (r.execution === EXEC_INTERPRETER) {
    if (r.targetIsa !== ISA_PULLEY64) {
      return `an interpreter runs ${ISA_PULLEY64} bytecode, not ${JSON.stringify(r.targetIsa)}`;
    }
  } else {
    return `execution ${JSON.stringify(r.execution)} is not one of ${EXEC_JIT}, ${EXEC_INTERPRETER}`;
  }
  if (r.cpuFeatures === '') return 'the CPU-feature policy must be stated ("baseline" if none)';
  if (r.wx !== WX_ENFORCED) return 'a runtime that cannot state W^X as enforced is not admissible';
  if (r.cache !== CACHE_NONE && r.cache !== CACHE_AUTHENTICATED) {
    return `cache mode ${JSON.stringify(r.cache)} is not one of ${CACHE_NONE}, ${CACHE_AUTHENTICATED}`;
  }
  return null;
}

// runtimeId is sha256 of the identity's canonical JSON, exactly RuntimeID() in runtime.go. An
// inadmissible identity has no ID: it throws rather than returning a digest something could pin.
export function runtimeId(r) {
  const why = validateRuntimeIdentity(r);
  if (why) throw new Error(`inadmissible runtime identity: ${why}`);
  const only = {};
  for (const k of FIELDS) only[k] = r[k];
  return createHash('sha256').update(canonical(only)).digest();
}

// bind2 is the ABI/2 binding for report_data[0:32]: the domain's transport key, the verifier's nonce
// and the runtime identity together. report_data[32:64] stays the app ID.
export function bind2(spki, nonce, rid) {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  if (rid.length !== 32) throw new Error('runtime id must be 32 bytes');
  return createHash('sha256').update(Buffer.concat([BIND2_DOMAIN, Buffer.from(spki), Buffer.from(nonce), Buffer.from(rid)])).digest();
}

// bind1 is the ABI/1 binding, kept here so a caller can compute either from one place.
export function bind1(spki, nonce) {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  return createHash('sha256').update(Buffer.concat([Buffer.from(spki), Buffer.from(nonce)])).digest();
}

// cacheKey names a compiled artifact a domain may keep: bundle identity and runtime identity together,
// so the same component compiled by another runtime version, for another ISA or under another feature
// policy is a different entry. Anything under another key, or failing its authentication, is rebuilt.
export function cacheKey(appId, rid) {
  return createHash('sha256').update(Buffer.concat([CACHE_KEY_DOMAIN, Buffer.from(appId), Buffer.from(rid)])).digest();
}
