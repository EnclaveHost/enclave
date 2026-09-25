#!/usr/bin/env node
// mutate-pvm-serving.mjs -- the mutation check behind RELAY-SERVING.md "Wired behind a switch": each mutation below breaks
// ONE property of the pVM carrier or its wiring into api-relay.js, and the test it names must fail on it. From the repo root:
//   node test/mutate-pvm-serving.mjs            (all)       node test/mutate-pvm-serving.mjs M04 M14   (some)
// It works on a COPY of the tree in a temp directory (relay/, test/, and the client, web and carrier sources the tests
// import), never on the checkout, so a killed run leaves no mutated file behind; the copy's node_modules are symlinks to this
// checkout's (the tests need them anyway). First a CONTROL: the unmutated copy must pass both suites. A mutation whose text
// is not found exactly once fails the run (a renamed line would otherwise make it vacuous). Exit 0 only when the control
// passes and every mutation is caught by the test it names.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = { api: "test/api-relay-pvm-serving.test.mjs", hub: "test/pvm-relay-serving.test.mjs", resolver: "test/pvm-runner-resolver.test.mjs" };
const T = {   // the tests, by a distinctive part of their titles
  off: "PVM_SERVING OFF (the default)", lazy: "OFF carries no new code", bare: "PVM_SERVING ON without its configuration",
  on: "PVM_SERVING ON and configured: the ledger runner only", hung: "a ledger that never answers", hub: "the relay's wiring on the REAL hub",
  boot: "the BOOTSTRAP route on the REAL hub", route: "carrierRoute: only the EXACT raw routes",
  // the carrier's own resolver (pvm-serving.mjs pvmRunnerResolver; enclave-99's refusals)
  rTier: "routed: the ledger's live runner", rCanon: "a full canonical id only", rMiss: "a miss gets exactly ONE fresh ledger read",
  rFail: "a ledger read that fails is NO route", rLapse: "a lease that lapses mid-session", rHub: "only the hub's avf tunnel for THAT runner",
  rWire: "api-relay.js: pvm-serving resolves through pvmRunnerResolver",
};
const AR = "relay/api-relay.js", PS = "relay/pvm-serving.mjs", TJ = "relay/tunnel.js";
const PVM_LINE = "  if (pvmServe && pvmServe(req, res)) return;\n";
const MUTATIONS = [
  ["M01", "the switch accepts another word", AR, [["/^(1|true|on|yes)$/i.test(String(process.env.PVM_SERVING", "/^(1|true|on|yes|enabled)$/i.test(String(process.env.PVM_SERVING"]], "api", T.lazy],
  ["M02", "OFF is not OFF: the module is loaded and its handler built", AR, [["  : { enabled: false };", "  : (await import(\"./pvm-serving.mjs\")).pvmServingFromEnv({ ...process.env, PVM_SERVING: \"1\" }, { avfOn: !!AVF_ATTEST, pvmCpuOn: !!PVM_CPU_POLICY });"]], "api", T.off],
  ["M03", "a static import (OFF would load the module)", AR, [["const PVM_SERVING = /^", "import \"./pvm-serving.mjs\";\nconst PVM_SERVING = /^"]], "api", T.lazy],
  ["M04", "the route is not wired", AR, [[PVM_LINE, ""]], "api", T.bare],
  ["M05", "the carrier ahead of app subdomains", AR, [[PVM_LINE, ""], ["  // App subdomain: <dep-id>.<APP_DOMAIN> is the deployment's OWN origin.", PVM_LINE + "  // App subdomain: <dep-id>.<APP_DOMAIN> is the deployment's OWN origin."]], "api", T.on],
  ["M06", "WebSocket upgrades on the reserved paths intercepted", AR, [["return refuse(400, \"Bad Request\");   // origin-form only (see handleRequest)", "return refuse(400, \"Bad Request\");   // origin-form only (see handleRequest)\n  if (/\\/pvm\\/(evidence|sealed)$/.test((req.url || \"\").split(\"?\")[0])) return refuse(404, \"Not Found\");"]], "api", T.on],
  ["M07", "the hub is not given the app policy", AR, [["...(PVM_SERVING.attestPvmApp ? { pvmApp: PVM_SERVING.attestPvmApp } : {}), ", ""]], "api", T.on],
  ["M08", "per-client identity from the socket", AR, [["clientOf: (req) => clientIp(req)", "clientOf: (req) => req.socket.remoteAddress"]], "api", T.on],
  ["M09", "no per-deployment bucket", AR, [["perDeployment: makeRateLimiter({ capacity: 60, refillPerSec: 1 })", "perDeployment: () => true"]], "api", T.on],
  ["M10", "unconfigured routes fall through to the /x proxy", PS, [["    res.writeHead(503, {", "    return false; res.writeHead(503, {"]], "api", T.bare],
  ["M11", "the unconfigured 503 keeps the socket", PS, [["...CARRIER_HEADERS, connection: \"close\" }); res.end(); return true;", "...CARRIER_HEADERS }); res.end(); return true;"]], "api", T.bare],
  ["M12", "lax app ids (0x, uppercase, 63 hex)", PS, [["const HEX64 = /^[0-9a-f]{64}$/;", "const HEX64 = /^(0x)?[0-9a-fA-F]{63,64}$/;"]], "api", T.bare],
  ["M13", "early refusals keep the socket", PS, [["const early = (res, status) => { res.setHeader(\"connection\", \"close\"); plain(res, status); };", "const early = (res, status) => plain(res, status);"]], "api", T.on],
  ["M14", "no request bound (413)", PS, [["if (nIn > maxIn) {", "if (nIn > maxIn * 100) {"]], "api", T.on],
  ["M15", "no pending cap", PS, [["maxPendingPerClient = 4,", "maxPendingPerClient = 400,"]], "api", T.hung],
  ["M16", "a hung ledger is waited on for a minute", PS, [["resolveTimeoutMs = 5000,", "resolveTimeoutMs = 60000,"]], "api", T.hung],
  ["M17", "the wiring ignores a missing policy", PS, [["handler: (deps) => (missing.length ? refuseAll : createPvmServing(deps))", "handler: (deps) => createPvmServing(deps)"]], "hub", T.hub],
  ["M18", "a cut answer ends cleanly", PS, [["else if (cut) res.destroy(); else res.end();", "else res.end();"]], "hub", T.hub],
  ["M19", "a buyer leaving does not close the VM's stream", PS, [["res.on(\"close\", () => { if (!res.writableFinished) sock.destroy(); });", ""]], "hub", T.hub],
  // the pre-lease BOOTSTRAP route (/t/<name>/pvm/evidence; RUNNER-AGENT.md "Before the lease")
  ["M21", "the bootstrap route claims ANY tunnel's /t/<name>/pvm/evidence, not only an attached pVM tunnel's", AR, [["o.endpoint === origin && o.mode === \"avf\")", "o.endpoint === origin)"]], "api", T.on],
  ["M22", "no per-tunnel rate on the bootstrap route", PS, [["if (!perClient(who) || !perDeployment(bucket))", "if (!perClient(who) || (m && !perDeployment(bucket)))"]], "hub", T.boot],
  ["M24", "the resolver requires the tier (a tunnel re-attached in place is cut off)", PS, [["if (!o || o.tunnel !== true || o.mode !== \"avf\" ||", "if (!o || !o.tier || o.tunnel !== true || o.mode !== \"avf\" ||"]], "resolver", T.rTier],
  ["M25", "the resolver reads the ledger for a non-canonical id", PS, [["    if (!CANON.test(h)) return null;\n", ""]], "resolver", T.rCanon],
  ["M26", "no fresh read on a miss", PS, [["if (!liveLease(r.d)) { r = await read(h, true); if (r.failed || !liveLease(r.d)) return null; }", "if (!liveLease(r.d)) return null;"]], "resolver", T.rMiss],
  ["M27", "a failed ledger read falls back to probing the hub's tunnels", PS, [["    if (r.failed) return null;\n", "    if (r.failed) { for (const o of origins() || []) if (o && o.mode === \"avf\") return o.endpoint; return null; }\n"]], "resolver", T.rFail],
  ["M28", "the lease's end is not judged", PS, [["Number(d.leaseUntil) * 1000 > now()", "true"]], "resolver", T.rLapse],
  ["M29", "the hub's mode is not required", PS, [["o.tunnel !== true || o.mode !== \"avf\" ||", "o.tunnel !== true ||"]], "resolver", T.rHub],
  ["M30", "any avf tunnel is taken, not the runner's", PS, [["      if (eid === runner) return o.endpoint;", "      return o.endpoint;"]], "resolver", T.rHub],
  ["M31", "pvm-serving resolves through the app router's runnerEndpointOf", AR, [["  resolve: PVM_SERVING.pvmRunnerResolver({ ledgerRows, expire: () => { _ledger.at = 0; }, origins: () => tunnelHub.origins(), endpointId }),", "  resolve: (id) => runnerEndpointOf(id),"]], "resolver", T.rWire],
  ["M23", "sealed routed by tunnel name", PS, [["\\/pvm\\/evidence$/.exec(raw)", "\\/pvm\\/(?:evidence|sealed)$/.exec(raw)"]], "hub", T.boot],
  // the carve-out AHEAD of U7's refusals (enclave-99's conditions): exact, raw, POST, no query; carrier answers sandboxed
  ["M32", "the carve-out claims another method", PS, [["  if (!req || req.method !== \"POST\") return null;", "  if (!req) return null;"]], "hub", T.route],
  ["M33", "the carve-out ignores a query", PS, [["  const raw = String(req.url || \"\");", "  const raw = String(req.url || \"\").split(\"?\")[0];"]], "hub", T.route],
  ["M34", "the carve-out claims any /x segment, not a canonical id", PS, [["/^\\/x\\/(0x[0-9a-f]{64})\\/pvm\\/(evidence|sealed)$/", "/^\\/x\\/([^/]+)\\/pvm\\/(evidence|sealed)$/"]], "hub", T.route],
  ["M35", "the carve-out matches case-insensitively", PS, [["(evidence|sealed)$/.exec(raw)", "(evidence|sealed)$/i.exec(raw)"]], "hub", T.route],
  ["M36", "the carve-out judges the DECODED path, not the raw one", PS, [["  const raw = String(req.url || \"\");", "  const raw = decodeURIComponent(String(req.url || \"\"));"]], "hub", T.route],
  ["M37", "carrier answers lose the sandbox CSP", PS, [[", \"content-security-policy\": \"sandbox; default-src 'none'\" };", " };"]], "api", T.bare],
  ["M20", "the hub pairs app and runtime (not the cross product)", TJ, [["        t.pvmApp = { appId: app, runtimeId: v.runtimeId,", "        if (policy.appIds.indexOf(app) !== policy.runtimeIds.indexOf(v.runtimeId)) return reply(false, [\"paired\"]);\n        t.pvmApp = { appId: app, runtimeId: v.runtimeId,"]], "hub", T.hub],
];

const pick = process.argv.slice(2);
const todo = pick.length ? MUTATIONS.filter((m) => pick.includes(m[0])) : MUTATIONS;
if (pick.length && todo.length !== pick.length) { console.error(`unknown mutation id in ${pick.join(" ")}`); process.exit(2); }
const nm = path.join(ROOT, "node_modules"), rnm = path.join(ROOT, "relay", "node_modules");
if (!fs.existsSync(nm) || !fs.existsSync(rnm)) { console.error("the tests need node_modules at the repo root and in relay/ (a worktree: symlink the main checkout's)"); process.exit(2); }

const COPY = fs.mkdtempSync(path.join(os.tmpdir(), "mutate-pvm-serving-"));
const cleanup = () => fs.rmSync(COPY, { recursive: true, force: true });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
const noModules = (src) => path.basename(src) !== "node_modules";
for (const d of ["relay", "test", "shielded/anchor/avf/client", "shielded/anchor/avf/web", "shielded/anchor/avf/cpu", "shielded/anchor/avf/results/pvm-cpu-browser-channel", "package.json"])
  fs.cpSync(path.join(ROOT, d), path.join(COPY, d), { recursive: true, filter: noModules });
fs.symlinkSync(fs.realpathSync(nm), path.join(COPY, "node_modules"));
fs.symlinkSync(fs.realpathSync(rnm), path.join(COPY, "relay", "node_modules"));

// run one suite in the copy: the titles of its failing tests (TAP), and whether it ran at all
function run(suite) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=180000", SUITES[suite]], { cwd: COPY, encoding: "utf8", timeout: 600000 });
  const out = r.stdout || "";
  return { failed: [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]), ran: /^# tests [1-9]/m.test(out) };
}

let bad = 0;
try {
  for (const s of Object.keys(SUITES)) {
    const c = run(s);
    const ok = c.ran && c.failed.length === 0;
    console.log(`${ok ? "ok  " : "FAIL"} control: ${SUITES[s]} passes unmutated${ok ? "" : ` -- failing: ${c.failed.join(" | ") || "(did not run)"}`}`);
    if (!ok) bad++;
  }
  if (bad) throw new Error("the control failed: no mutation result would mean anything");
  for (const [id, what, file, edits, suite, expect] of todo) {
    const f = path.join(COPY, file), orig = fs.readFileSync(f, "utf8");
    let src = orig, missing = null;
    for (const [from, to] of edits) { if (src.split(from).length !== 2) { missing = from; break; } src = src.replace(from, () => to); }
    if (missing) { console.log(`FAIL ${id} ${what}: its text is not found exactly once in ${file}: ${JSON.stringify(missing.slice(0, 60))}`); bad++; continue; }
    fs.writeFileSync(f, src);
    try {
      const r = run(suite), hit = r.failed.some((t) => t.includes(expect));
      console.log(`${hit ? "ok  " : "FAIL"} ${id} ${what}: ${hit ? "caught by" : "NOT caught by"} "${expect}"${r.failed.length ? ` (failing: ${r.failed.map((t) => t.slice(0, 40)).join(" | ")})` : " (nothing failed)"}`);
      if (!hit) bad++;
    } finally { fs.writeFileSync(f, orig); }
  }
} catch (e) { console.log(`FAIL ${e.message}`); bad = bad || 1; }
finally { cleanup(); }
console.log(bad ? `FAIL (${bad})` : `PASS: the control passes and all ${todo.length} mutation(s) are caught by the test each names`);
process.exit(bad ? 1 : 0);
