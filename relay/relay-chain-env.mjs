// The relay's chain-authority environment names, without dependencies: relay/relay-chain-authority.mjs (the relay itself)
// and metal/guest/platform-api-role.mjs (the measured guest's relay child) refuse the SAME set, and
// metal/guest/measured-control.mjs (installed unbundled) carries a copy that test/relay-chain-authority.test.mjs compares.
export const RELAY_CHAIN_ENV = Object.freeze(['ENCLAVE_CHAIN_AUTHORITY', 'ENCLAVE_CHAIN_VERIFIER', 'ENCLAVE_CHAIN_TX_BACKEND']);
/** Provider settings of relay consumers that read through the relay's chain authority under the verifier: set together
 *  with ENCLAVE_CHAIN_AUTHORITY=verifier they are a mixed configuration, refused (never resolved by dropping one). */
export const RELAY_VERIFIER_CONFLICTS = Object.freeze([
  'BASE_RPC', 'RPC_FALLBACKS',                             // api-relay chain(), relay/store.js pool, sponsor, MCP
  'SECRETS_RELEASE_CATALOG_RPCS',                          // secrets-release catalog, ledger record and lease generation
  'CUSTODY_RPCS', 'CUSTODY_MIN_AGREE',                     // relay/custody-state.mjs
  'SESSIONS_RPC',                                          // relay/sessions.mjs relayer
]);
