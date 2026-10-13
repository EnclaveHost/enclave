// build-bundle.mjs -- the agent's JavaScript for a phone that hosts on its own (STANDALONE.md), as AgentService installs it
// from assets/agent/: standalone.mjs (the host agent, the co-signer, enrollment), privacy-agent.mjs and
// windows-circuit-worker.mjs (the Enclave network, as network/build.mjs bundles them), build.json (this directory: the
// public constants -- relay, chain, the release key's authority, the runtime, Google's roots, the checkers) and the
// host VM's idle component (cpu-probe).
//   node shielded/anchor/avf/standalone/build-bundle.mjs <out dir> <idle component .wasm>
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "../../../..");
const [out, idle] = process.argv.slice(2);
if (!out || !idle || !fs.existsSync(idle)) { console.error("usage: build-bundle.mjs <out dir> <idle component .wasm>"); process.exit(2); }
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const bundle = (entry, file) => build({ entryPoints: [entry], outfile: path.join(out, file), bundle: true, platform: "node", format: "esm", target: "node22",
  logLevel: "warning", banner: { js: 'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);' } });
await bundle(path.join(here, "../runner/standalone.mjs"), "standalone.mjs");
await bundle(path.join(repo, "network/privacy-agent.mjs"), "privacy-agent.mjs");
await bundle(path.join(repo, "network/windows-circuit-worker.mjs"), "windows-circuit-worker.mjs");
fs.copyFileSync(path.join(here, "build.json"), path.join(out, "build.json"));
const bytes = fs.readFileSync(idle);
if (bytes.subarray(0, 4).toString("binary") !== "\0asm") { console.error("the idle component is not WebAssembly"); process.exit(2); }
fs.writeFileSync(path.join(out, "idle-app.wasm"), bytes);
for (const f of fs.readdirSync(out).sort()) console.log(`${f}  ${fs.statSync(path.join(out, f)).size} B  ${crypto.createHash("sha256").update(fs.readFileSync(path.join(out, f))).digest("hex").slice(0, 16)}`);
