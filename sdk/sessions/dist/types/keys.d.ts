import { type Hex } from "viem";
/** A session key: P-256, signing through WebCrypto (browser and Node 20+ alike).
 *  WebCrypto's ECDSA-with-SHA-256 signs SHA-256(message); the vault verifies the
 *  precompile over sha256(eip712Digest), so `signDigest` hands WebCrypto the
 *  32-byte digest as the message. */
export interface SessionSigner {
    readonly x: bigint;
    readonly y: bigint;
    readonly keyHash: Hex;
    /** P-256 over SHA-256(digest bytes) -> r, s (IEEE P1363). */
    signDigest(digest: Hex): Promise<{
        r: Hex;
        s: Hex;
    }>;
    /** P-256 over SHA-256(message bytes) -> 64-byte r||s, for API request signing. */
    signBytes(message: Uint8Array): Promise<Uint8Array>;
}
/** `extractable` must be false in browsers (the key lives as a CryptoKey in
 *  IndexedDB) and true only where the key has to be written to a file. */
export declare function generateKeyPair(extractable: boolean): Promise<CryptoKeyPair>;
export declare function publicKeyXY(publicKey: CryptoKey): Promise<{
    x: bigint;
    y: bigint;
}>;
export declare function signerFromKeys(privateKey: CryptoKey, x: bigint, y: bigint): Promise<SessionSigner>;
export declare function signerFromKeyPair(kp: CryptoKeyPair): Promise<SessionSigner>;
declare const b64u: (b: Uint8Array) => string;
declare const unb64u: (s: string) => Uint8Array<ArrayBuffer>;
export { b64u as base64url, unb64u as fromBase64url };
/** PKCS#8 export of an EXTRACTABLE key (file/env storage only). */
export declare function exportPrivateKey(privateKey: CryptoKey): Promise<string>;
/** Re-import a stored key as NON-extractable: once loaded it can sign, never leave. */
export declare function importPrivateKey(pkcs8: string): Promise<CryptoKey>;
export declare function sha256Hex(data: Uint8Array | string): Hex;
