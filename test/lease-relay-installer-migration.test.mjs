// windows/installer/install-lease-relay.ps1 -ExpectedPayee (MIGRATION mode): a moved relay key is installed, never replaced
// or generated.
//   - EXECUTED (Windows with powershell.exe; skipped elsewhere: the installer's icacls/ACL steps are Windows-only): the real
//     installer, -NoTask, under scratch -ProgramRoot/-DataRoot, with a release built from this tree:
//     - an absent data directory, an absent key or an absent send record REFUSES and creates no key and no program files;
//     - with both present it installs and keeps them byte for byte;
//     - without -ExpectedPayee an empty directory still gets a new key (the default is unchanged).
//   - STATIC (every platform): the installer's TEXT orders the refusals before its first write. This checks the reviewed
//     structure, not behaviour; the executed cases and root's real PowerShell 5.1 parse are the behavioural proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PS1 = path.join(REPO, "windows/installer/install-lease-relay.ps1");
const src = fs.readFileSync(PS1, "utf8");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const PAYEE = "0x51ff183da8fF3b2dE08Da88331EED65e2F6A835c";
const havePs = process.platform === "win32" && spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"]).status === 0;
const W = { skip: !havePs && "needs Windows PowerShell (the installer's ACL steps are Windows-only)", timeout: 300_000 };

test("STATIC: every migration refusal comes before the installer's first write; the payee check stops and disables a wrong relay", () => {
  const at = (re) => { const m = re.exec(src); assert.ok(m, String(re)); return m.index; };
  const firstWrite = Math.min(...[/New-Item /, /Copy-Item /, /Set-Content /, /icacls\.exe/, /Register-ScheduledTask/, /writeFileSync/].map((re) => at(re)));
  const pre = at(/if \(\$Migrating\) \{\s*\n\s*# before anything is installed/);
  assert.ok(pre < firstWrite, "the moved key and send record are required before anything is written");
  const block = src.slice(pre, src.indexOf("\n}\n", pre));
  assert.match(block, /'relay\.key', 'relay-send\.json'/); assert.match(block, /throw "migration: \$mf is absent/); assert.match(block, /Length -eq 0\) \{ throw "migration: \$mf is empty"/);
  // the generator is unreachable in migration mode
  const gen = at(/generateKeyPairSync\('ec',\{namedCurve:'secp256k1'\}\)/);
  const guard = at(/elseif \(\$Migrating\) \{ throw "migration: \$keyFile is absent; no key is generated in migration mode" \}/);
  assert.ok(guard < gen && src.slice(guard, gen).split("\n").length <= 3, "the key generator sits behind the migration guard");
  // after the start: exactly the payee + the record's chain/reserve/executor, else stopped, disabled, exit 4
  const v = src.slice(at(/# migration: exactly the moved key, for exactly the reviewed deployment record/));
  for (const re of [/\[string\]\$info\.payee -eq \$ExpectedPayee/, /\[int64\]\$info\.chainId -eq \[int64\]\$rec\.chainId/, /\[string\]\$info\.reserve -eq \[string\]\$rec\.reserve/, /\[string\]\$info\.executor -eq \[string\]\$rec\.executor/]) assert.match(v, re);
  assert.match(v, /Stop-ScheduledTask[^\n]*\n\s*Disable-ScheduledTask[^\n]*\n[^\n]*REFUSED[^\n]*\n\s*exit 4/);
  // the default path is unchanged: without -ExpectedPayee an absent key is still generated, create-only
  assert.match(src, /fs\.writeFileSync\(process\.argv\[1\],d\.toString\('hex'\)\+'\\n',\{flag:'wx'\}\)/);
  assert.match(src, /\[string\]\$ExpectedPayee = ''/);
});

function release(dir) {
  const out = path.join(dir, "release");
  execFileSync(process.execPath, [path.join(REPO, "scripts/build-lease-relay-release.mjs"), out], { timeout: 120_000 });
  return { out, sha: JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")).artifact.sha256 };
}
function install(dir, rel, extra) {
  const rec = path.join(REPO, "test/fixtures/local-relay-migration/deployment.json");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, "-Release", rel.out, "-ArtifactSha256", rel.sha, "-Record", rec,
    "-Digest", "sha256:" + sha(fs.readFileSync(rec)), "-Rpcs", "https://a.example,https://b.example,https://c.example", "-Quorum", "2", "-MaxFloatEth", "0.0002", "-MinFloatEth", "0.00005",
    "-ProgramRoot", path.join(dir, "PF"), "-DataRoot", path.join(dir, "PD"), "-Node", process.execPath, "-NoTask", ...extra], { encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout + r.stderr };
}
const restrict = (d) => { fs.mkdirSync(d, { recursive: true }); execFileSync("icacls.exe", [d, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]); };

test("EXECUTED: migration mode refuses an absent directory, key or send record and generates nothing; with both it installs and keeps them", W, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-inst-")), rel = release(dir), data = path.join(dir, "PD", "lease-relay");
  try {
    let r = install(dir, rel, ["-ExpectedPayee", PAYEE]);
    assert.notEqual(r.code, 0); assert.match(r.out, /migration: .*relay\.key is absent/);
    assert.ok(!fs.existsSync(path.join(dir, "PF", "lease-relay")) && !fs.existsSync(path.join(data, "relay.key")), "nothing installed, no key generated");
    restrict(data); fs.writeFileSync(path.join(data, "relay-send.json"), "{}");
    r = install(dir, rel, ["-ExpectedPayee", PAYEE]);
    assert.notEqual(r.code, 0); assert.match(r.out, /relay\.key is absent/); assert.ok(!fs.existsSync(path.join(data, "relay.key")));
    fs.rmSync(path.join(data, "relay-send.json")); fs.writeFileSync(path.join(data, "relay.key"), "0x" + "ab".repeat(32) + "\n");
    r = install(dir, rel, ["-ExpectedPayee", PAYEE]);
    assert.notEqual(r.code, 0); assert.match(r.out, /relay-send\.json is absent/);
    fs.writeFileSync(path.join(data, "relay-send.json"), "{}");
    const k = sha(fs.readFileSync(path.join(data, "relay.key")));
    r = install(dir, rel, ["-ExpectedPayee", PAYEE]);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /existing relay key is kept/);
    assert.equal(sha(fs.readFileSync(path.join(data, "relay.key"))), k); assert.equal(fs.readFileSync(path.join(data, "relay-send.json"), "utf8"), "{}");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("EXECUTED: without -ExpectedPayee an empty directory still gets a new key (the default is unchanged)", W, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-inst-")), rel = release(dir);
  try {
    const r = install(dir, rel, []);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /new relay key was generated/);
    assert.ok(fs.statSync(path.join(dir, "PD", "lease-relay", "relay.key")).size > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
