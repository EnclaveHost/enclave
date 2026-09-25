# S3b, ON nan as root, fed on stdin to `bash -s`: nothing secret in argv or on stdout, and the seed never leaves this host.
# Agreed with enclave-99 (format, path, procedure). Generates ONLY if no release key exists; never overwrites or rotates.
set -euo pipefail; umask 077
D=/etc/nan-relay; F=$D/secrets-release-signing.seed
RU=$(systemctl show enclave-api-relay.service -p User --value); RU=${RU:-root}
echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ) host=$(hostname) relay_user=$RU"
hits=$(grep -lE '^SECRETS_RELEASE_SIGNING_KEY(_FILE)?=' $D/*.env 2>/dev/null || true)
echo "exists_file=$([ -e "$F" ] && echo yes || echo no) env_files_naming_a_key=[${hits}]"
if [ -e "$F" ] || [ -n "$hits" ]; then echo "EXISTING KEY: STOP (no generation, no overwrite, no rotation)"; MODE=existing; else MODE=new; fi
RUID=$(id -u "$RU"); RGID=$(id -g "$RU")
node - "$MODE" "$F" "$D" "$RUID" "$RGID" <<'JS'
const fs = require("fs"), c = require("crypto"), path = require("path");
const [mode, F, D, uid, gid] = process.argv.slice(2);
const derive = (hex) => {
  const key = c.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(hex, "hex")]), format: "der", type: "pkcs8" });
  const spki = c.createPublicKey(key).export({ type: "spki", format: "der" }); const pub = spki.subarray(spki.length - 32);
  const sha = c.createHash("sha256").update(pub).digest("hex"); return { pub: pub.toString("hex"), sha, keyId: sha.slice(0, 16) };
};
// the derivation, checked on enclave-99's vector before it touches anything real
const v = derive("66".repeat(32));
if (v.pub !== "34b4d9043156cb6dcf0beb0a2949b7559c940d2bcb6dbe8c53a9b30278e3a746" || v.keyId !== "f7b7676c94df7e8f") { console.log("VECTOR_FAILED"); process.exit(6); }
const report = (hex, src) => {
  const d = derive(hex); console.log(`PUBLIC_KEY_HEX=${d.pub}\nPUBLIC_KEY_SHA256=${d.sha}\nKEY_ID=${d.keyId}\nSEED_SOURCE=${src}`); return d;
};
const shape = (hex) => /^[0-9a-f]{64}$/.test(hex);
if (mode === "existing") {
  if (!fs.existsSync(F)) { console.log("an env file names a key; not deriving from env here: report the path only"); process.exit(0); }
  const hex = fs.readFileSync(F, "utf8").trim().toLowerCase(); if (!shape(hex)) { console.log("EXISTING_FILE_SHAPE=BAD"); process.exit(5); }
  report(hex, "existing-file");
} else {
  const seed = c.randomBytes(32), hex = seed.toString("hex");
  // a key of its own: never equal to another key this relay holds (trim, lowercase, hex equality; nothing printed)
  for (const e of fs.readdirSync(D).filter((n) => n.endsWith(".env")))
    for (const line of fs.readFileSync(path.join(D, e), "utf8").split("\n")) {
      const m = /^(RELAY_TXT_KEY|DNS_TXT_KEY|SECRETS_KEY|CERTS_KEY)=(.*)$/.exec(line);
      if (m && m[2].trim().replace(/^["']|["']$/g, "").toLowerCase() === hex) { console.log(`REFUSED: equals ${m[1]} in ${e}`); process.exit(3); }
    }
  const before = derive(hex);
  const tmp = path.join(D, `.secrets-release-signing.seed.${c.randomBytes(6).toString("hex")}`);
  const fd = fs.openSync(tmp, "wx", 0o600);                      // O_CREAT|O_EXCL, 0600 from the first byte
  try { fs.writeSync(fd, hex + "\n"); fs.fsyncSync(fd); fs.fchownSync(fd, Number(uid), Number(gid)); fs.fchmodSync(fd, 0o600); }
  finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, F); }                                   // link(2): EEXIST rather than clobber
  catch (e) { fs.unlinkSync(tmp); console.log(`REFUSED: ${F} appeared meanwhile (${e.code}); nothing overwritten`); process.exit(4); }
  fs.unlinkSync(tmp); const dfd = fs.openSync(D, "r"); fs.fsyncSync(dfd); fs.closeSync(dfd);
  console.log(`GENERATED ${F}`);
  const after = report(fs.readFileSync(F, "utf8").trim(), "new-file");
  if (after.pub !== before.pub) { console.log("PLACED_FILE_MISMATCH"); process.exit(7); }
  console.log("PLACED_FILE_MATCHES_GENERATED_KEY=yes");
}
const st = fs.statSync(F);
console.log(`FILE_MODE=${(st.mode & 0o7777).toString(8)} FILE_UID=${st.uid} FILE_GID=${st.gid} FILE_SIZE=${st.size} REGULAR=${st.isFile()}`);
if ((st.mode & 0o077) !== 0 || st.size !== 65 || !st.isFile()) { console.log("FILE_POLICY=BAD"); process.exit(8); }
console.log("FILE_POLICY=ok (regular, no group/other bits, 65 bytes)");
JS
echo "owner=$(stat -c %U:%G "$F" 2>/dev/null) done at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
