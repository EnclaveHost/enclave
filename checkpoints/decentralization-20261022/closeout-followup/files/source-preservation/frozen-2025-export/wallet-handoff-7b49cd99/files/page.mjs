// Page assets for one stage (static text only; the CSP allows nothing inline).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export const TEXT = Object.freeze({
  fund: { STEP: "OPTIONAL STEP 1 OF 2", TITLE: "Fund the metal0 operator's one proposal", CALL: "Plain ETH transfer to the existing metal0 registry operator (no calldata)",
    LEDE: "Optional. Sends exactly 0.000005 ETH from the Enclave administrator to the existing metal0 registry operator, which currently holds too little ETH to pay for its single proposeOwner(metal0, administrator) transaction.",
    SCOPE: "The server refuses to prepare this again once the operator holds 0.000005 ETH, once any proposal or owner exists, when the operator could already pay, or while any administrator or operator transaction is pending. The operator's proposal itself is sent separately by root.",
    DONE: "The operator was funded exactly once. Root sends the operator's proposal separately; acceptance (step 2) becomes available only after that proposal is two blocks deep." },
  accept: { STEP: "STEP 2 OF 2", TITLE: "Accept ownership of host metal0", CALL: "acceptOwner(metal0) on the active EnclaveHostOwnership contract",
    LEDE: "Accepts the metal0 operator's proposal that names the Enclave administrator as metal0's host owner. Zero ETH. Available only after the operator has proposed exactly this administrator and the proposal is two blocks deep; root sends that proposal separately.",
    SCOPE: "If the proposal does not exist yet, the review button reports NOT READY and MetaMask is not asked. After acceptance: owner = administrator, revision 1, no host policy.",
    DONE: "The Enclave administrator owns host metal0 (revision 1, no host policy). Address-book activation remains a separate, later step." },
});
const read = (f) => fs.readFileSync(path.join(here, f), "utf8");
export function assetsFor(stage) {
  const text = { ...TEXT[stage], STAGE: stage };
  for (const [k, v] of Object.entries(text)) if (/[<>&"]/.test(v)) throw Error("page text " + k + " must be plain text");
  const html = read("stage.html").replace(/\{\{(\w+)\}\}/g, (_m, k) => { if (!(k in text)) throw Error("missing page text " + k); return text[k]; });
  return { "/": { type: "text/html", body: html }, "/app.js": { type: "text/javascript", body: read("app.js") },
    "/style.css": { type: "text/css", body: read("style.css") }, "/app.css": { type: "text/css", body: read("app.css") } };
}
