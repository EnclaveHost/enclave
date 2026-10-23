// Frozen public expectations for the custody-canary-proof publication (work/custody-proof-app-20261023 PUBLISH.md):
//   1. upload: the administrator signs exactly `enclave-upload:<component sha256>:<expiry>` (personal_sign, MetaMask);
//      THIS local server trades it for an upload token at the relay and posts the ONE pinned file to the gateway;
//   2. storage check: the gateway's answer must be the pinned CID, and the bytes fetched back by that CID must hash to
//      the pinned sha256 before publishing is possible;
//   3. publish: EnclaveAppCatalog(0x18419…).publishVersion(...) from the administrator, prepared by the vendored,
//      reviewed publish prepare (vendor/publish.mjs = custody-proof-app ad81dd5 publish/lib/publish.mjs, byte-identical),
//      handed to MetaMask, verified on two providers.
// Tests use fixtureTrust() with the SAME shape; only URLs, the component file, timeouts and (for the upload signature
// only) the administrator key's address differ.
import { PRODUCTION as PUBLISH, COMPONENT } from "./vendor/publish.mjs";

export const PRODUCTION = Object.freeze({
  chainId: 8453,
  admin: PUBLISH.publisher,                                     // 0x0b2d…: catalog owner = book owner; signs in MetaMask
  catalog: PUBLISH.catalog,
  component: Object.freeze({
    file: "/home/steven/Documents/Codex/2026-10-18/wo/work/custody-proof-app-20261023/out/custody_canary_proof.wasm",
    size: COMPONENT.size,                                       // 101222: the read is capped at exactly this many bytes
    sha256: COMPONENT.sha256,
    cid: COMPONENT.cid,
  }),
  upload: Object.freeze({
    tokenUrl: "https://api.enclave.host/v1/apps/upload-token",  // relay/api-relay.js: recovers the signer, mints an HMAC token
    addUrl: "https://ipfs.enclave.host/add-wasm",                // scripts/ipfs-add-gateway.py: verifies the token, pins via Kubo
    fetchUrl: "https://ipfs.enclave.host/ipfs/",                 // public NoFetch gateway path: serves only what was pinned
    expirySec: 300,                                             // the CLI's window; the relay accepts <= 600, the gateway <= 900
    timeoutMs: 30_000,
  }),
  rpcs: PUBLISH.rpcs,
  rpcTimeoutMs: 10_000,
  deadlineMs: 90_000,
  confirmations: 2n,
  // reconcile: an attempt handed to the wallet without a hash may be reset only after this long (the wallet may still
  // hold the request; the page tells the administrator to reject it in MetaMask first)
  reconcileMinAgeMs: 300_000,
});
export const PORT = 39675;                                      // NOT the factory handoff's 39672
