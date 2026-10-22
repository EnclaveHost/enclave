// The frozen release (../release/<id>.tar, build-release.mjs):
//   - verify-release.mjs accepts exactly the released files and refuses a changed byte, an extra or missing file, a symlink,
//     a group/other permission bit and a renamed directory;
//   - the closure is SELF-CONTAINED: copied away from any repository, the role's own CLI runs from it (usage, and `check`
//     over a configuration, the pinned package and a placed key), resolving viem from the release's locked packages;
//   - the closure is EXACTLY main's current bytes (freshness) and the build is deterministic (a second build, same id).
// The REAL platform-gate and `run` CLI behaviour of the frozen copy is exercised by main's own role test pointed at it
// (lease-relay-host-policy.test.mjs, LEASE_RELAY_HOST_UNDER_TEST; see run-fixtures.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), WS = path.resolve(HERE, ".."), MAIN = path.resolve(WS, "../enclave");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const TAR = (() => { const d = path.join(WS, "release"); const t = fs.readdirSync(d).filter((f) => /^[0-9a-f]{64}\.tar$/.test(f)); assert.equal(t.length, 1); return path.join(d, t[0]); })();
const ID = path.basename(TAR, ".tar");
const SCRATCH = fs.mkdtempSync(path.join(WS, ".test-rel-"));
process.on("exit", () => fs.rmSync(SCRATCH, { recursive: true, force: true }));
function extract() {
  const d = fs.mkdtempSync(path.join(SCRATCH, "x-"));
  assert.equal(spawnSync("tar", ["-xf", TAR, "-C", d, "--no-same-owner"]).status, 0);
  const r = path.join(d, ID);
  spawnSync("find", [r, "-type", "d", "-exec", "chmod", "0700", "{}", "+"]); spawnSync("find", [r, "-type", "f", "-exec", "chmod", "0600", "{}", "+"]);
  return r;
}
const verify = (r) => { const x = spawnSync(process.execPath, [path.join(r, "verify-release.mjs")], { encoding: "utf8" }); return { code: x.status, out: x.stdout + x.stderr }; };

test("verify-release: exactly the released files, owner-only; every deviation refuses", () => {
  const r = extract();
  let v = verify(r); assert.equal(v.code, 0, v.out); assert.match(v.out, new RegExp(`release ${ID} verified`));
  const M = JSON.parse(fs.readFileSync(path.join(r, "RELEASE.json"), "utf8"));
  assert.equal(M.releaseId, ID); assert.equal(M.format, "enclave-host-relay-user-release/v1");
  const victim = path.join(r, "app/network/host-services/lease-relay-host.mjs");
  for (const [why, mutate, undo, re] of [
    ["a changed byte", () => fs.appendFileSync(victim, " "), () => fs.truncateSync(victim, M.files["app/network/host-services/lease-relay-host.mjs"].bytes), /not the released bytes/],
    ["an extra file", () => fs.writeFileSync(path.join(r, "app/extra.mjs"), "x", { mode: 0o600 }), () => fs.rmSync(path.join(r, "app/extra.mjs")), /not in the release/],
    ["a missing file", () => fs.renameSync(path.join(r, "gate/lease-relay-migration-check.mjs"), path.join(SCRATCH, "g")), () => fs.renameSync(path.join(SCRATCH, "g"), path.join(r, "gate/lease-relay-migration-check.mjs")), /is missing/],
    ["a symlink", () => fs.symlinkSync("/etc/passwd", path.join(r, "app/link")), () => fs.unlinkSync(path.join(r, "app/link")), /is a symlink/],
    ["a group-readable file", () => fs.chmodSync(victim, 0o640), () => fs.chmodSync(victim, 0o600), /group\/other permissions/],
    ["a tampered manifest", () => { const m = { ...M, entry: "x" }; fs.writeFileSync(path.join(r, "RELEASE.json"), JSON.stringify(m)); }, () => fs.writeFileSync(path.join(r, "RELEASE.json"), JSON.stringify(M, null, 1) + "\n"), /does not hash to its release id/]]) {
    mutate(); v = verify(r); assert.equal(v.code, 1, why); assert.match(v.out, re, why); undo();
    assert.equal(verify(r).code, 0, `${why}: undone`);
  }
  const renamed = r + "-renamed"; fs.renameSync(r, renamed); v = verify(renamed); assert.equal(v.code, 1); assert.match(v.out, /not named by its id/);
});

test("the closure is self-contained: the role's CLI runs from a copy outside any repository, on the release's locked packages", () => {
  const r = extract();
  for (let d = path.dirname(r); d !== path.dirname(d); d = path.dirname(d)) assert.ok(!fs.existsSync(path.join(d, "node_modules")), `no node_modules above the release (${d})`);
  const cli = path.join(r, "app/network/host-services/lease-relay-host.mjs");
  let x = spawnSync(process.execPath, [cli], { encoding: "utf8", cwd: SCRATCH, env: { PATH: process.env.PATH } });
  assert.equal(x.status, 2); assert.match(x.stderr, /usage: lease-relay-host\.mjs init\|descriptor\|advertise\|check\|run/);
  // `check`: validation, the pinned package (the release's own), a placed key and its address
  const M = JSON.parse(fs.readFileSync(path.join(r, "RELEASE.json"), "utf8"));
  const st = path.join(SCRATCH, "state-" + Math.random().toString(16).slice(2)), rec = path.join(SCRATCH, "rec.json");
  fs.mkdirSync(path.join(st, "lease-relay"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(st, "lease-relay/relay.key"), "5a".repeat(32) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(st, "lease-relay/relay.address"), "0x0000000000000000000000000000000000000001\n");
  fs.copyFileSync(path.join(WS, "config/lease-gas-deployment.json"), rec);
  const cfg = path.join(SCRATCH, "cfg.json");
  fs.writeFileSync(cfg, JSON.stringify({ format: "enclave-host-relay/v1", host: { endpoint: "https://api.enclave.host/t/metal0", publicEndpoints: [] }, platformHostPolicy: "production",
    platformHostPolicyCarriers: { importDir: path.join(SCRATCH, "import") }, packagesDir: path.join(r, "packages"), stateRoot: st,
    relay: { package: M.relayPackage.pin, heapMiB: 128, port: 8549, bind: "127.0.0.1", record: rec, digest: "sha256:" + sha(fs.readFileSync(rec)), rpc: ["https://a.example", "https://b.example"], quorum: 2, maxFloatEth: "0.002", minFloatEth: "0.0002" } }));
  x = spawnSync(process.execPath, [cli, "check", cfg], { encoding: "utf8", cwd: SCRATCH, env: { PATH: process.env.PATH } });
  assert.equal(x.status, 0, x.stderr); const out = JSON.parse(x.stdout);
  assert.equal(out.ok, true); assert.equal(out.bundleSha256, M.relayPackage.bundleSha256); assert.equal(out.payee, "0x0000000000000000000000000000000000000001");
  assert.ok(!out.env.includes("LEASE_RELAY_KEY") || out.env.every((n) => !/^0x[0-9a-f]{64}$/.test(n)), "names only, no key material");
  // the gate and the relay package are standalone files (no import outside themselves)
  for (const f of ["gate/lease-relay-migration-check.mjs", "packages/lease-relay.mjs"]) assert.doesNotMatch(fs.readFileSync(path.join(r, f), "utf8"), /from\s*["']\.\.?\//, f);
});

test("freshness and determinism: the closure is main's CURRENT bytes; a second build gives the same release id and archive", () => {
  const M = JSON.parse(fs.readFileSync(path.join(extract(), "RELEASE.json"), "utf8"));
  const stale = Object.entries(M.builtFrom.sources).filter(([p, s]) => sha(fs.readFileSync(path.join(MAIN, p))) !== s).map(([p]) => p);
  assert.deepEqual(stale, [], "every closure file equals main's working tree now");
  assert.ok(Object.keys(M.builtFrom.sources).includes("client/lease-executor-client.mjs") && M.builtFrom.sources["client/lease-executor-client.mjs"] === "bd082b005f770b36d29495ee1cb3e193efc458ecbe49056997cdfb48876ab2dd",
    "built with the integrated pinned-relay client");
  const second = path.join(WS, "logs/build-2.json");
  if (fs.existsSync(second)) { const b = JSON.parse(fs.readFileSync(second, "utf8").trim().split("\n").at(-1)); assert.equal(b.releaseId, ID); assert.equal(b.tarSha256, sha(fs.readFileSync(TAR))); }
  else assert.fail("the second build's record (logs/build-2.json) is missing");
});
