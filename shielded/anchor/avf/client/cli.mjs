// cli.mjs -- the installed pVM client, command line (client/DESIGN.md; LAB, not production). Built reproducibly into ONE
// file (client/build.sh -> client/dist/pvm-client.mjs); it never loads or evaluates code it fetches.
//   pvm-client install --policy-key-fp FP --serial-floor N --release-key-fp FP [--state DIR]
//   pvm-client run --policy SRC --relay URL --app HEX [--path P] [--whole] [--cancel K] [--state DIR]
//   pvm-client update --manifest SRC --artifact SRC [--state DIR] [--install-dir DIR]
//   pvm-client staged [--state DIR]
//   pvm-client state [--state DIR]        the committed state and its generation
//   pvm-client version
// --state names the state's location: an existing 0.1.0 state FILE (its log is <file>.d beside it) or a directory (made
// on install). SRC is a file or an http(s) URL -- any carrier; what it delivers is verified. The state (default
// $XDG_CONFIG_HOME/enclave-pvm-client/state.d) is the client's durable, monotonic memory (src/store-file.js): the anchor,
// the newest policy serial and digest, the release key, the staged update. Every change to it is a cross-process
// compare-and-swap committed BEFORE anything is sent; a 0.1.0 state FILE given as --state is imported into <file>.d once.
// `run` prints one JSON line per token line ({"line":...}) and ends with {"result":...}; exit 0 only on a complete answer.
// `update` verifies a signed, countersigned manifest and the delivered bytes, publishes them beside this client under a
// content-addressed name, pvm-client-<version>-<sha256>.mjs (never replacing a file: src/update.js), and commits that
// version as staged -- only if it is newer than anything staged or running; the same artifact again changes nothing.
// The running process never imports them; `staged` reports what the next start should run and whether its bytes still
// match.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { initialState, CLIENT_VERSION } from "./src/trust.js";
import { stageUpdate } from "./src/update.js";
import { FileStore, StoreError } from "./src/store-file.js";
import { connect } from "./src/client.js";

const argv = process.argv.slice(2), cmd = argv[0];
const arg = (k, d = null) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
async function fetchBytes(src) {
  if (/^https?:\/\//.test(src)) { const r = await fetch(src, { cache: "no-store" }); if (!r.ok) throw new Error(`${src}: ${r.status}`); return new Uint8Array(await r.arrayBuffer()); }
  return new Uint8Array(fs.readFileSync(src));
}
const fetchJson = async (src) => JSON.parse(new TextDecoder().decode(await fetchBytes(src)));

function openStore() {
  const given = arg("--state", path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "enclave-pvm-client", "state.d"));
  let st = null; try { st = fs.statSync(given); } catch {}
  if (st && st.isFile()) {   // a 0.1.0 state file: import it once, as generation 1 of <file>.d
    const store = new FileStore(given + ".d");
    if (!store.latest()) {
      const legacy = JSON.parse(fs.readFileSync(given, "utf8"));
      const r = store.init(legacy);
      out({ imported: given, into: store.dir, ok: r.ok || undefined });
    }
    return store;
  }
  return new FileStore(given);
}

async function main() {
  if (cmd === "version") return out({ client: "enclave-pvm-client", version: CLIENT_VERSION, lab: "NOT PRODUCTION" }), 0;
  const store = openStore();
  if (cmd === "install") {
    const s = initialState({ policyKeyFp: arg("--policy-key-fp"), serialFloor: Number(arg("--serial-floor")), releaseKeyFp: arg("--release-key-fp") });
    const r = store.init({ ...s, staged: null });
    if (!r.ok) return out({ refused: r.reason }), 2;
    return out({ installed: store.dir, anchor: { policyKeyFp: s.policyFp, serialFloor: s.serial, releaseKeyFp: s.releaseFp } }), 0;
  }
  if (!store.latest()) return out({ refused: `no client installed at ${store.dir} (run install with the anchors you were given out of band)` }), 2;
  if (cmd === "run") {
    let policyEnv;
    try { policyEnv = await fetchJson(arg("--policy")); } catch (e) { return out({ result: { step: "policy", refused: `no policy: ${e.message}`, sent: false } }), 1; }
    const r = await connect({ relay: arg("--relay"), policyEnv, store, appId: arg("--app"), path: arg("--path", "/"), stream: !argv.includes("--whole"),
                              cancelAfter: Number(arg("--cancel", "0")), label: arg("--label", "cli"), onLine: (line) => out({ line }),
                              onCommitted: (c) => out({ committed: c }) });
    out({ result: { ...r.result, lines: undefined } });
    return r.result.complete === true || (r.result.status === 200 && r.result.mode !== "stream") ? 0 : 1;
  }
  if (cmd === "update") {
    let env, bytes;
    try { env = await fetchJson(arg("--manifest")); bytes = await fetchBytes(arg("--artifact")); } catch (e) { return out({ update: { ok: false, reasons: [`not delivered: ${e.message}`] } }), 1; }
    const r = await stageUpdate(store, env, bytes, { dir: arg("--install-dir", path.dirname(process.argv[1])) });
    if (!r.ok) return out({ update: { ok: false, reasons: [r.reason] } }), 1;
    return out({ update: { ok: true, version: r.version, staged: r.file, gen: r.gen, ...(r.already ? { already: true } : {}) } }), 0;
  }
  if (cmd === "state") {   // the committed state, for the user and for black-box tests (so they never read the layout)
    const l = store.latest();
    return out({ state: l.state, gen: l.gen, dir: store.dir }), 0;
  }
  if (cmd === "staged") {
    const s = store.latest().state.staged;
    if (!s) return out({ staged: null }), 0;
    const f = path.join(arg("--install-dir", path.dirname(process.argv[1])), s.file);
    let ok = false; try { ok = createHash("sha256").update(fs.readFileSync(f)).digest("hex") === s.sha256; } catch {}
    return out({ staged: { ...s, path: f, bytesMatch: ok } }), ok ? 0 : 1;
  }
  out({ refused: `unknown command ${JSON.stringify(cmd)}: install | run | update | staged | state | version` }); return 2;
}
main().then((rc) => process.exit(rc), (e) => { out({ error: e instanceof StoreError ? `state: ${e.message}` : e.message }); process.exit(2); });
