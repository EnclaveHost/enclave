// The browser entry for owner-side custody (site/vendor/custody.js, built by scripts/build-custody-vendor.mjs): everything
// the site needs to encrypt an env map to a custodian committee IN THE BROWSER and build the vault update. No relay, no
// server, no key ever leaves the page: the output is ciphertext, commitments and sealed shares.
export { buildBundle, makeUpdate, contentHash, updateTypedData, UPDATE_ABI } from "./owner.mjs";
export { createChainReader } from "./chain.mjs";
export { validateRules, parseRules, canonicalRules, rulesFromPrediction, DEFAULT_MIN_TCB } from "./rules.mjs";
export { checkEnv, configTextOf, configTextFromEnvelope, configSha256 } from "./protocol.mjs";
export { encodeFunctionData } from "viem";
