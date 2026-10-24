// Page assets (static text only; the CSP allows nothing inline).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export const TEXT = Object.freeze({
  STAGE: "activate",
  TITLE: "Set the original address book's sessionVaultFactory",
  CALL: "EnclaveAddressBook.set(sessionVaultFactory, original SessionVault factory 0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c)",
  LEDE: "Sets ONE shared entry of the original address book: sessionVaultFactory, from zero to the original SessionVault factory. Zero ETH. Nothing else in the book changes; the separate secretVaultV2 entry is NOT part of this transaction.",
  EFFECT: "Effect: both original custody vaults (v1 and v2), and every consumer that reads this book entry without its own pin, start resolving a deployment held by a SessionVault of this factory to that vault's owner wallet. At the checked block that applies to 4 deployments held by the administrator's SessionVault 0xb794c4dd0e1c5e6b72281799f282bfde7654345d; none of them has a custody policy, so no existing policy changes. The server re-checks every current deployment before MetaMask is asked and refuses if any existing policy would be affected.",
  ROLLBACK: "No simple rollback: once policies are created for SessionVault-held deployments, setting this entry back to zero would leave those policies updatable by nobody but a claimant whose claim destroys the stored secrets. Treat this as a one-way change.",
  DONE: "The original address book's sessionVaultFactory entry is the original SessionVault factory. secretVaultV2 and every other entry are unchanged.",
});
const read = (f) => fs.readFileSync(path.join(here, f), "utf8");
export function assets() {
  for (const [k, v] of Object.entries(TEXT)) if (/[<>&"]/.test(v)) throw Error("page text " + k + " must be plain text");
  const html = read("stage.html").replace(/\{\{(\w+)\}\}/g, (_m, k) => { if (!(k in TEXT)) throw Error("missing page text " + k); return TEXT[k]; });
  return { "/": { type: "text/html", body: html }, "/app.js": { type: "text/javascript", body: read("app.js") },
    "/style.css": { type: "text/css", body: read("style.css") }, "/app.css": { type: "text/css", body: read("app.css") } };
}
