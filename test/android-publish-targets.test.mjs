import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(root, "scripts/publish-android-host.sh");
const cert = "867ebe7da4c41fa5186996ac443dfde14f435d6f1ce9da98681199d86929523d";

// Stub APK tooling and SSH: these tests verify target selection, refusal gates and command ordering,
// not APK cryptography or production delivery. No network connection or signing key is used.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "android-publish-"));
  const bin = path.join(dir, "bin"), sdk = path.join(dir, "sdk"), bt = path.join(sdk, "build-tools/35.0.0");
  fs.mkdirSync(bin); fs.mkdirSync(bt, { recursive: true });
  const exe = (name, contents) => fs.writeFileSync(name, "#!/bin/bash\nset -eu\n" + contents, { mode: 0o755 });
  for (const name of ["ssh", "scp"]) exe(path.join(bin, name),
    `printf '%s' '${name}' >> "$TRACE"\nprintf ' <%s>' "$@" >> "$TRACE"\nprintf '\\n' >> "$TRACE"\n` +
    (name === "ssh" ? 'if [[ "$*" == *"sha256sum -c"* ]] && [ "${FAIL_CHECKSUM:-0}" = 1 ]; then exit 1; fi\n' : ""));
  exe(path.join(bt, "aapt2"), 'test "${BAD_MANIFEST:-0}" = 0\nprintf \'%s\\n\' "${MANIFEST_TEXT:-manifest}"\n');
  exe(path.join(bt, "apksigner"), `test "\${BAD_SIGNER:-0}" = 0\nprintf '%s\\n' 'Signer #1 certificate SHA-256 digest: ${cert}'\n`);
  exe(path.join(bin, "python3"), `printf '%064d\\n' 0\n`);
  const apk = path.join(dir, "release.apk"); fs.writeFileSync(apk, "fixture APK"); fs.writeFileSync(apk + ".idsig", "fixture signature");
  const trace = path.join(dir, "trace");
  const run = (args, extra = {}) => spawnSync("bash", [script, apk, "2026.10.20.1", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ANDROID_HOME: sdk, TRACE: trace, ...extra },
  });
  return { run, calls: () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "", close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("Android publishing requires explicit safe targets and directories before any transport", () => {
  const f = fixture();
  try {
    for (const args of [[], ["--target", "-oProxyCommand=bad"], ["--target", "box;bad"],
      ["--target", "box", "--directory", "/srv/../etc"], ["--target", "box", "--directory", "/srv/x;bad"]]) {
      assert.equal(f.run(args).status, 2, JSON.stringify(args));
      assert.equal(f.calls(), "");
    }
  } finally { f.close(); }
});

test("unreadable, debuggable or incorrectly signed APKs never reach a target", () => {
  const f = fixture();
  try {
    for (const env of [{ BAD_MANIFEST: "1" }, { MANIFEST_TEXT: "debuggable(0x0101000f)=true" }, { BAD_SIGNER: "1" }]) {
      assert.equal(f.run(["--target", "releases-a"], env).status, 2);
      assert.equal(f.calls(), "");
    }
  } finally { f.close(); }
});

test("same release reaches both explicit targets; checksum check precedes publishing latest", () => {
  const f = fixture();
  try {
    const r = f.run(["--target", "u@releases-a", "--target", "releases-b", "--directory", "/srv/android"]);
    assert.equal(r.status, 0, r.stderr);
    const lines = f.calls().trim().split("\n");
    assert.equal(lines.length, 10);
    for (const [i, host] of [[0, "u@releases-a"], [5, "releases-b"]]) {
      for (const line of lines.slice(i, i + 5)) assert.ok(line.includes(host));
      assert.match(lines[i + 1], /Enclave-2026\.10\.20\.1\.apk/);
      assert.match(lines[i + 2], /sha256sum -c/);
      assert.match(lines[i + 3], /latest\.json\.tmp/);
      assert.match(lines[i + 4], /mv latest\.json\.tmp latest\.json/);
    }
    assert.ok(!f.calls().includes("nan"));
  } finally { f.close(); }
});

test("a remote checksum failure does not publish latest or proceed to another target", () => {
  const f = fixture();
  try {
    assert.equal(f.run(["--target", "releases-a", "--target", "releases-b"], { FAIL_CHECKSUM: "1" }).status, 1);
    assert.equal(f.calls().trim().split("\n").length, 3);
    assert.ok(!f.calls().includes("latest.json"));
    assert.ok(!f.calls().includes("releases-b"));
  } finally { f.close(); }
});
