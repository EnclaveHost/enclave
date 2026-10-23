// The CLI's offline commands (plan, status) and its refusals before any network: no chain, no key, no relay.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkRepo } from "../driver/cli.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "driver/cli.mjs");
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, ...env } });

function pinsFile(mut = (p) => p) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canary-cli-")));
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, "pins.example.json"), "utf8"));
  p.runLabel = `29991231T${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}Z`;
  mut(p);
  fs.writeFileSync(path.join(dir, "pins.json"), JSON.stringify(p));
  return { dir, file: path.join(dir, "pins.json"), label: p.runLabel };
}
const cleanup = ({ dir, label }) => { for (const d of [dir, path.join(ROOT, "runs", label), path.join(ROOT, "private", label)]) fs.rmSync(d, { recursive: true, force: true }); };

test("plan: offline, every step listed with its hash, all blocked until root states the reuse scope; private dirs 0700", () => {
  const f = pinsFile();
  try {
    const r = run(["plan", "--pins", f.file]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.pinsHash, /^[0-9a-f]{64}$/);
    assert.ok(out.steps.length >= 40);
    assert.ok(out.steps.every((s) => s.status === "blocked" && /^[0-9a-f]{64}$/.test(s.stepHash)));
    assert.equal(fs.statSync(path.join(ROOT, "private", f.label)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(ROOT, "runs", f.label)).mode & 0o777, 0o700);
    assert.equal(fs.readdirSync(path.join(ROOT, "runs", f.label)).length, 0, "plan writes no journal entry");
  } finally { cleanup(f); }
});

test("status with a stated scope: the read-only inventory steps become ready, nothing else", () => {
  const f = pinsFile((p) => { p.owner.reuseScope = { statedBy: "root", at: "2026-10-23T20:30:00Z", onlyPlanCreatedDeployments: true }; });
  try {
    const out = JSON.parse(run(["status", "--pins", f.file]).stdout);
    const ready = out.steps.filter((s) => s.status === "ready").map((s) => s.id).sort();
    assert.deepEqual(ready, ["S0.chain", "S0.custodian", "S0.root"]);
  } finally { cleanup(f); }
});

test("network commands refuse before any network when the client repo is not exactly the pinned one", () => {
  const f = pinsFile((p) => { p.repo.files["custody/v2/owner.mjs"] = "00".repeat(32); });
  try {
    const r = run(["read", "--pins", f.file, "--step", "S0.chain"]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /REFUSED: custody\/v2\/owner.mjs: not the pinned file/);
  } finally { cleanup(f); }
  const pins = JSON.parse(fs.readFileSync(path.join(ROOT, "pins.example.json"), "utf8"));
  assert.throws(() => checkRepo(pins, (args) => (args[0] === "rev-parse" ? "0".repeat(40) : "")), /HEAD/);
  assert.throws(() => checkRepo(pins, (args) => (args[0] === "rev-parse" ? pins.repo.commit : " M custody/v2/owner.mjs")), /modified/);
  assert.doesNotThrow(() => checkRepo(pins, (args) => (args[0] === "rev-parse" ? pins.repo.commit + "\n" : "")));
});

test("bad pins refuse with a message and no stack of private data", () => {
  const f = pinsFile((p) => { p.deployments = { C1: { id: "0x" + "c1".repeat(32) } }; });
  try {
    const r = run(["plan", "--pins", f.file]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /^REFUSED: pins: deployment ids are learned/);
  } finally { cleanup(f); }
});
