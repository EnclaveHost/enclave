// Shared pieces of the platform API activation helpers (work/platform-api-activation-closeout). Root runs these; nothing here
// was executed against production. Every helper prints names, counts and digests only: never a credential, a state file or
// a state file NAME (relay file names can carry account identifiers).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

/** the reviewed enclave tree the helpers import from (default: work/enclave beside this directory) */
export const TREE = path.resolve(process.env.ENCLAVE_TREE || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../enclave"));
export const load = (rel) => import(pathToFileURL(path.join(TREE, rel)).href);

export const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
export const MIB = 1024 * 1024;

// What the bundled relay reads (../env-read-inventory.json: every literal process.env read and every string-literal call of a
// local env helper, over the API bundle's 87 non-node_modules inputs; 201 names). The 15 names below are the credentials the
// first inventory listed; the CLASSIFICATION RULE, not the list, decides what is a credential: the bound-config validator's
// SECRET_NAME (metal/guest/measured-control.mjs) PLUS plural TOKENS (METAL_TUNNEL_TOKENS slips past that regex), secret
// *_FILE names, and webhook URLs. A credential travels ONLY in the admin-signed sealed package; everything else read by the
// relay goes to the bound (public) platformApi.relayEnv; names the role sets itself are dropped.
export const CREDENTIAL_NAMES = Object.freeze(["ACME_EAB_HMAC", "ACME_EAB_KID", "BILLING_ADMIN_TOKEN", "DNS_TXT_KEY", "HOST_SPONSOR_BUNDLER_KEY",
  "HOST_SPONSOR_VERIFIER_KEY", "PROVISIONER_PRIVATE_KEY", "SECRETS_KEY", "SECRETS_RELEASE_PREDICT_SEED", "SECRETS_RELEASE_SIGNING_KEY_FILE",
  "SESSIONS_RELAYER_KEY", "SSO_SIGNER_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "UPLOAD_KEY"]);
const INV = JSON.parse(fs.readFileSync(new URL("../env-read-inventory.json", import.meta.url), "utf8"));
export const READ_NAMES = Object.freeze(Object.keys(INV.names).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k)));
export const ROLE_OWNED = Object.freeze(["AUTH_DATA_DIR", "API_RELAY_PORT", "API_RELAY_BIND", "STATE_DIRECTORY", "PLATFORM_API_ROLE", "PATH", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"]);
const SECRET_NAME = /(^|_)(KEY|SECRET|TOKEN|TOKENS|PASSWORD|PRIVATE|HMAC|SEED|MNEMONIC|EAB)(_|$)/;
export const isCredential = (k) => SECRET_NAME.test(k) || k === "ALERT_WEBHOOK_URL" || (k.endsWith("_FILE") && k !== "FEATURED_VIEWS_FILE");
export const PUBLIC_NAMES = Object.freeze(READ_NAMES.filter((k) => !isCredential(k) && !ROLE_OWNED.includes(k)));
// The guest's replicated data directory (metal/guest/measured-control.mjs platformApiDir + "/data"; the relay's cwd).
export const GUEST_DATA = "/run/measured-control/platform-api/data";
// Relay state that lives OUTSIDE AUTH_DATA_DIR on an ordinary box. In the guest it must sit inside GUEST_DATA to be replicated,
// so relayEnv points it there and the export imports it at `rel`. ROUTE_STATE_DIR is needed even when unset: its default
// (/var/lib/enclave-relay/route-state) is outside the data directory.
export const OUTSIDE_STATE = Object.freeze([
  { name: "ROUTE_STATE_DIR", rel: "route-state", dflt: "/var/lib/enclave-relay/route-state", always: true },
  { name: "LEASE_GENERATION_STATE", rel: "lease-generation-state.json", dflt: null, always: false },
  { name: "FEATURED_VIEWS_FILE", rel: "featured-views.json", dflt: null, always: false, relativeOk: true },
]);
// caches the guest rebuilds (the default lands inside the data directory): dropped, not imported
export const DROPPED_CACHES = Object.freeze(["RELAY_VERIFIER_CACHE_DIR", "RELAY_REVERIFY_CACHE_DIR"]);
// public names whose old value may be a host path that does not exist in the guest (prediction must use the remote gateways)
export const HOST_PATH_NAMES = Object.freeze(["SECRETS_RELEASE_PREDICT_PATH", "SECRETS_RELEASE_PREDICT_WORK", "SECRETS_RELEASE_PREDICT_REPO",
  "SECRETS_RELEASE_SEV_SNP_MEASURE"]);

// The replica's own rules (relay/state-replica.mjs): SAFE_REL paths only; *.tmp and .replica* are never replicated;
// symlinks and special files are skipped by scanDir. A cutover must not silently drop any of them, so the helpers REFUSE.
export const SAFE_REL = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._@+=-][A-Za-z0-9._@+=\/-]{0,511}$/;
export const REPLICA_SKIPPED = (name) => name.endsWith(".tmp") || name.startsWith(".replica");
export const ROLE_FILE = "platform-credentials.json"; // CREDENTIALS_FILE in metal/guest/platform-api-role.mjs, held in the data dir

/** walk a directory with lstat: -> { files: [{ rel, size }], dirs, symlinks, special, skippedNames, unsafe } (never follows links) */
export function walk(dir, prefix = "") {
  const out = { files: [], dirs: 0, symlinks: 0, special: 0, skippedNames: 0, unsafe: 0 };
  const rec = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isSymbolicLink()) { out.symlinks++; continue; }
      if (e.isDirectory()) { if (REPLICA_SKIPPED(e.name)) { out.skippedNames++; continue; } out.dirs++; rec(r); continue; }
      if (!e.isFile()) { out.special++; continue; }
      if (REPLICA_SKIPPED(e.name)) { out.skippedNames++; continue; }
      const rel2 = prefix ? prefix + "/" + r : r;
      if (!SAFE_REL.test(rel2)) { out.unsafe++; continue; }
      out.files.push({ rel: rel2, abs: path.join(dir, r), size: fs.lstatSync(path.join(dir, r)).size });
    }
  };
  rec("");
  out.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** the data directory plus out-of-directory state imported at `rel` ([{ rel, src }], src a file or a directory): one walk result */
export function collect(dataDir, extras = []) {
  const all = walk(dataDir);
  for (const { rel, src } of extras) {
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) { all.symlinks++; continue; }
    if (st.isDirectory()) {
      const w = walk(src, rel);
      for (const k of ["dirs", "symlinks", "special", "skippedNames", "unsafe"]) all[k] += w[k];
      all.files.push(...w.files);
    } else if (st.isFile() && SAFE_REL.test(rel)) all.files.push({ rel, abs: src, size: st.size });
    else all.unsafe++;
  }
  const seen = new Set();
  all.collisions = 0;
  for (const f of all.files) { if (seen.has(f.rel)) all.collisions++; seen.add(f.rel); }
  all.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return all;
}

/** the opaque tree digest: sha256 over sorted "sha256(rel) sha256(content) size" lines; names never appear in the output */
export function treeManifest(files, { exclude = [] } = {}) {
  const entries = [];
  for (const f of files) {
    if (exclude.includes(f.rel)) continue;
    const data = fs.readFileSync(f.abs);
    entries.push({ p: sha256Hex(f.rel), sha: sha256Hex(data), size: data.length });
  }
  entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  const treeSha256 = sha256Hex(entries.map((e) => `${e.p} ${e.sha} ${e.size}\n`).join(""));
  return { files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0), treeSha256, entries };
}

/** an exact upper estimate of the sealed genesis package for these files (the 64 MiB caps: openMessage and readBody) */
export function packageEstimate(files, credentialsBytes = 0) {
  const b64 = (n) => 4 * Math.ceil(n / 3);
  let archiveJson = 256 + b64(credentialsBytes + 128) + 40;
  for (const f of files) archiveJson += JSON.stringify(f.rel).length + 4 + b64(f.size);
  const archive = archiveJson + 28;
  return { archiveBytes: archive, packageBodyBytes: b64(archive) + 2048, capBytes: 64 * MIB };
}

export function args(argv, { multi = [] } = {}) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const k = a.slice(2), v = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    if (multi.includes(k)) (o[k] ||= []).push(v); else o[k] = v;
  }
  return o;
}
/** write a file that must not exist yet, 0600 */
export function writeNew(file, data) { fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" }); }
export function mkdirNew(dir) {
  if (fs.existsSync(dir)) throw new Error(`${dir} exists: refusing to write into an existing directory`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
export const die = (msg, code = 2) => { console.error(`[closeout] ${msg}`); process.exit(code); };
