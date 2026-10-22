// Writes files.lock.json: the sha256 of every file serve.mjs loads, own and reused (reused files are read, never changed).
//   node make-lock.mjs   (then review; serve.mjs refuses unless --approved-files names this file's sha256)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  "serve.mjs", "upload-diagnostic.mjs", "trust.mjs", "handoff-plan.mjs", "chain.mjs", "server.mjs", "app.js", "index.html",
  "pins/version-config-v4.json", "pins/envelope-current.json", "artifact/enclavedns-0.1.5.wasm",
  // reused unchanged (reviewed site activation, enrollment and lease-gas modules, and what they load)
  "../../site-host-live-publish/handoff/site-upload.mjs", "../../site-host-live-publish/handoff/site-chain.mjs", "../../site-host-live-publish/handoff/site-trust.mjs",
  "../../lease-enrollment-signing/trust.mjs", "../../lease-enrollment-signing/chain.mjs", "../../lease-enrollment-signing/handoff-server.mjs", "../../lease-enrollment-signing/queue.css",
  "../../lease-enrollment-signing/plan.mjs",
  "../../lease-gas-wallet-signing/trust.mjs", "../../lease-gas-wallet-signing/stages.mjs", "../../lease-gas-wallet-signing/rpc-clients.mjs", "../../metamask-bridge/style.css",
  "../../lease-gas-wallet-signing/verify-reserve.mjs", "../../lease-gas-wallet-signing/artifacts.mjs", "../../lease-gas-wallet-signing/request.mjs",
  "../../enclave/scripts/site-release/unixfs.mjs", "../../enclave/contracts/EnclaveAppCatalog.abi.json", "../../enclave/contracts/EnclaveDeployments.abi.json",
];
const files = Object.fromEntries(FILES.map((f) => [f, createHash("sha256").update(fs.readFileSync(path.resolve(here, f))).digest("hex")]));
const text = JSON.stringify({ format: "enclavedns-release-files/v1", files }, null, 1) + "\n";
fs.writeFileSync(path.join(here, "files.lock.json"), text);
console.log("files sha256:" + createHash("sha256").update(text).digest("hex"));
