// The HOST runtimes' admission bundle entry (windows/node/host-admission.bundle.mjs, imported by windows/node/host.mjs and by
// supervisor.js): everything network/host-admission-runtime.mjs exports, with createHostServiceGate taken from
// host-service-gate-carriers.mjs (the base gate unchanged unless ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS is set). The metal
// guest's host-policy bundle keeps its own entry (network/metal-host-policy.mjs), so its bytes do not change.
export * from './host-admission-runtime.mjs';
export { createHostServiceGate, hostPolicyCarriersFromEnv } from './host-service-gate-carriers.mjs';
// The node's explicit chain authority for its generic chain client and its own agreed() readers (windows/node/chain.mjs,
// windows/node/chain-reader.mjs): the shared LeaseReader and verified-state client, never a second implementation.
export { LeaseReader, chainAuthorityFromEnv } from './lease-reader.mjs';
export { chainVerifierFromEnv, transactionRpcsFromEnv, verifiedStateReader, verifiedSnapshot, verifiedStateClient, VERIFIED_STATE_METHODS } from './verified-read-client.mjs';
