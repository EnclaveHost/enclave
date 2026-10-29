// network/attested-verifier-brand.mjs - the mark that a verifier object was created by network/attested-verifier-client.mjs (a
// remote, SEV-SNP-attested chain verifier). Readers (LeaseReader, verified-chain) then label its answers "attested-verifier"
// with localProof false; they never call such answers "local" proof verification.
//
// What the mark is, and is NOT:
//   * it stops a PLAIN object (a config value, a JSON-shaped stand-in, any { request } that merely claims to be attested)
//     from being labelled attested: only an object the client created carries it;
//   * it is NOT a security boundary against arbitrary JavaScript in the same process, which could import the marking function
//     (or patch any module); in-process code is trusted code here, as it is for every other reader seam.
// The mark lives in ONE process-global WeakSet (Symbol.for key), so two bundled copies of this module (a reader bundle and a
// client bundle loaded side by side) share it: a real client is never mislabelled "local-verifier" by a duplicate copy.
// Dependency-free, so every reader bundle can import it without pulling the client in.
const KEY = Symbol.for('enclave.attested-verifier.brand/v1');
const BRAND = (globalThis[KEY] instanceof WeakSet) ? globalThis[KEY] : (globalThis[KEY] = new WeakSet());
/** Used ONLY by network/attested-verifier-client.mjs when it returns a client it built. */
export function markAttestedVerifierClient(o) { if (!o || typeof o !== 'object') throw new Error('attested verifier brand: not an object'); BRAND.add(o); return o; }
/** true only for an object the attested verifier client created (in this process, any bundled copy). */
export const isAttestedVerifier = (o) => !!o && typeof o === 'object' && BRAND.has(o);
