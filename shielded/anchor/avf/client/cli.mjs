// cli.mjs -- the installed pVM client, command line (client/DESIGN.md; LAB, not production). Built reproducibly into ONE
// file (client/build.sh -> client/dist/pvm-client.mjs); it never loads or evaluates code it fetches.
//   pvm-client install --policy-key-fp FP --serial-floor N --release-key-fp FP [--state FILE]
//   pvm-client run --policy SRC --relay URL --app HEX [--path P] [--whole] [--cancel K] [--state FILE]
//   pvm-client update --manifest SRC --artifact SRC [--state FILE] [--install-dir DIR]
//   pvm-client version
// SRC is a file or an http(s) URL -- any carrier; what it delivers is verified. The state file (default
// $XDG_CONFIG_HOME/enclave-pvm-client/state.json) is the client's memory: the anchor, the newest policy serial and digest.
// `run` prints one JSON line per token line ({"line":...}) and ends with {"result":...}; exit 0 only on a complete answer.
// `update` verifies a signed, countersigned manifest and the delivered bytes, and writes them BESIDE this client as
// <dir>/pvm-client.mjs.next for the next start -- it never imports them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialState, verifyUpdate, CLIENT_VERSION } from "./src/trust.js";
import { connect } from "./src/client.js";

const argv = process.argv.slice(2), cmd = argv[0];
const arg = (k, d = null) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const stateFile = arg("--state", path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "enclave-pvm-client", "state.json"));
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; } };
const writeState = (s) => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile + ".tmp", JSON.stringify(s) + "\n"); fs.renameSync(stateFile + ".tmp", stateFile); };
async function fetchBytes(src) {
  if (/^https?:\/\//.test(src)) { const r = await fetch(src, { cache: "no-store" }); if (!r.ok) throw new Error(`${src}: ${r.status}`); return new Uint8Array(await r.arrayBuffer()); }
  return new Uint8Array(fs.readFileSync(src));
}
const fetchJson = async (src) => JSON.parse(new TextDecoder().decode(await fetchBytes(src)));

async function main() {
  if (cmd === "version") return out({ client: "enclave-pvm-client", version: CLIENT_VERSION, lab: "NOT PRODUCTION" }), 0;
  if (cmd === "install") {
    if (readState()) return out({ refused: `a client is already installed at ${stateFile}: anchors are not replaced in place (reinstall to a new state file)` }), 2;
    const s = initialState({ policyKeyFp: arg("--policy-key-fp"), serialFloor: Number(arg("--serial-floor")), releaseKeyFp: arg("--release-key-fp") });
    writeState(s); return out({ installed: stateFile, anchor: { policyKeyFp: s.policyFp, serialFloor: s.serial, releaseKeyFp: s.releaseFp } }), 0;
  }
  const state = readState();
  if (!state) return out({ refused: `no client installed at ${stateFile} (run install with the anchors you were given out of band)` }), 2;
  if (cmd === "run") {
    let policyEnv;
    try { policyEnv = await fetchJson(arg("--policy")); } catch (e) { return out({ result: { step: "policy", refused: `no policy: ${e.message}`, sent: false } }), 1; }
    const r = await connect({ relay: arg("--relay"), policyEnv, state, appId: arg("--app"), path: arg("--path", "/"), stream: !argv.includes("--whole"),
                              cancelAfter: Number(arg("--cancel", "0")), label: arg("--label", "cli"), onLine: (line) => out({ line }) });
    if (r.state !== state) writeState(r.state);   // the newest policy this client accepted (rollback and equivocation memory)
    out({ result: { ...r.result, lines: undefined } });
    return r.result.complete === true || r.result.status === 200 && r.result.mode !== "stream" ? 0 : 1;
  }
  if (cmd === "update") {
    let env, bytes;
    try { env = await fetchJson(arg("--manifest")); bytes = await fetchBytes(arg("--artifact")); } catch (e) { return out({ update: { ok: false, reasons: [`not delivered: ${e.message}`] } }), 1; }
    const u = await verifyUpdate(env, bytes, { state, currentVersion: CLIENT_VERSION, artifact: "pvm-client.mjs" });
    if (!u.ok) return out({ update: { ok: false, reasons: u.reasons } }), 1;
    const dir = arg("--install-dir", path.dirname(process.argv[1]));
    fs.writeFileSync(path.join(dir, "pvm-client.mjs.next"), bytes);   // for the NEXT start; never imported by this process
    fs.writeFileSync(path.join(dir, "pvm-client.mjs.next.manifest.json"), JSON.stringify(env) + "\n");
    writeState(u.state);
    return out({ update: { ok: true, reasons: u.reasons, version: u.manifest.version, staged: path.join(dir, "pvm-client.mjs.next") } }), 0;
  }
  out({ refused: `unknown command ${JSON.stringify(cmd)}: install | run | update | version` }); return 2;
}
main().then((rc) => process.exit(rc), (e) => { out({ error: e.message }); process.exit(2); });
