import { bytesToHex, hexToBytes, sha256, type Hex } from "viem";
import { keyHashOf } from "./typed.js";

/** A session key: P-256, signing through WebCrypto (browser and Node 20+ alike).
 *  WebCrypto's ECDSA-with-SHA-256 signs SHA-256(message); the vault verifies the
 *  precompile over sha256(eip712Digest), so `signDigest` hands WebCrypto the
 *  32-byte digest as the message. */
export interface SessionSigner {
  readonly x: bigint;
  readonly y: bigint;
  readonly keyHash: Hex;
  /** P-256 over SHA-256(digest bytes) -> r, s (IEEE P1363). */
  signDigest(digest: Hex): Promise<{ r: Hex; s: Hex }>;
  /** P-256 over SHA-256(message bytes) -> 64-byte r||s, for API request signing. */
  signBytes(message: Uint8Array): Promise<Uint8Array>;
}

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available (needs a browser or Node 20+)");
  return c.subtle;
}

/** `extractable` must be false in browsers (the key lives as a CryptoKey in
 *  IndexedDB) and true only where the key has to be written to a file. */
export async function generateKeyPair(extractable: boolean): Promise<CryptoKeyPair> {
  return subtle().generateKey(ALG, extractable, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

export async function publicKeyXY(publicKey: CryptoKey): Promise<{ x: bigint; y: bigint }> {
  const raw = new Uint8Array(await subtle().exportKey("raw", publicKey));
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("unexpected P-256 public key encoding");
  return { x: BigInt(bytesToHex(raw.slice(1, 33))), y: BigInt(bytesToHex(raw.slice(33, 65))) };
}

export async function signerFromKeys(privateKey: CryptoKey, x: bigint, y: bigint): Promise<SessionSigner> {
  const keyHash = keyHashOf(x, y);
  const signBytes = async (message: Uint8Array) =>
    new Uint8Array(await subtle().sign(SIGN, privateKey, message as BufferSource));
  return {
    x, y, keyHash,
    signBytes,
    async signDigest(digest: Hex) {
      const sig = await signBytes(hexToBytes(digest));
      return { r: bytesToHex(sig.slice(0, 32)), s: bytesToHex(sig.slice(32, 64)) };
    },
  };
}

export async function signerFromKeyPair(kp: CryptoKeyPair): Promise<SessionSigner> {
  const { x, y } = await publicKeyXY(kp.publicKey);
  return signerFromKeys(kp.privateKey, x, y);
}

const b64u = (b: Uint8Array) => {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
export { b64u as base64url, unb64u as fromBase64url };

/** PKCS#8 export of an EXTRACTABLE key (file/env storage only). */
export async function exportPrivateKey(privateKey: CryptoKey): Promise<string> {
  return b64u(new Uint8Array(await subtle().exportKey("pkcs8", privateKey)));
}

/** Re-import a stored key as NON-extractable: once loaded it can sign, never leave. */
export async function importPrivateKey(pkcs8: string): Promise<CryptoKey> {
  return subtle().importKey("pkcs8", unb64u(pkcs8) as BufferSource, ALG, false, ["sign"]);
}

export function sha256Hex(data: Uint8Array | string): Hex {
  return sha256(typeof data === "string" ? new TextEncoder().encode(data) : data);
}
