// lease-relay-check.mjs - the lease relay release's configuration check (docs/network/lease-relay-release.md). The
// systemd unit runs it before every start (ExecStartPre); an operator can run it by hand. It has NO imports beyond
// node: builtins, so it runs from the release directory without node_modules.
//
// Every setting is explicit; nothing has a default (in particular no float, no quorum, no port):
//   LEASE_RELAY_RECORD, LEASE_RELAY_DIGEST    the reviewed deployment record file and its sha256 ("sha256:<hex>")
//   LEASE_RELAY_RPCS, LEASE_RELAY_QUORUM      2..16 distinct https RPCs and a strict majority of at least 2
//   LEASE_RELAY_MAX_FLOAT_ETH, _MIN_FLOAT_ETH the hot key's cap and refill threshold (min < max, both > 0)
//   LEASE_RELAY_LISTEN                        a loopback host:port; TLS is terminated in front of it
//   LEASE_RELAY_KEY_FILE                      owner-only (0600/0400) regular file; its CONTENT is never read here
//   LEASE_RELAY_ARTIFACT_SHA256               the reviewed lease-relay.mjs this directory must hold
//   LEASE_RELAY_STATE                         set by the unit (StateDirectory): the durable record of the key's unresolved send
// Exit 0 with a one-line summary, or 1 listing every problem. No RPC is contacted, no key is read, nothing is written.
// The state file holds only a signed transaction the relay already broadcast (public bytes), never the key.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const DECIMAL = /^(0|[1-9][0-9]{0,6})(\.[0-9]{1,18})?$/;
const wei = (s) => { const [i, f = ""] = s.split("."); return BigInt(i) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18)); };

/** The relay's persisted send state: null when it is exactly {} or one {nonce, raw, hash}; otherwise what is wrong. */
function sendRecordProblem(text) {
  let j; try { j = JSON.parse(text); } catch { return "not JSON"; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return "not an object";
  const keys = Object.keys(j).sort().join(",");
  if (keys === "") return null;
  if (keys !== "hash,nonce,raw") return `fields ${keys.slice(0, 80)}; expected exactly nonce, raw, hash or none`;
  if (!Number.isSafeInteger(j.nonce) || j.nonce < 0) return "nonce";
  if (typeof j.raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(j.raw)) return "raw";
  if (typeof j.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(j.hash)) return "hash";
  return null;
}

/** -> { ok, problems[], summary } for an environment object and the release directory holding lease-relay.mjs */
export function checkRelayConfig(env, { releaseDir, nodeVersion = process.versions.node } = {}) {
  const problems = [], need = (k) => { const v = String(env[k] ?? "").trim(); if (!v) problems.push(`${k} is not set (there is no default)`); return v; };
  if (Number(String(nodeVersion).split(".")[0]) < 20) problems.push(`node ${nodeVersion}: the release needs node 20 or later`);
  const recordFile = need("LEASE_RELAY_RECORD"), digest = need("LEASE_RELAY_DIGEST");
  if (digest && !/^sha256:[0-9a-f]{64}$/.test(digest)) problems.push("LEASE_RELAY_DIGEST must be sha256:<64 lowercase hex>");
  if (recordFile) {
    try {
      const st = fs.lstatSync(recordFile);
      if (!st.isFile() || st.size > 64 * 1024) problems.push(`${recordFile} must be a regular file of at most 64 KiB`);
      else {
        const bytes = fs.readFileSync(recordFile), got = "sha256:" + createHash("sha256").update(bytes).digest("hex");
        if (digest && got !== digest) problems.push(`${recordFile} is ${got}, not the reviewed ${digest}`);
        let j = null; try { j = JSON.parse(bytes); } catch { problems.push(`${recordFile} is not JSON`); }
        if (j && (j.format !== "enclave-lease-gas-deployment/v1" || !Number.isSafeInteger(j.chainId))) problems.push(`${recordFile} is not an enclave-lease-gas-deployment/v1 record`);
      }
    } catch (e) { problems.push(`${recordFile}: ${e.code || e.message}`); }
  }
  const rpcs = need("LEASE_RELAY_RPCS").split(",").map((s) => s.trim()).filter(Boolean), quorumRaw = need("LEASE_RELAY_QUORUM");
  if (rpcs.length && (rpcs.length < 2 || rpcs.length > 16)) problems.push(`LEASE_RELAY_RPCS lists ${rpcs.length} RPC(s): 2..16 independent providers are required`);
  const hosts = new Set();
  for (const u of rpcs) {
    let url = null; try { url = new URL(u); } catch { problems.push(`LEASE_RELAY_RPCS: ${u.slice(0, 80)} is not a URL`); continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) problems.push(`LEASE_RELAY_RPCS: ${url.origin} must be https, without credentials or fragment`);
    const id = url.host.toLowerCase().replace(/\.$/, "");
    if (hosts.has(id)) problems.push(`LEASE_RELAY_RPCS: ${id} appears twice (one provider is one vote)`);
    hosts.add(id);
  }
  if (quorumRaw) {
    const q = Number(quorumRaw);
    if (!/^[0-9]+$/.test(quorumRaw) || q < 2 || q > rpcs.length || q <= rpcs.length / 2) problems.push(`LEASE_RELAY_QUORUM=${quorumRaw} must be a strict majority (and at least 2) of the ${rpcs.length} RPCs`);
  }
  const maxF = need("LEASE_RELAY_MAX_FLOAT_ETH"), minF = need("LEASE_RELAY_MIN_FLOAT_ETH");
  for (const [k, v] of [["LEASE_RELAY_MAX_FLOAT_ETH", maxF], ["LEASE_RELAY_MIN_FLOAT_ETH", minF]]) if (v && (!DECIMAL.test(v) || wei(v) === 0n)) problems.push(`${k}=${v} must be a positive decimal ETH amount`);
  if (DECIMAL.test(maxF) && DECIMAL.test(minF) && wei(minF) >= wei(maxF)) problems.push(`LEASE_RELAY_MIN_FLOAT_ETH=${minF} must be below LEASE_RELAY_MAX_FLOAT_ETH=${maxF}`);
  const listen = need("LEASE_RELAY_LISTEN");
  if (listen) {
    const m = /^(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/.exec(listen);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) problems.push(`LEASE_RELAY_LISTEN=${listen} must be 127.0.0.1:PORT or [::1]:PORT (an explicit port; TLS is terminated in front)`);
  }
  const keyFile = need("LEASE_RELAY_KEY_FILE");
  if (keyFile) {
    try {
      const st = fs.statSync(keyFile);
      if (!st.isFile()) problems.push(`${keyFile} is not a regular file`);
      else if (process.platform !== "win32" && (st.mode & 0o077)) problems.push(`${keyFile} is mode ${(st.mode & 0o777).toString(8)}: it must be readable by its owner only`);
      else if (st.size > 256) problems.push(`${keyFile} is ${st.size} bytes: one hex key is expected`);
    } catch (e) { problems.push(`${keyFile}: ${e.code || e.message}`); }
  }
  // the durable record of this key's last signed, unresolved transaction: a restarted relay re-broadcasts THOSE bytes
  // instead of signing anew at that nonce, so it must live on durable storage the service can write (the unit's StateDirectory)
  const stateFile = need("LEASE_RELAY_STATE");
  let pendingSend = null;
  if (stateFile) {
    if (!path.isAbsolute(stateFile)) problems.push(`LEASE_RELAY_STATE=${stateFile} must be an absolute path`);
    else {
      try { if (!fs.statSync(path.dirname(stateFile)).isDirectory()) problems.push(`${path.dirname(stateFile)} is not a directory`); }
      catch (e) { problems.push(`LEASE_RELAY_STATE directory ${path.dirname(stateFile)}: ${e.code || e.message}`); }
      try {
        const st = fs.lstatSync(stateFile);
        if (!st.isFile() || st.size > 64 * 1024) problems.push(`${stateFile} must be a regular file of at most 64 KiB`);
        else {
          // exactly {} or {nonce, raw, hash} (the shapes the relay writes); the service also checks keccak256(raw) = hash, and
          // that the transaction is its own key's on this chain at that nonce - this check has no keccak and reads no key
          const why = sendRecordProblem(fs.readFileSync(stateFile, "utf8"));
          if (why) problems.push(`${stateFile} is not a relay send record (${why}): settle it by hand`);
          else { const j = JSON.parse(fs.readFileSync(stateFile, "utf8")); if (j.raw) pendingSend = `${j.hash.slice(0, 18)}... at nonce ${j.nonce}`; }
        }
      } catch (e) { if (e.code !== "ENOENT") problems.push(`${stateFile}: ${e.code || e.message}`); }
    }
  }
  const want = need("LEASE_RELAY_ARTIFACT_SHA256");
  if (want && !/^[0-9a-f]{64}$/.test(want)) problems.push("LEASE_RELAY_ARTIFACT_SHA256 must be 64 lowercase hex");
  else if (want && releaseDir) {
    try {
      const got = createHash("sha256").update(fs.readFileSync(path.join(releaseDir, "lease-relay.mjs"))).digest("hex");
      if (got !== want) problems.push(`${path.join(releaseDir, "lease-relay.mjs")} is ${got}, not the reviewed ${want}`);
    } catch (e) { problems.push(`lease-relay.mjs: ${e.code || e.message}`); }
  }
  const summary = problems.length ? null
    : `lease relay configuration ok: record ${digest.slice(7, 19)}..., ${rpcs.length} RPCs (quorum ${quorumRaw}), float ${minF}..${maxF} ETH, listen ${listen}, artifact ${want.slice(0, 12)}...${pendingSend ? `; unresolved send ${pendingSend} (re-broadcast before any new one)` : ""}`;
  return { ok: !problems.length, problems, summary };
}

// run directly (also through a symlinked release directory: both sides compared as real paths)
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(self)) {
  const r = checkRelayConfig(process.env, { releaseDir: path.dirname(fs.realpathSync(self)) });
  if (r.ok) console.log(r.summary);
  else { for (const p of r.problems) console.error(`[lease-relay-check] ${p}`); process.exitCode = 1; }
}
