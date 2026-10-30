// AVF v2 binds BOTH keys generated inside the measured payload. A recipient
// encryption key carried outside the attested bytes is not an authenticated
// recipient: the untrusted Android app could replace it with its own key.
export const AVF_PAD_FORMAT = "android-avf-pvm/v2";
export const AVF_PAD_DOMAIN = "enclave-avf-pad-bind-v1\n";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function avfPadBinding(spki, padKey, nonce) {
  if (!Buffer.isBuffer(spki) || spki.length !== 44 ||
      !spki.subarray(0, 12).equals(ED25519_SPKI_PREFIX))
    throw new Error("AVF v2 transportKey must be an Ed25519 SPKI");
  if (typeof padKey !== "string" || padKey.length !== 64 || !/^[0-9a-f]{64}$/.test(padKey))
    throw new Error("AVF v2 padKey must be 32 bytes of lowercase hex");
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32)
    throw new Error("AVF v2 nonce must be 32 bytes");
  return Buffer.concat([Buffer.from(AVF_PAD_DOMAIN), spki, Buffer.from(padKey, "hex"), nonce]);
}
