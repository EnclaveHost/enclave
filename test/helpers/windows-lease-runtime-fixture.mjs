// Test-only transport/clock adapter. The host source is unchanged; production has no loopback/clock environment flag.
// Everything else, including the reviewed-file parser, bindings, signing, relays and receipt verifier, runs for real.
import * as real from "../../windows/node/lease-gas-runtime.bundle.mjs";
export const leaseGasConfigured = real.leaseGasConfigured;
export const openReleaseJournal = real.openReleaseJournal;
export const loadLeaseGasConfig = (options) => real.loadLeaseGasConfig({
  ...options, allowLoopbackHttp: true, rpcTimeoutMs: 2000,
});
export const configuredLeaseSender = (options) => real.configuredLeaseSender({
  ...options, confirmations: 0, requestTimeoutMs: 2000, ttlSec: Number(process.env.TEST_LEASE_FIXTURE_TTL_SEC || 300),
  now: () => Date.now() + (globalThis.leaseGasFixtureClockOffset || 0),
});
