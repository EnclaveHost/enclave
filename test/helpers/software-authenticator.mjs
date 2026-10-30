// A software WebAuthn authenticator for Node integration tests: createFn / getFn shaped like navigator.credentials.create /
// .get, so ox WebAuthnP256.createCredential / sign (the code the browser runs) parse its answers exactly as a browser's.
// Standard encodings, nothing invented:
//   authenticatorData = sha256(rpId) || flags (UP 0x01 | UV 0x04 [| AT 0x40 at creation]) || signCount (4 bytes BE)
//   clientDataJSON    = {"type":"webauthn.get","challenge":"<b64url>","origin":"https://<rpId>","crossOrigin":false}
//   signature         = ECDSA P-256 / SHA-256 over authenticatorData || sha256(clientDataJSON), DER (as authenticators return)
// Like a real authenticator it refuses an assertion for a credential under a different RP id, and it can drop UV or sign a
// wrong challenge on request (negative tests).
import { generateKeyPairSync, createHash, sign, randomBytes } from "node:crypto";

const sha256 = (b) => createHash("sha256").update(b).digest();
const b64url = (b) => Buffer.from(b).toString("base64url");
const ab = (b) => { const u = new Uint8Array(b); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };

export function softwareAuthenticator({ origin = (rpId) => "https://" + rpId } = {}){
  const creds = new Map();                     // credentialId (b64url) -> { key, rpId, count }
  const mode = { uv: true, tamperChallenge: false, log: [] };
  async function createFn(opts){
    const pk = opts.publicKey, rpId = pk.rp.id;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const rawId = randomBytes(16), id = b64url(rawId);
    creds.set(id, { key: privateKey, rpId, count: 0 });
    mode.log.push({ op: "create", rpId, id, uv: pk.authenticatorSelection?.userVerification });
    const spki = publicKey.export({ format: "der", type: "spki" });
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: b64url(pk.challenge), origin: origin(rpId), crossOrigin: false }));
    return { id, rawId: ab(rawId), type: "public-key",
      response: { clientDataJSON: ab(clientDataJSON), attestationObject: ab(Buffer.alloc(0)), getPublicKey: () => ab(spki) } };
  }
  async function getFn(opts){
    const pk = opts.publicKey, allow = (pk.allowCredentials || []).map((c) => b64url(c.id));
    const id = allow.find((x) => creds.has(x));
    if (!id) throw new Error("NotAllowedError: no matching credential");
    const c = creds.get(id);
    if (c.rpId !== pk.rpId) throw new Error("SecurityError: the credential belongs to RP " + c.rpId + ", not " + pk.rpId);
    c.count++;
    const challenge = mode.tamperChallenge ? sha256(Buffer.from(pk.challenge)) : Buffer.from(pk.challenge);
    const flags = 0x01 | (mode.uv ? 0x04 : 0);
    const authenticatorData = Buffer.concat([sha256(Buffer.from(c.rpId)), Buffer.from([flags]), Buffer.from([0, 0, 0, c.count])]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin: origin(c.rpId), crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), c.key);   // DER
    mode.log.push({ op: "get", rpId: c.rpId, id, uv: pk.userVerification });
    return { id, rawId: ab(Buffer.from(id, "base64url")), type: "public-key",
      response: { clientDataJSON: ab(clientDataJSON), authenticatorData: ab(authenticatorData), signature: ab(signature), userHandle: null } };
  }
  return { createFn, getFn, creds, mode };
}
