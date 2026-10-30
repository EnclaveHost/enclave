// The reviewed library primitives the independent passkey account uses in the browser (site/js/core/passkey-account.js),
// re-exported from the repository's own viem / ox (no new dependency). Built into site/vendor/aa.js by
// scripts/build-aa-vendor.mjs; nothing here implements cryptography or ABI rules itself.
export { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, decodeAbiParameters, hashTypedData, encodePacked,
  keccak256, getAddress, concat, pad, toHex, hexToBytes, bytesToHex, isAddress } from "viem";
export { WebAuthnP256 } from "ox";
