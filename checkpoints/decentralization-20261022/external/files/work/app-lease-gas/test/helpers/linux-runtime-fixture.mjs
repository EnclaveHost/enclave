// Test-only transport/clock adapter for the ACTUAL Linux supervisor candidate (shadow-b/supervisor.js). Production has
// no loopback or fixture switch: this module replaces the supervisor's import of ./network/lease-gas-runtime.mjs only
// when test/helpers/linux-runtime-hook.mjs is loaded (NODE_OPTIONS --import, test processes only). Everything else -
// the reviewed-record parser, bindings, quorum authority, signing, relays and receipt verification - runs for real.
import * as real from "../../shadow-b/network/lease-gas-runtime.mjs";
const ttlSec = Number(process.env.TEST_LEASE_FIXTURE_TTL_SEC || 300);
export const leaseGasConfigured = real.leaseGasConfigured;
export const loadLeaseGasConfig = (options) => real.loadLeaseGasConfig({ ...options, allowLoopbackHttp: true, rpcTimeoutMs: 2000 });
export const configuredLeaseSender = (options) => real.configuredLeaseSender({ ...options, confirmations: 0, requestTimeoutMs: 2000, ttlSec });
