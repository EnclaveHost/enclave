// cli.mjs -- the installed pVM client, command line (client/DESIGN.md; LAB, not production). Built reproducibly into ONE
// file (client/build.sh -> client/dist/pvm-client.mjs). It never loads or evaluates fetched code in its own process; an
// update runs only after an explicit `activate`, in a child fed the verified bytes from memory (src/activate.js).
//   pvm-client install --policy-key-fp FP --serial-floor N --release-key-fp FP [--state DIR]
//   pvm-client run --policy SRC --relay URL --app HEX [--path P] [--whole] [--cancel K] [--state DIR] [--install-dir DIR]
//   pvm-client update --manifest SRC --artifact SRC [--state DIR] [--install-dir DIR]
//   pvm-client activate [--state DIR] [--install-dir DIR]   run the staged update from now on (explicit; never automatic)
//   pvm-client staged [--state DIR] [--install-dir DIR]    the staged and the active update, and whether their bytes match
//   pvm-client state [--state DIR]                         the committed state and its generation
//   pvm-client version
// --state names the state's location: an existing 0.1.0 state FILE (its log is <file>.d beside it) or a directory (made
// on install). SRC is a file or an http(s) URL -- any carrier; what it delivers is verified. The state (default
// $XDG_CONFIG_HOME/enclave-pvm-client/state.d) is the client's durable, monotonic memory (src/store-file.js): the anchor,
// the newest policy serial and digest, the release key, the staged and the active update. Every change to it is a
// cross-process compare-and-swap committed BEFORE anything is sent; a 0.1.0 state FILE given as --state is imported into
// <file>.d once. --install-dir defaults to this file's directory; a client fed over stdin has none and must be given it.
// `run` prints one JSON line per token line ({"line":...}) and ends with {"result":...}; exit 0 only on a complete answer.
// `update` verifies a signed, countersigned manifest and the delivered bytes, publishes them beside this client under a
// content-addressed name, pvm-client-<version>-<sha256>.mjs (never replacing a file: src/update.js), and commits that
// version as staged -- only if it is newer than anything staged, active or running; the same artifact again changes
// nothing. Nothing runs what `update` stages until `activate` (src/activate.js): this file is the launcher; it runs every
// command itself, except `run` when a newer version is active, which executes that version's verified bytes from memory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { initialState, semverCmp, CLIENT_VERSION } from "./src/trust.js";
import { stageUpdate } from "./src/update.js";
import { activateStaged, launchActive, DELEGATED } from "./src/activate.js";
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
// fed over stdin (argv[1] "-"), this client has no path of its own: nothing may be derived from one
const fromFile = !!process.argv[1] && process.argv[1] !== "-";
const installDir = () => arg("--install-dir") || (fromFile ? path.dirname(process.argv[1]) : null);
const NO_DIR = "--install-dir is required: this client was not started from a file";
// one hop: a launcher hands a newer active version its bytes over stdin with ENCLAVE_PVM_CLIENT_DELEGATED=<version>:<sha256>;
// that child runs `run` itself, whatever the state says by then. A marker on a client started from a file is ignored.
const marker = !fromFile && process.env[DELEGATED] ? process.env[DELEGATED].split(":")[0] : null;

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
  if (marker !== null && marker !== CLIENT_VERSION) return out({ error: `delegated as ${marker}, but this client is ${CLIENT_VERSION}: refusing` }), 2;
  if (marker !== null && cmd !== "run") return out({ error: `a delegated client runs only \`run\`, not ${JSON.stringify(cmd)}` }), 2;
  if (cmd === "version") return out({ client: "enclave-pvm-client", version: CLIENT_VERSION, lab: "NOT PRODUCTION" }), 0;
  const store = openStore();
  if (cmd === "install") {
    const s = initialState({ policyKeyFp: arg("--policy-key-fp"), serialFloor: Number(arg("--serial-floor")), releaseKeyFp: arg("--release-key-fp") });
    const r = store.init({ ...s, staged: null, active: null });
    if (!r.ok) return out({ refused: r.reason }), 2;
    return out({ installed: store.dir, anchor: { policyKeyFp: s.policyFp, serialFloor: s.serial, releaseKeyFp: s.releaseFp } }), 0;
  }
  const cur = store.latest();
  if (!cur) return out({ refused: `no client installed at ${store.dir} (run install with the anchors you were given out of band)` }), 2;
  const active = cur.state.active || null;
  if (cmd === "run") {
    if (marker === null && active && semverCmp(active.version, CLIENT_VERSION) > 0) {   // the launcher: the newer active version runs it
      const dir = installDir(); if (!dir) return out({ result: { step: "launch", refused: NO_DIR, sent: false } }), 2;
      const r = await launchActive(active, { dir, stateDir: store.dir, args: argv.slice(1) });
      if (r.refused) return out({ result: r.refused }), 2;
      if (r.error) return out({ error: r.error }), 2;
      if (r.sig) return out({ error: `the active client ${active.version} ended by signal ${r.sig}` }), 2;
      return r.code;
    }
    let policyEnv;
    try { policyEnv = await fetchJson(arg("--policy")); } catch (e) { return out({ result: { step: "policy", refused: `no policy: ${e.message}`, sent: false, clientVersion: CLIENT_VERSION } }), 1; }
    const r = await connect({ relay: arg("--relay"), policyEnv, store, appId: arg("--app"), path: arg("--path", "/"), stream: !argv.includes("--whole"),
                              cancelAfter: Number(arg("--cancel", "0")), label: arg("--label", "cli"), onLine: (line) => out({ line }),
                              onCommitted: (c) => out({ committed: c }) });
    out({ result: { ...r.result, lines: undefined, clientVersion: CLIENT_VERSION } });   // which client ran it: the launcher, or the version it delegated to
    return r.result.complete === true || (r.result.status === 200 && r.result.mode !== "stream") ? 0 : 1;
  }
  if (cmd === "update") {
    const dir = installDir(); if (!dir) return out({ update: { ok: false, reasons: [NO_DIR] } }), 2;
    let env, bytes;
    try { env = await fetchJson(arg("--manifest")); bytes = await fetchBytes(arg("--artifact")); } catch (e) { return out({ update: { ok: false, reasons: [`not delivered: ${e.message}`] } }), 1; }
    const r = await stageUpdate(store, env, bytes, { dir });   // the floor: this client's version, and what is staged or active (src/update.js)
    if (!r.ok) return out({ update: { ok: false, reasons: [r.reason] } }), 1;
    return out({ update: { ok: true, version: r.version, staged: r.file, gen: r.gen, ...(r.already ? { already: true } : {}) } }), 0;
  }
  if (cmd === "activate") {
    const dir = installDir(); if (!dir) return out({ activate: { ok: false, step: "file", reasons: [NO_DIR] } }), 2;
    const r = await activateStaged(store, { dir });
    return out({ activate: r }), r.ok ? 0 : 1;
  }
  if (cmd === "state") {   // the committed state, for the user and for black-box tests (so they never read the layout)
    return out({ state: cur.state, gen: cur.gen, dir: store.dir }), 0;
  }
  if (cmd === "staged") {   // what is staged and what is active, and whether the bytes on disk are still the recorded ones
    const dir = installDir(); if (!dir) return out({ refused: NO_DIR }), 2;
    const check = (rec) => {
      if (!rec) return null;
      const f = path.join(dir, rec.file);
      let ok = false; try { ok = createHash("sha256").update(fs.readFileSync(f)).digest("hex") === rec.sha256; } catch {}
      return { ...rec, path: f, bytesMatch: ok };
    };
    const s = check(cur.state.staged || null), a = check(active);
    return out({ staged: s, active: a }), (s && !s.bytesMatch) || (a && !a.bytesMatch) ? 1 : 0;
  }
  out({ refused: `unknown command ${JSON.stringify(cmd)}: install | run | update | activate | staged | state | version` }); return 2;
}
main().then((rc) => process.exit(rc), (e) => { out({ error: e instanceof StoreError ? `state: ${e.message}` : e.message }); process.exit(2); });
