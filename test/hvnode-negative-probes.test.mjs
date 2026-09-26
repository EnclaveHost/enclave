// The acceptance scripts' NEGATIVE restart probes never carry a live deployment id (enclave-87's hard rule, 2026-09-26: a
// check never sends a production apply at live state and relies on a guard to refuse it). hvnode-accept.ps1 A9 and
// hvnode-accept-remote.sh R2/R2b aim them at the ZERO bytes32 id, which names no deployment, so a regressed guard still
// restarts nothing; only hvnode-accept.ps1 -OwnerRestart (a deliberate restart) sends the caller's id.
// - A9: its embedded check script (the here-string the .ps1 writes and runs from the node tree) is run against a local
//   fake node with a LIVE id passed, and what reached the restart route is asserted.
// - R2: its block is run by bash with a curl shim, $ID set to a live id; R2b is asserted statically (its fetch goes to
//   the production relay, so it is not run here).
//   run: node --test test/hvnode-negative-probes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(REPO, "windows", "node", "ops", "hv-node-rollout");
const PS1 = fs.readFileSync(path.join(DIR, "hvnode-accept.ps1"), "utf8");
const SH = fs.readFileSync(path.join(DIR, "hvnode-accept-remote.sh"), "utf8");
const ZERO = "0x" + "0".repeat(64);
const LIVE = "0x31136008aa0cf1d826d223777bed396efdf73e89ee5c82a5aabce2ca1aeeeee3";   // test 1: a live production id

// the A9 check script exactly as the .ps1 writes it (Set-Content … -Value @' … '@)
function a9Script() {
  const m = PS1.match(/\$n1 = [^\n]*\n\s*Set-Content -Path \$n1 [^\n]*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(m, "the A9 here-string was not found in hvnode-accept.ps1");
  return m[1];
}
// a node that answers like the real one: 401 without a session, 404 for a session that is not the owner's
async function fakeNode() {
  const posts = [];
  const s = http.createServer((q, r) => {
    let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
      const u = new URL(q.url, "http://x"), j = (c, o) => { r.writeHead(c, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
      if (q.method === "GET" && u.pathname === "/v1/auth/nonce") return j(200, { message: `sign in ${u.searchParams.get("address")} ${crypto.randomUUID()}` });
      if (q.method === "POST" && u.pathname === "/v1/auth/login") return j(200, { token: "tok-" + crypto.randomUUID() });
      const m = u.pathname.match(/^\/v1\/deployments\/(0x[0-9a-fA-F]{64})\/restart$/);
      if (q.method === "POST" && m) { posts.push({ id: m[1].toLowerCase(), auth: !!q.headers.authorization }); return j(q.headers.authorization ? 404 : 401, {}); }
      j(404, {});
    });
  });
  await new Promise((res) => s.listen(0, "127.0.0.1", res));
  return { posts, base: `http://127.0.0.1:${s.address().port}`, close: () => s.close() };
}
function runA9(args) {
  // written inside the repo so `viem` resolves as it does from the node tree on the box
  const f = path.join(REPO, "test", `.n1check-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(f, a9Script());
  return new Promise((res) => execFile(process.execPath, [f, ...args], { timeout: 30_000 }, (err, stdout, stderr) => {
    fs.rmSync(f, { force: true });
    res({ err, stdout: stdout.trim(), stderr });
  }));
}

test("A9: with a LIVE id passed, both negative probes (no session, a stranger's session) hit ONLY the zero id", async () => {
  const n = await fakeNode();
  try {
    const r = await runA9([n.base, LIVE, ""]);
    assert.equal(r.err, null, r.stderr);
    assert.match(r.stdout, /^none=401 stranger=404$/);
    assert.deepEqual(n.posts, [{ id: ZERO, auth: false }, { id: ZERO, auth: true }]);
    assert.ok(!n.posts.some((p) => p.id === LIVE), "a negative probe carried the live id");
  } finally { n.close(); }
});

test("A9 -OwnerRestart: the negative probes still hit the zero id; ONLY the owner's deliberate restart carries the live id", async () => {
  const n = await fakeNode();
  const key = path.join(REPO, "test", `.owner-${crypto.randomUUID()}.key`);
  fs.writeFileSync(key, crypto.randomBytes(32).toString("hex"));
  try {
    const r = await runA9([n.base, LIVE, key]);
    assert.equal(r.err, null, r.stderr);
    assert.deepEqual(n.posts.map((p) => p.id), [ZERO, ZERO, LIVE]);
    assert.equal(n.posts[2].auth, true);
  } finally { fs.rmSync(key, { force: true }); n.close(); }
});

test("A9's verdicts: no session must be 401 (PASS/FAIL); the stranger is INFO, and only a 200 FAILS", () => {
  assert.match(PS1, /Check \(\$res -match '\(\^\| \)none=401\( \|\$\)'\)/);
  assert.doesNotMatch(PS1, /Check \(\$res -match '\(\^\| \)stranger=404/, "the stranger's 404 is still counted as a PASS");
  assert.match(PS1, /stranger=200[^\n]*Say 'FAIL'/);
});

test("R2 (relay, no session): with $ID set to a live id, curl is sent the ZERO id", () => {
  const block = SH.slice(SH.indexOf("ZERO_ID="), SH.indexOf("# R2b"));
  assert.ok(block.includes("curl"), "the R2 block was not found");
  const out = execFileSync("bash", ["-c", `set -u
ID=${LIVE}
curl() { printf '%s\\n' "$@" > "$CURLARGS"; echo 404; }
check() { echo "CHECK $1 $2"; }
${block}`], { env: { ...process.env, CURLARGS: path.join(REPO, "test", ".curlargs") }, encoding: "utf8" });
  const args = fs.readFileSync(path.join(REPO, "test", ".curlargs"), "utf8"); fs.rmSync(path.join(REPO, "test", ".curlargs"));
  assert.match(args, new RegExp(`/v1/deployments/${ZERO}/restart`));
  assert.ok(!args.includes(LIVE.slice(2)), "R2 sent the live id");
  assert.match(out, /^CHECK ok R2 \(relay\)/m);
});

test("R2b (relay, a stranger's session) is bound to the zero id and never reads $ID; it is INFO, a 200 FAILS", () => {
  assert.match(SH, /^ZERO_ID=0x0{64}$/m);
  const block = SH.slice(SH.indexOf("# R2b"), SH.indexOf("# R3"));
  assert.match(block, /RID="\$ZERO_ID" node/);
  assert.doesNotMatch(block, /\$\{?ID\b/, "R2b reads $ID");
  assert.match(block, /session\/200[\s\S]*check no/);
  assert.doesNotMatch(block, /session\/404\)?\s*c=ok|session\/401\|/, "R2b still counts a refusal as a PASS");
  // and nothing before R3 builds a restart URL from $ID
  assert.doesNotMatch(SH.slice(0, SH.indexOf("# R3")), /deployments\/\$\{?(ID|rid)\b/);
});
