// Test-only: a SCRIPTED app-funded lease sender in place of the shipped runtime bundle, for the Windows host's renewal
// SCHEDULING (test/windows-node-lease-renewal-keeper.test.mjs). chain.mjs's own leaseSend runs unchanged - its release-journal
// holds, the operator's one serialized send queue and the "this host's ETH is never used instead" wrapper - and the release
// journal is the shipped bundle's. Only claim/renew/release/renewLeadMs answer from globalThis.scriptedLeaseSender.
import * as real from "../../windows/node/lease-gas-runtime.bundle.mjs";
export const openReleaseJournal = real.openReleaseJournal;
export const leaseGasConfigured = () => true;
export const loadLeaseGasConfig = () => ({});
export const configuredLeaseSender = () => globalThis.scriptedLeaseSender;
