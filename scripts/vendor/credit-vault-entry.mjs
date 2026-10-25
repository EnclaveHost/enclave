// The reviewed library primitives the independent credit-vault client uses in the browser (site/js/core/credit-vault-
// independent.js, site/credit/), re-exported from the repository's own viem / ox / @noble packages (no new dependency).
// Built into site/vendor/credit-vault.js by scripts/build-credit-vault-vendor.mjs; nothing here implements cryptography.
export { encodeFunctionData, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, decodeAbiParameters, keccak256, getAddress,
  concat, pad, toHex, hexToBytes, bytesToHex, toFunctionSelector } from "viem";
export { WebAuthnP256 } from "ox";
export { p256 } from "@noble/curves/p256";
export { sha256 } from "@noble/hashes/sha256";
