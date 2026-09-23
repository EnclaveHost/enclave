// ROLLOUT STEP 2 / ROLLBACK - point the risc-box deployment at an artifact + snapshot key. Rewrites the
// two operator-override lines in node-config.cmd (backup kept beside it). Takes effect on the next node
// start (rbstart.ps1); host.mjs reads both from the environment. No secrets are on these lines.
// Usage: node rbswitch.mjs <wasm file> <sha256> <snapshot key>
import fs from "node:fs";
import crypto from "node:crypto";
const P = "C:\\Users\\claude\\vbs\\node\\node-config.cmd";
const ID = "0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b";
const [file, sha, snap] = process.argv.slice(2);
if (!file || !/^[0-9a-f]{64}$/.test(sha || "") || !snap) { console.log("usage: rbswitch.mjs <wasm> <sha256> <snapshot key>"); process.exit(2); }
const real = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
if (real !== sha) { console.log(`REFUSING: ${file} hashes to ${real}, not ${sha}`); process.exit(3); }
let t = fs.readFileSync(P, "utf8");
const bak = `${P}.${new Date().toISOString().replace(/[:.]/g, "")}.bak`;
fs.writeFileSync(bak, t);
const art = `set ENCLAVE_APP_ARTIFACT_PATCH={"${ID}":{"file":"${file.replace(/\\/g, "/")}","sha256":"${sha}"}}`;
const cfg = `set ENCLAVE_APP_CONFIG_PATCH={"${ID}":{"realtime":false,"snapshot":"${snap}"}}`;
for (const [re, line] of [[/^set ENCLAVE_APP_ARTIFACT_PATCH=.*$/m, art], [/^set ENCLAVE_APP_CONFIG_PATCH=.*$/m, cfg]]) {
  if (!re.test(t)) { console.log(`no existing line for ${re} - not touching the file`); process.exit(4); }
  t = t.replace(re, line);
}
fs.writeFileSync(P, t);
console.log(`backup: ${bak}`);
for (const l of t.split(/\r?\n/)) if (/ENCLAVE_APP_(ARTIFACT|CONFIG)_PATCH/.test(l)) console.log("  " + l);
