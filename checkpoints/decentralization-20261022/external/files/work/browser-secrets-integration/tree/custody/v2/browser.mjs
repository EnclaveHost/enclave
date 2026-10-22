// The browser entry of custody v2 (site/vendor/custody-v2.js, built by scripts/build-custody-v2-vendor.mjs): RE-EXPORTS ONLY,
// so the independent dashboard (site/js/core/independent-secrets.js) runs exactly the owner-read protocol, chain reader,
// rules parsers and bundle code that the custodians and the CLI run - nothing here reinterprets them.
export { readOwnerSecrets, planSecretsEdit, ownerEditUpdate, policyRulesOf, OWNER_READ_CHALLENGE_PATH, OWNER_READ_PATH } from "./owner-secrets.mjs";
export { ownerReadTypedData, ownerReadBinding, OWNER_READ_PURPOSE, labelOf, encryptBundle, parseBundle } from "./protocol.mjs";
export { createChainReaderV2, VAULT_V2_ABI } from "./chain.mjs";
export { UPDATE_V2_ABI, updateTypedDataV2, contentHashV2 } from "./owner.mjs";
export { parseRules, validateRules, canonicalRules, ownerReadAllowed } from "../rules.mjs";
export { parseShieldRules, validateShieldRules, canonicalShieldRules, SHIELD_RULES_FORMAT, SHIELD_TIER_ACK } from "./shield-rules.mjs";
export { configTextFromEnvelope, configTextOf, configSha256, checkEnv } from "../protocol.mjs";
export { encodeFunctionData, decodeFunctionResult, decodeErrorResult, bytesToHex, hexToBytes } from "viem";
