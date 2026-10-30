// standalone-keys.mjs -- the phone's operator key (STANDALONE.md): made on the phone, kept in the app's private files.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/** A fresh secp256k1 private key as 0x + 64 hex (viem draws it from the platform's CSPRNG). */
export const generatePrivateKeyHex = () => generatePrivateKey();

/** The operator account for a key file's text; refuses anything but one 0x + 64 hex key. */
export function operatorAccount(text) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new Error("operator.key does not hold one 0x + 64 hex private key");
  return privateKeyToAccount(text);
}
