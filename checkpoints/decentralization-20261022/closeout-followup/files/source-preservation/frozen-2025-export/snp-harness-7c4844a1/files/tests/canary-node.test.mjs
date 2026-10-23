// Node-side checks of the canary host copy: the injected lines' behaviour on mocked requests (no sockets), the
// transformed fixture's syntax, and the resolve hook that makes the copy import the ORIGINAL host.mjs's modules.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INJECT = fs.readFileSync(path.join(HARNESS, "canary/fault-inject.mjs.txt"), "utf8");
const REGISTER = pathToFileURL(path.join(HARNESS, "canary/resolve-register.mjs")).href;
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canary-node-")));
const run = (args, env = {}) => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20000, env: { PATH: process.env.PATH, ...env } });

// The inject lines exactly as inserted: inside the handler, after `send` is defined and inside its `try`.
const handler = new Function("req", "res", "send", "cfg", "fs", INJECT + '    return "passthrough";\n');
function call({ method, url, fault, log }) {
  const req = { method, url }, res = new EventEmitter(), sent = [];
  res.statusCode = 200; res.writableFinished = false;
  const send = (code, body) => { res.statusCode = code; res.writableFinished = true; sent.push([code, body]); return "sent"; };
  const cfg = { canaryEventLog: log, ...(fault ? { canaryStateFault: fault } : {}) };
  const out = handler(req, res, send, cfg, fs);
  res.emit("close");
  return { out, sent, res };
}
const lines = (log) => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("only GET /state answers 503, and only when the phase commands get-503", { timeout: 10000 }, () => {
  const dir = tmp(), log = path.join(dir, "events.jsonl");
  try {
    assert.deepEqual(call({ method: "GET", url: "/state", fault: "get-503", log }).sent, [[503, { error: "canary state-store outage" }]]);
    assert.equal(call({ method: "GET", url: "/state", log }).out, "passthrough");
    assert.equal(call({ method: "GET", url: "/state", fault: "get-500", log }).out, "passthrough");
    assert.equal(call({ method: "PUT", url: "/state", fault: "get-503", log }).out, "passthrough");
    assert.equal(call({ method: "GET", url: "/receipts", fault: "get-503", log }).out, "passthrough");
    assert.equal(call({ method: "GET", url: "/state?x", fault: "get-503", log }).out, "passthrough");
    const ev = lines(log);
    assert.equal(ev.length, 12);
    assert.deepEqual(ev[1], { ev: "res", at: ev[1].at, method: "GET", url: "/state", status: 503, finished: true });
    for (const e of ev) assert.deepEqual(Object.keys(e).sort(), e.ev === "req" ? ["at", "ev", "method", "url"] : ["at", "ev", "finished", "method", "status", "url"]);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("events carry method, path and status only, bounded in length", { timeout: 10000 }, () => {
  const dir = tmp(), log = path.join(dir, "events.jsonl");
  try {
    call({ method: "PUT".repeat(9), url: "/state/" + "x".repeat(500), log });
    const [req] = lines(log);
    assert.equal(req.method.length, 8); assert.equal(req.url.length, 64);
    assert.ok(!fs.readFileSync(log, "utf8").includes("body"));
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("without an event log the handler throws (inside host.mjs's try: HTTP 500, never a silent pass)", { timeout: 10000 }, () => {
  assert.throws(() => call({ method: "GET", url: "/state", fault: "get-503", log: undefined }));
});

test("the transformed a5eae96c host.mjs is valid JavaScript and differs only by the inject lines", { timeout: 20000 }, () => {
  const dir = tmp(), out = path.join(dir, "host-canary.mjs");
  try {
    const py = spawnSync("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(path.join(HARNESS, "canary"))}); import recovery_canary as rc, pathlib
src = pathlib.Path(${JSON.stringify(path.join(HARNESS, "tests/fixtures/host-a5eae96c.mjs"))}).read_bytes()
sys.stdout.buffer.write(rc.transform_host(src, 'c2923901a78f6253aa405ef051246211f97e63d8e9ea0267b00e9a836b80090f', rc.INJECT_FILE.read_text()))`],
      { timeout: 15000 });
    assert.equal(py.status, 0, String(py.stderr));
    fs.writeFileSync(out, py.stdout);
    const check = run(["--check", out]);
    assert.equal(check.status, 0, check.stderr);
    const original = fs.readFileSync(path.join(HARNESS, "tests/fixtures/host-a5eae96c.mjs"), "utf8");
    assert.equal(py.stdout.toString("utf8").replace(INJECT, ""), original);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

function layout() {
  const root = tmp();
  const orig = path.join(root, "src/custody/v2"), copyDir = path.join(root, "run/private");
  fs.mkdirSync(orig, { recursive: true }); fs.mkdirSync(copyDir, { recursive: true });
  fs.mkdirSync(path.join(root, "src/node_modules/fakepkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/node_modules/fakepkg/package.json"), JSON.stringify({ name: "fakepkg", type: "module", exports: "./index.js" }));
  fs.writeFileSync(path.join(root, "src/node_modules/fakepkg/index.js"), 'export default "pkg-from-source-repo";\n');
  fs.mkdirSync(path.join(root, "src/network"));
  fs.writeFileSync(path.join(root, "src/network/up.mjs"), 'export const up = "up-from-source-repo";\n');
  const body = 'import { v } from "./dep.mjs";\nimport p from "fakepkg";\nimport { up } from "../../network/up.mjs";\n' +
    'console.log(JSON.stringify({ v, p, up, self: import.meta.url, args: process.argv.slice(2) }));\n';
  fs.writeFileSync(path.join(orig, "host.mjs"), body);
  fs.writeFileSync(path.join(orig, "dep.mjs"), 'export const v = "dep-from-source-repo";\n');
  fs.writeFileSync(path.join(copyDir, "dep.mjs"), 'export const v = "WRONG-dep-next-to-copy";\n');
  fs.writeFileSync(path.join(copyDir, "host-canary.mjs"), body);
  return { root, original: path.join(orig, "host.mjs"), copy: path.join(copyDir, "host-canary.mjs") };
}

test("the copy resolves relative and bare imports exactly as the original host.mjs", { timeout: 20000 }, () => {
  const { root, original, copy } = layout();
  try {
    const env = { CANARY_HOST_COPY_URL: pathToFileURL(copy).href, CANARY_HOST_ORIGINAL_URL: pathToFileURL(original).href };
    const r = run(["--import", REGISTER, copy, "cfg.json"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { v: "dep-from-source-repo", p: "pkg-from-source-repo", up: "up-from-source-repo", self: pathToFileURL(copy).href, args: ["cfg.json"] });
    assert.equal(r.stderr, "");
    // control: without the hook the copy would import its neighbour and miss the source repo's packages
    const bare = run([copy]);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /fakepkg/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("the hook refuses any other entry point, a non-host original, the original itself, or missing URLs", { timeout: 20000 }, () => {
  const { root, original, copy } = layout();
  try {
    const env = { CANARY_HOST_COPY_URL: pathToFileURL(copy).href, CANARY_HOST_ORIGINAL_URL: pathToFileURL(original).href };
    const other = path.join(path.dirname(copy), "other.mjs"); fs.copyFileSync(copy, other);
    const cases = [
      [[other], env, /not the canary host copy/],
      [[copy], { CANARY_HOST_COPY_URL: env.CANARY_HOST_COPY_URL }, /required/],
      [[copy], { ...env, CANARY_HOST_ORIGINAL_URL: pathToFileURL(path.join(path.dirname(original), "dep.mjs")).href }, /existing, non-symlinked custody\/v2\/host\.mjs/],
      [[original], { CANARY_HOST_COPY_URL: env.CANARY_HOST_ORIGINAL_URL, CANARY_HOST_ORIGINAL_URL: env.CANARY_HOST_ORIGINAL_URL }, /must not be the original/],
    ];
    const link = path.join(root, "linked/custody/v2"); fs.mkdirSync(link, { recursive: true }); fs.symlinkSync(original, path.join(link, "host.mjs"));
    cases.push([[copy], { ...env, CANARY_HOST_ORIGINAL_URL: pathToFileURL(path.join(link, "host.mjs")).href }, /non-symlinked/]);
    for (const [args, e, re] of cases) {
      const r = run(["--import", REGISTER, ...args], e);
      assert.notEqual(r.status, 0, JSON.stringify(args)); assert.match(r.stderr, re); assert.equal(r.stdout, "");
    }
  } finally { fs.rmSync(root, { recursive: true }); }
});
