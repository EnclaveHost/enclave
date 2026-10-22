// Independent host access for the enclave CLI: owner management (status/logs/restart/host attestation document) through
// network/management-client.mjs, and app attestation through the native client's own SNP verification. These are two
// different principals: the management endpoint is the HOST, authenticated by the record its current runnerOperator
// signed and by its TLS key; the app guest is authenticated only by a fresh SNP proof bound to its TLS key. A document a
// host returns is host-reported data and is never presented as an independent SNP verification.
import fs from "node:fs";
import path from "node:path";
import { createPrivateKey } from "node:crypto";
import { ManagementClient, sessionRequestSigner } from "../network/management-client.mjs";
import { LeaseReader } from "../network/lease-reader.mjs";
import { NativeClient } from "../network/native-client.mjs";

const ZERO = "0x" + "0".repeat(40);

/** The authority pins the network modules take (deployments, registry, connectivity, sessionVaultFactory). */
export function networkAuthorities(trust) {
  const p = trust.pins;
  return { deployments: p.deployments, registry: p.registry, sessionVaultFactory: p.sessionVaultFactory || ZERO,
    connectivity: trust.profile ? trust.profile.contracts.connectivity.address : ZERO };
}

/** The session's P-256 key from a FileStore record or ENCLAVE_SESSION export (never a browser, non-exportable key). */
export function sessionKey(rec) {
  if (!rec?.pkcs8 || !rec.handle?.vault || !rec.handle?.sid) throw new Error("management needs an open, file-stored session (enclave session list)");
  return createPrivateKey({ key: Buffer.from(rec.pkcs8, "base64url"), format: "der", type: "pkcs8" });
}

/** A management client whose lease reads go through the same agreeing RPC clients as the rest of independent mode. */
export async function managementClient({ trust, chain, deploymentId, directories, stateDir, rec, now = Date.now, hostAdmission = null }) {
  if (!Array.isArray(directories) || !directories.length || directories.length > 8)
    throw new Error("management needs --directories with 1 to 8 literal-IP directory origins");
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) throw new Error("management needs --state-dir ABSOLUTE_DIR (it keeps per-runner rollback floors)");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const authorityPins = networkAuthorities(trust);
  const { leaseReaderClients } = await import("./independent.mjs");
  const reader = new LeaseReader({ clients: leaseReaderClients(chain), chainId: chain.chainId, addressBook: ZERO, authorityPins,
    includeHostPayout: true, maxBlockAgeMs: Math.max(1000, Math.min(trust.maxBlockAgeMs, 120000)), confirmations: Math.max(1, trust.confirmations), now });
  const signer = sessionRequestSigner({ vault: rec.handle.vault, sid: rec.handle.sid, privateKey: sessionKey(rec), now });
  return new ManagementClient({ deploymentId, chainId: chain.chainId, authorityPins, directories, stateDir, signer, reader, now, hostAdmission });
}

/**
 * App attestation without Enclave: one HEAD request through the native client, which sends nothing until a fresh SNP
 * proof on a signed route verifies against the caller's own trust profile and the TLS key matches the attested key.
 * The trust profile must name this deployment and the same ledger and registry the CLI pins.
 */
export async function nativeAttest({ profileFile, deploymentId, trust, requestPath = "/", hostAdmission = null }) {
  let profile;
  try { profile = JSON.parse(fs.readFileSync(profileFile, "utf8")); }
  catch (e) { throw new Error(`cannot read the native trust profile ${profileFile}: ${e.message}`); }
  if (profile?.deploymentId !== deploymentId) throw new Error("the native trust profile names a different deployment");
  const a = networkAuthorities(trust);
  for (const k of ["deployments", "registry"])
    if (String(profile.authorityPins?.[k] || "").toLowerCase() !== a[k]) throw new Error(`the native trust profile's ${k} pin differs from this CLI's pins`);
  const client = new NativeClient(profile, { hostAdmission });
  const r = await client.request({ method: "HEAD", path: requestPath });
  return { status: r.status, route: r.route, proof: r.proof, expectation: r.expectation, leaseBlock: r.leaseBlock, validUntil: r.validUntil };
}
