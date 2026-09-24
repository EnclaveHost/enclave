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
const SUITES = { api: "test/api-relay-pvm-serving.test.mjs", hub: "test/pvm-relay-serving.test.mjs" };
const T = {   // the tests, by a distinctive part of their titles
  off: "PVM_SERVING OFF (the default)", lazy: "OFF carries no new code", bare: "PVM_SERVING ON without its configuration",
  on: "PVM_SERVING ON and configured: the ledger runner only", hung: "a ledger that never answers", hub: "the relay's wiring on the REAL hub",
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
  ["M11", "the unconfigured 503 keeps the socket", PS, [["\"cache-control\": \"no-store\", connection: \"close\" }); res.end(); return true;", "\"cache-control\": \"no-store\" }); res.end(); return true;"]], "api", T.bare],
  ["M12", "lax app ids (0x, uppercase, 63 hex)", PS, [["const HEX64 = /^[0-9a-f]{64}$/;", "const HEX64 = /^(0x)?[0-9a-fA-F]{63,64}$/;"]], "api", T.bare],
  ["M13", "early refusals keep the socket", PS, [["const early = (res, status) => { res.setHeader(\"connection\", \"close\"); plain(res, status); };", "const early = (res, status) => plain(res, status);"]], "api", T.on],
  ["M14", "no request bound (413)", PS, [["if (nIn > maxIn) {", "if (nIn > maxIn * 100) {"]], "api", T.on],
  ["M15", "no pending cap", PS, [["maxPendingPerClient = 4,", "maxPendingPerClient = 400,"]], "api", T.hung],
  ["M16", "a hung ledger is waited on for a minute", PS, [["resolveTimeoutMs = 5000,", "resolveTimeoutMs = 60000,"]], "api", T.hung],
  ["M17", "the wiring ignores a missing policy", PS, [["handler: (deps) => (missing.length ? refuseAll : createPvmServing(deps))", "handler: (deps) => createPvmServing(deps)"]], "hub", T.hub],
  ["M18", "a cut answer ends cleanly", PS, [["else if (cut) res.destroy(); else res.end();", "else res.end();"]], "hub", T.hub],
  ["M19", "a buyer leaving does not close the VM's stream", PS, [["res.on(\"close\", () => { if (!res.writableFinished) sock.destroy(); });", ""]], "hub", T.hub],
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
