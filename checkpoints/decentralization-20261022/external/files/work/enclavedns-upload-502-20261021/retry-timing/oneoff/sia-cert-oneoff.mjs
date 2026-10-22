// PREPARED FOR ROOT REVIEW, NOT RUN. One bounded certificate pass for ONE Shield partition, through the node's own
// production code, without restarting anything:
//   createHvCertPass (hvcert.mjs) -> ensureGuestCert -> IsolationManagerClient (read-only GET) / data plane / hvJudge
//   with the runtime pin -> the guest's CSR for its EXISTING verified key -> apptls.requestCert (operator opSig) ->
//   leaf checked against that key and name -> installed into the guest. A guest already serving a valid one is reused.
// It imports the INSTALLED modules by absolute path after checking their sha256 pins; it never imports agent.mjs.
// The operator credential is loaded only by the production loadOperator (chain.mjs), in this process; the key, the CSR
// and the signature are never printed or written. The signer signs ONLY
//   enclave-certs-issue:<name>:<registered endpoint>:<the record's transport key sha256>:<now ± 60 s>
// and at most once. Exactly one deployment record (from the node's own /v1/host/state) is passed, after every pin holds.
// It creates, retires, stops or restarts nothing.
//   node sia-cert-oneoff.mjs --check|--run --deployment 0x.. --instance hv.. --app-id <64hex> --version V --cid C
//        --owner 0x.. --expect-endpoint URL --expect-runner 0x<64hex> [--expect-runtime <64hex>] [--expect-operator 0x..]
//        [--timeout-sec 120]
// Exit: 0 installed or reused; 2 nothing installed (pending/refused: respect the printed retry); 3 timed out / unknown;
//       1 refused locally before any request (a pin, the environment or the record did not hold).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const CONTROL = "C:\\Program Files\\Enclave\\control";
// live sha256 (minipc, 2026-10-21 19:31Z, retry-timing/oneoff/live-mods.out); a different byte refuses
export const MODULE_PINS = {
  "windows/node/hvcert.mjs": "91b9f2db7eb3be98efec1594dfe95245475a0cf234d9ce6843657b37bc2b1557",
  "windows/node/apptls.mjs": "2fb25b001874488104175523dc8409b515b55c5d7922678737e463fe9ed44414",
  "windows/node/isolation-client.mjs": "8d07cb4ea105819c8f769e942c58063d20cf1289544c2afac0b9aeda0d963b7b",
  "windows/node/chain.mjs": "753818e234916190d75ddfca1f0129ecb95f456a258326598c71f8eaceb0ba00",
  "windows/node/host-identity.mjs": "ff9e46d9bcec08ff50ab04f0f4581845050b70e5c68debb64ec3cdf255822668",
  "windows/node/host-admission.bundle.mjs": "66c6e15a793b8dc4cb80f209b6ffa405c40c7d235284727384e4833576610067",
  "windows/node/lease-gas-runtime.bundle.mjs": "d2e363c5f74ae66bf4f0f6ba67890cf1ba95e1b80cc37201a9e68b6fbff5dc7f",
  "windows/node/waf.mjs": "d44da8feb6b55073e1f18264d028e3f854c85215ae3a97208ef329638c1ee94a",
  "windows/node/verification-checkpoints.mjs": "aa69b54db648fe9439f9661727b81633dd46a2cb321627e3a78f6bc8b202ff29",
  "windows/vbslike/verify/judge-hv.mjs": "bae3916e4a9ee1c3f4d67503f76b52d93febfbf356375a3321c7fe1fb9781f7f",
  "isolation/m4/guestd/supervisor-guestcert.mjs": "136c73ac6612c435f1571cf059d0171f8f93f02a7b93bc25dc55606afef41597",
  "isolation/contract/runtime.mjs": "8bb7f911c32bd992db83e1884db3c6059044338aa06ee64f9207adda25fd4b69",
  "network/rpc-identity.mjs": "74cb965ee1ae031566ac0f060e4ebdf512089cc702c0ec54c2f98113834c5d57",
  // the attestation / TLS path's transitive imports (review P1): judge-hv -> judge, boot-statements; judge -> snp-verify;
  // supervisor-guestcert -> supervisor-splice. With these the whole in-tree import closure is pinned (closure.json).
  "isolation/m2/judge.mjs": "650b931d32ef72c84459141f6deeaf0f5a7a4e8c6441ac95f47f4bd8a624f1dd",
  "isolation/m4/guestd/supervisor-splice.mjs": "dcfc95b315995750ce1c19caef9d4551fdb6735a35b7bbdbf91a54cd29b2066b",
  "relay/snp-verify.mjs": "10520dd25d6a7a40225a7076521c383fc3eb296b1f290ac6b9e9fbbd1697de91",
  "windows/vbslike/verify/boot-statements.mjs": "f34a98484a9190b08dcd3d06a3fe28f35e702e764b64d4d3eca6d9b79c5816d3",
};
const HEX64 = /^[0-9a-f]{64}$/, ADDR = /^0x[0-9a-f]{40}$/, DEP = /^0x[0-9a-f]{64}$/, INST = /^hv[0-9a-f]{32}$/;
const ZONE = "app.enclave.host";
const TS_SKEW_S = 60;

class Refusal extends Error {}
const refuse = (why) => { throw new Refusal(why); };
const lc = (s) => String(s ?? "").toLowerCase();

export function parseArgs(argv) {
  const o = { mode: null, timeoutSec: 120 };
  const names = { "--deployment": "deployment", "--instance": "instance", "--app-id": "appId", "--version": "version", "--cid": "cid",
    "--owner": "owner", "--expect-endpoint": "endpoint", "--expect-runner": "runner", "--expect-runtime": "runtime",
    "--timeout-sec": "timeoutSec", "--state-url": "stateUrl", "--expect-operator": "operator" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check" || a === "--run") { if (o.mode) refuse("give exactly one of --check / --run"); o.mode = a.slice(2); continue; }
    if (!names[a] || i + 1 >= argv.length) refuse(`unknown or incomplete argument ${a}`);
    o[names[a]] = argv[++i];
  }
  if (!o.mode) refuse("give exactly one of --check / --run");
  o.deployment = lc(o.deployment); o.instance = lc(o.instance); o.appId = lc(o.appId); o.owner = lc(o.owner);
  o.runner = lc(o.runner); if (o.runtime !== undefined) o.runtime = lc(o.runtime);
  if (!DEP.test(o.deployment)) refuse("--deployment 0x<64 hex> required");
  if (!INST.test(o.instance)) refuse("--instance hv<32 hex> required");
  if (!HEX64.test(o.appId)) refuse("--app-id <64 hex> required");
  if (!o.version || !o.cid) refuse("--version and --cid required");
  if (!ADDR.test(o.owner)) refuse("--owner 0x<40 hex> required");
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(String(o.endpoint || "")) || /\/$/.test(o.endpoint)) refuse("--expect-endpoint https://… (exactly as registered, no trailing slash) required");
  if (!DEP.test(o.runner)) refuse("--expect-runner 0x<64 hex> required");
  if (o.runtime !== undefined && !HEX64.test(o.runtime)) refuse("--expect-runtime must be 64 hex");
  if (o.operator !== undefined && !ADDR.test(o.operator = lc(o.operator))) refuse("--expect-operator must be 0x<40 hex>");
  o.timeoutSec = Number(o.timeoutSec);
  if (!Number.isInteger(o.timeoutSec) || o.timeoutSec < 10 || o.timeoutSec > 300) refuse("--timeout-sec 10..300");
  o.stateUrl = o.stateUrl || "http://127.0.0.1:9600/v1/host/state";
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/v1\/host\/state$/.test(o.stateUrl)) refuse("--state-url must be the node's loopback /v1/host/state");
  return o;
}

/** The ONLY message this process will sign, once: name, endpoint and key fixed; timestamp within ±60 s of now. */
export function narrowSigner({ account, name, endpoint, spki, now = () => Date.now() }) {
  if (!account || typeof account.signMessage !== "function") refuse("no operator account");
  const prefix = `enclave-certs-issue:${name}:${endpoint}:${spki}:`;
  let used = false;
  return async (message) => {
    const m = String(message);
    if (used) throw new Error("the one-off signer has already signed once");
    if (!m.startsWith(prefix)) throw new Error("the one-off signer refuses any message but this name, endpoint and key's issue request");
    const ts = m.slice(prefix.length);
    if (!/^[0-9]{1,12}$/.test(ts) || Math.abs(Number(ts) - Math.floor(now() / 1000)) > TS_SKEW_S) throw new Error("the one-off signer refuses a stale or future timestamp");
    used = true;
    return account.signMessage({ message: m });
  };
}

/** Exactly one record, every pin holding -> the record and the guest's transport key sha256. */
export function selectRecord(state, o) {
  const all = Array.isArray(state?.deployments) ? state.deployments : refuse("the node's state lists no deployments");
  const hits = all.filter((d) => lc(d?.id) === o.deployment);
  if (hits.length !== 1) refuse(`expected exactly one record for the deployment, found ${hits.length}`);
  const d = hits[0], iso = d.isolation || {};
  const checks = [["status running", d.status === "running"], ["public", d.isPublic === true], ["owner", lc(d.owner) === o.owner],
    ["version", String(d.version) === String(o.version)], ["cid", String(d.cid) === String(o.cid)],
    ["no GPU share", Number(d.gpuShare || 0) === 0 && Number(d.partitionGpuShare || 0) === 0],
    ["instance", lc(iso.instance) === o.instance], ["app id", lc(iso.appId) === o.appId], ["hyperv tier", /^t0-hv$/i.test(String(iso.tier || ""))],
    ["transport key", HEX64.test(lc(iso.transportKeySha256))]];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (bad.length) refuse(`the record does not hold: ${bad.join(", ")}`);
  return { record: { status: "running", isPublic: true, owner: lc(d.owner), gpuShare: 0, isolation: { instance: lc(iso.instance), appId: lc(iso.appId) } },
           spki: lc(iso.transportKeySha256) };
}

export function verifyPins({ control = CONTROL, pins = MODULE_PINS, read = fs.readFileSync } = {}) {
  const bad = [];
  for (const [rel, want] of Object.entries(pins)) {
    let got = "absent"; try { got = createHash("sha256").update(read(path.join(control, ...rel.split("/")))).digest("hex"); } catch {}
    if (got !== want) bad.push(rel);
  }
  if (bad.length) refuse(`installed modules differ from the reviewed pins: ${bad.join(", ")}`);
}

async function importInstalled(control) {
  const at = (rel) => pathToFileURL(path.join(control, ...rel.split("/"))).href;
  const [hv, chain, ident, iso] = await Promise.all([import(at("windows/node/hvcert.mjs")), import(at("windows/node/chain.mjs")),
    import(at("windows/node/host-identity.mjs")), import(at("windows/node/isolation-client.mjs"))]);
  return { createHvCertPass: hv.createHvCertPass, loadOperator: chain.loadOperator, enclaveIdOf: chain.enclaveIdOf,
           resolveIdentity: ident.resolveIdentity, IsolationManagerClient: iso.IsolationManagerClient };
}

const fetchState = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (r.status !== 200) refuse(`the node's state answered HTTP ${r.status}`);
  return r.json();
};

/** -> { exit, report } ; report holds only fixed fields: never a key, CSR, signature or environment value. */
export async function main(argv, { env = process.env, control = CONTROL, verify = verifyPins, load = importInstalled, getState = fetchState,
                                   now = () => Date.now() } = {}) {
  const report = { at: new Date(now()).toISOString() };
  try {
    const o = parseArgs(argv); report.mode = o.mode; report.deployment = o.deployment.slice(0, 10);
    verify({ control }); report.modules = "pinned";
    const m = await load(control);
    const ID = m.resolveIdentity(env);
    if (ID.publicUrl !== o.endpoint) refuse("this host's resolved PUBLIC_URL is not the expected registered endpoint");
    if (lc(m.enclaveIdOf(ID.publicUrl)) !== o.runner) refuse("keccak256(endpoint) is not the deployment's expected runner");
    const base = ID.mode === "relay" ? undefined : ID.relayBase;
    if (ID.mode !== "relay" && !base) refuse("independent mode without a relay certificate service");
    const manager = env.ENCLAVE_ISOLATION_MANAGER, dataAddr = env.ENCLAVE_ISOLATION_DATA_ADDR, pin = lc(env.ENCLAVE_ISOLATION_RUNTIME_ID);
    if (!manager || !dataAddr) refuse("the node's isolation manager / data plane settings are missing (run under node-config.cmd)");
    if (!HEX64.test(pin)) refuse("the node's runtime pin is missing or malformed");
    if (o.runtime !== undefined && pin !== o.runtime) refuse("the node's runtime pin is not the expected one");
    report.identity = { mode: ID.mode, endpoint: "matches", runner: "matches", runtimePin: "present" };
    const { record, spki } = selectRecord(await getState(o.stateUrl), o);
    report.record = { instance: o.instance, appId: o.appId.slice(0, 16), version: o.version, owner: o.owner, keyPrefix: spki.slice(0, 16) };
    const account = m.loadOperator(path.join(env.NODE_DIR || path.join(control, "windows", "node"), "operator.key"));
    if (!account) refuse("no operator credential on this host (loadOperator returned none)");
    report.operator = String(account.address);
    if (o.operator !== undefined && lc(account.address) !== o.operator) refuse("the loaded operator is not the deployment's expected runner operator");
    if (o.mode === "check") { report.result = "check passed: nothing signed or requested"; return { exit: 0, report }; }

    const name = `${o.deployment.slice(2, 10)}.${ZONE}`;
    const sign = narrowSigner({ account, name, endpoint: o.endpoint, spki, now });
    const lines = [];
    const pass = m.createHvCertPass({ client: new m.IsolationManagerClient({ base: manager }), dataAddr, runtimeId: pin, endpoint: ID.publicUrl,
      sign, ...(base ? { base } : {}), served: (owner) => lc(owner) === o.owner, log: (l) => lines.push(String(l).slice(0, 300)) });
    let timer;
    const done = await Promise.race([pass.pass(new Map([[o.deployment, record]])).then(() => "done"),
      new Promise((r) => { timer = setTimeout(() => r("timeout"), o.timeoutSec * 1000); })]).finally(() => clearTimeout(timer));
    report.log = lines;
    if (done === "timeout") { report.result = "timeout: the pass did not finish; the guest's own state decides (re-check before any retry)"; return { exit: 3, report }; }
    const st = pass.state(o.deployment);
    if (st && st.key && !st.backoffUntil) {
      report.result = st.reused ? "reused: the guest already serves a valid certificate for its key; nothing issued" : "installed";
      report.cert = { serial: st.serial, notAfter: new Date(st.notAfter).toISOString(), issuer: String(st.issuer || "").slice(0, 80), key: String(st.key || "").slice(0, 16) };
      return { exit: 0, report };
    }
    if (st && st.backoffUntil) {
      report.result = "nothing installed"; report.why = String(st.why || "").slice(0, 300);
      report.retryAfterSec = Math.max(0, Math.round((st.backoffUntil - now()) / 1000));
      return { exit: 2, report };
    }
    report.result = "unknown: the pass left no state"; return { exit: 3, report };
  } catch (e) {
    report.result = e instanceof Refusal ? "refused locally, nothing requested" : "failed before a result"; report.why = String(e.message).slice(0, 300);
    return { exit: e instanceof Refusal ? 1 : 3, report };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { exit, report } = await main(process.argv.slice(2));
  process.stdout.write("RESULT " + JSON.stringify(report) + "\n");
  process.exit(exit);
}
