// verifier/tls-binding.mjs: the key a verifier binds, and the hash it binds it with.
//
// The rule that matters for every format: the SPKI a verifier binds is the one ITS OWN handshake saw (or, for a box reached
// through the relay, the transport key the box's document names and the report binds together with the verifier's nonce),
// never a key a third party restates. A document's transportKey field is a convenience for offline replay and is labelled
// as such in the verdict.
import { createHash, X509Certificate } from "node:crypto";

export const sha256 = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };

export function spkiOfCert(pemOrDer) {
  const c = new X509Certificate(pemOrDer);
  return { spki: c.publicKey.export({ type: "spki", format: "der" }), cert: c };
}
