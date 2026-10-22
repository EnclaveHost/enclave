// Where things are, in either layout:
//   workspace: <ws>/work/ipns-production-cutover (this tool), <ws>/work/ipns-release-anchor, <ws>/work/enclave
//   repository: <repo>/tools/ipns-cutover (this tool), <repo>/tools/ipns-release-anchor, <repo> itself
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inRepo = existsSync(join(TOOL, "../../cli/enclave.mjs"));
export const REPO = inRepo ? resolve(TOOL, "../..") : resolve(TOOL, "../enclave");
export const ANCHOR = resolve(TOOL, "../ipns-release-anchor");
// the publisher component to test or publish: IPNS_PUBLISHER_WASM, else the workspace's sibling build
export const PUBLISHER_WASM = process.env.IPNS_PUBLISHER_WASM
  ?? resolve(TOOL, inRepo ? "../../../enclave-apps" : "../enclave-apps", "ipns-publisher/target/wasm32-wasip2/release/ipns-publisher.wasm");
export const WORKSPACE_PROFILE = resolve(TOOL, "../../outputs/authority-profile/network-profile-base.json");
