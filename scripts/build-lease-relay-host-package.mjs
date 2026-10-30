// The lease-relay HOST ROLE package (network/host-services/lease-relay-host.mjs), in the host-service package format
// (enclave-host-service-package/v1): the reviewed relay release artifact (scripts/build-lease-relay-release.mjs, one esbuild
// bundle of network/lease-relay-service.mjs) and a manifest naming it. A host pins the manifest's sha256.
//   node scripts/build-lease-relay-host-package.mjs OUTDIR            writes OUTDIR/lease-relay.mjs and lease-relay.package.json
//   node scripts/build-lease-relay-host-package.mjs OUTDIR --check    rebuilds and refuses unless OUTDIR holds exactly those bytes
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [out, flag] = process.argv.slice(2);
if (!out || (flag && flag !== "--check")) { console.error("usage: build-lease-relay-host-package.mjs OUTDIR [--check]"); process.exit(2); }
const sha = (b) => createHash("sha256").update(b).digest("hex");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lease-relay-host-package-"));
try {
  execFileSync(process.execPath, [path.join(ROOT, "scripts/build-lease-relay-release.mjs"), tmp], { stdio: ["ignore", "ignore", "inherit"] });
  const release = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8"));
  const bundle = fs.readFileSync(path.join(tmp, "lease-relay.mjs"));
  if (sha(bundle) !== release.artifact.sha256) throw new Error("the release artifact does not match its manifest");
  const manifest = Buffer.from(JSON.stringify({
    format: "enclave-host-service-package/v1", role: "lease-relay", entry: "network/lease-relay-service.mjs", kind: "relay",
    runtime: "node>=22 (host role; not a wasm component)", bundle: "lease-relay.mjs", bundleSha256: sha(bundle), bytes: bundle.length,
    serves: "app-funded lease relaying for the ONE reviewed reserve/executor: GET /v1/info (with the relay key's signed statement), GET /v1/descriptor, POST /v1/lease",
    secrets: "one: the relay float key, generated on the host by `lease-relay-host.mjs init` (create-only, 0600), never imported, configured or printed",
    state: { durable: true, what: "the relay key and its unresolved signed send (relay-send.json; same bytes re-broadcast after a restart)", rebuild: "none: the key is not recoverable from elsewhere; a lost key loses only its capped float" },
    cold: ["two or more https Base RPC providers (the relay's quorum)", "the reviewed deployment record and its digest", "the relay key (its float, funded by the relay operator)"],
    notCold: ["discovery", "directories", "storage adapters", "other relays", "a lease", "any app", "any DigitalOcean endpoint"],
    release: { artifact: release.artifact, check: release.check }, inputs: release.inputs }, null, 1) + "\n");
  if (flag === "--check") {
    for (const [f, b] of [["lease-relay.mjs", bundle], ["lease-relay.package.json", manifest]])
      if (!fs.existsSync(path.join(out, f)) || !fs.readFileSync(path.join(out, f)).equals(b)) throw new Error(`${path.join(out, f)} is not the reproducible build`);
  } else {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "lease-relay.mjs"), bundle);
    fs.writeFileSync(path.join(out, "lease-relay.package.json"), manifest);
  }
  console.log(JSON.stringify({ out, package: "sha256:" + sha(manifest), bundleSha256: sha(bundle), bytes: bundle.length, inputs: Object.keys(release.inputs).length, checked: flag === "--check" }));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
