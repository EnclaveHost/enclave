// Page assets (static text only; the CSP allows nothing inline).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export const TEXT = Object.freeze({
  STAGE: "canary-publish",
  TITLE: "Upload and publish the custody canary proof app",
  LEDE: "Two administrator approvals in MetaMask, in order. 1: sign the upload authorization message (no transaction, no ETH). This local server then uploads the ONE pinned component and checks that the gateway's CID and the bytes it serves back are exactly the pinned ones. 2: only then, the catalog transaction publishVersion for a NEW, free listing custody-canary-proof 0.1.0, approved on publish because the administrator owns the catalog.",
  UPLOAD: "The upload authorization lets the relay mint a token for exactly these bytes (sha256 below) until the expiry shown; it is not a transaction and moves no funds. It is spent against the administrator's daily upload budget. The signature is used once by this local server and is never stored or logged.",
  CALL: "EnclaveAppCatalog.publishVersion(custody-canary-proof, Custody canary proof, <canary-only description>, 0.1.0, <CID>, [0, 0, 128, 10], no ports, {\"wasi\":\"0.2\"}, fee 0)",
  EFFECT: "Effect: a NEW catalog app 0x85c5ed4ce282f8c1f434dd600d902d8738a6d8a54b71497dfaa95a1f635813a0 (version index 0) is listed and approved. No existing listing is changed or replaced; nothing is deployed; no secret, custody policy, committee or address-book entry changes. Canary use only: never stage real or user secrets for this app.",
  ROLLBACK: "Rollback: the catalog owner can later yank the version or reject it (setApproval); the listing record itself stays in the catalog's history.",
  DONE: "The canary is listed and approved at version index 0, free. Nothing was deployed.",
});
const read = (f) => fs.readFileSync(path.join(here, f), "utf8");
export function assets() {
  for (const [k, v] of Object.entries(TEXT)) if (/[<>&]/.test(v.replace(/<canary-only description>|<CID>/g, ""))) throw Error("page text " + k + " must be plain text");
  const esc = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = read("stage.html").replace(/\{\{(\w+)\}\}/g, (_m, k) => { if (!(k in TEXT)) throw Error("missing page text " + k); return esc(TEXT[k]); });
  return { "/": { type: "text/html", body: html }, "/app.js": { type: "text/javascript", body: read("app.js") },
    "/style.css": { type: "text/css", body: read("style.css") }, "/app.css": { type: "text/css", body: read("app.css") } };
}
