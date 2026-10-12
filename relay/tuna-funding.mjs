// relay/tuna-funding.mjs -- the platform funds the TUNA privacy wallets of an open-market Windows (Enclave Shield) host.
//
// Every app such a host serves reaches the internet only through its own TUNA circuits, paid in NKN from six wallets per
// app (two slots x guard/public/egress), and the host's control channel from two more. A host owner holds no NKN, so the
// platform's funding wallet pays (the top-up job on the platform's own machine, network/tuna-funding-sync.mjs). This module
// is the only way a host asks for that:
//
//   POST /v1/hosts/tuna-funding  { name, purpose: "control" | "app", deploymentId?, addresses: [NKN...], nonce, sig }
//
// signed by the box's ATTESTED transport key (the scheme of relay/host-sponsor.mjs), from a box this relay holds as a
// TPM-attested hv-node whose name is registered to the key that signed its attach (its owner-only operator). "control" is
// once per TPM (two wallets); "app" is per deployment that is active, public and leased to THIS box now (six wallets).
// Caps: APPS_PER_HOST_PER_DAY and APPS_PER_DAY new app entries, so a host minting deployments to itself drains a bounded
// amount. A repeated request for the same label and wallets is answered as already recorded; other wallets for a label
// already recorded are refused unless the deployment moved to another host (control: unless the record is 30 days old).
//
// Granted requests are recorded in `file` (JSON); the sync job reads that file over SSH and appends top-up targets. Nothing
// here moves funds, and nothing here is served to anyone: the file is the platform's own queue.
import fs from "node:fs";
import path from "node:path";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export const FUNDING = Object.freeze({ control: { wallets: 2, nkn: "0.05" }, app: { wallets: 6, nkn: "0.25" } });
export const LIMITS = Object.freeze({ appsPerHostPerDay: 8, appsPerDay: 60, controlRenewDays: 30 });
const NKN_ADDR = /^NKN[1-9A-HJ-NP-Za-km-z]{33}$/, ID = /^0x[0-9a-f]{64}$/, DAY = 86_400_000;
const bad = (status, error, message) => ({ status, body: { error, message } });

/** The canonical message a box signs for a funding request (its attested transport key). */
export function fundingMessage(name, purpose, deploymentId, addresses, nonce) {
  return ["enclave-tuna-funding/1", name, purpose, deploymentId || "-", addresses.join(","), nonce].join("\n");
}
/** The top-up label: per TPM for control, per deployment for an app. */
export const fundingLabel = (purpose, key) => purpose === "control" ? `ctl-${key.slice(0, 16)}` : `sh-${key.slice(2, 14)}`;

/**
 * tunaFunding({ hub, file, confirmRow, runnerOf, limits, now, log }) -> { request(body) -> { status, body }, entries() }.
 * `confirmRow(id)` reads the deployment from the ledger (relay/api-relay.js confirmRow); `runnerOf(name)` answers the
 * registry id a box under that tunnel name registers (keccak256 of its endpoint).
 */
export function tunaFunding({ hub, file, confirmRow, runnerOf, limits = LIMITS, now = Date.now, log = () => {} }) {
  if (!file) throw new Error("tunaFunding: a state file is required");
  const seen = new Map();
  let state = { version: 1, targets: {} };
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j && j.version === 1 && j.targets && typeof j.targets === "object") state = j; }
  catch (e) { if (e.code !== "ENOENT") throw new Error(`tunaFunding: ${file} is unreadable: ${e.message}`); }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file);
  };

  function caller(b) {
    const name = String(b.name || "");
    const t = hub && hub.info ? hub.info(name) : null;
    if (!t || !t.spki) return bad(404, "unknown_tunnel", "no attested tunnel by that name");
    if (t.mode !== "hv-node" || !/^[0-9a-f]{64}$/.test(String(t.hvNode?.boot?.ekCertSha256 || "")))
      return bad(403, "not_hardware_attested", "TUNA funding is for a box that proved its hardware (a TPM-attested hv-node) on this relay");
    if (!/^0x[0-9a-f]{40}$/.test(String(t.hvOperator || "")))
      return bad(403, "not_registered", "this box's name is not registered to the key that signed its attach (yet): register first");
    if (typeof b.nonce !== "string" || !/^[0-9a-f]{32,128}$/.test(b.nonce) || b.nonce.length % 2)
      return bad(400, "bad_nonce", "nonce must be 16..64 bytes lowercase hex");
    const cut = now() - 600_000;
    for (const [k, at] of seen) if (at < cut) seen.delete(k);
    if (seen.has(b.nonce)) return bad(409, "replayed", "that request nonce was used already");
    const purpose = b.purpose, spec = FUNDING[purpose];
    if (!spec || !Object.hasOwn(FUNDING, purpose)) return bad(400, "bad_purpose", 'purpose must be "control" or "app"');
    const addresses = Array.isArray(b.addresses) ? b.addresses.map(String) : [];
    if (addresses.length !== spec.wallets || addresses.some((a) => !NKN_ADDR.test(a)) || new Set(addresses).size !== addresses.length)
      return bad(400, "bad_addresses", `${purpose} funding is for exactly ${spec.wallets} distinct NKN wallet addresses`);
    const deploymentId = purpose === "app" ? String(b.deploymentId || "").toLowerCase() : "";
    if (purpose === "app" && !ID.test(deploymentId)) return bad(400, "bad_deployment", "deploymentId must be the bytes32 deployment id");
    let key, ok = false;
    try { key = createPublicKey({ key: Buffer.from(t.spki, "base64"), format: "der", type: "spki" }); }
    catch { return bad(403, "bad_key", "the tunnel's transport key is not a public key"); }
    try {
      ok = cryptoVerify(key.asymmetricKeyType === "ed25519" ? null : "sha256", Buffer.from(fundingMessage(name, purpose, deploymentId, addresses, b.nonce)),
                        key, Buffer.from(String(b.sig || ""), "hex"));
    } catch {}
    if (!ok) return bad(403, "bad_signature", "the request is not signed by this tunnel's attested transport key");
    seen.set(b.nonce, now());
    return { name, purpose, spec, addresses, deploymentId, ek: t.hvNode.boot.ekCertSha256 };
  }

  async function request(b) {
    if (!b || typeof b !== "object") return bad(400, "bad_json", "a JSON object is required");
    const c = caller(b);
    if (c.status) return c;
    const label = fundingLabel(c.purpose, c.purpose === "control" ? c.ek : c.deploymentId);
    if (c.purpose === "app") {
      let d, runner;
      try { [d, runner] = await Promise.all([confirmRow(c.deploymentId), runnerOf(c.name)]); }
      catch (e) { return e.code === "no_deployment" ? bad(403, "not_leased_here", "the ledger holds no such deployment")
                                                  : bad(503, "ledger_unavailable", `the ledger could not be read: ${e.message}`); }
      if (!d || d.active !== true || d.isPublic !== true || !runner || String(d.runner || "").toLowerCase() !== String(runner).toLowerCase() ||
          !(Number(d.leaseUntil) * 1000 > now()))
        return bad(403, "not_leased_here", "the deployment is not active, public and leased to this box now");
    }
    const old = state.targets[label];
    const same = old && JSON.stringify(old.addresses) === JSON.stringify(c.addresses);
    if (same) return { status: 200, body: { label, nkn: old.nkn, recorded: old.at, already: true } };
    if (old) {
      const replace = c.purpose === "app" ? old.host !== c.name : now() - Date.parse(old.at) > limits.controlRenewDays * DAY;
      if (!replace) return bad(409, "already_funded", `${label} is funded for other wallets already`);
    }
    if (c.purpose === "app") {
      const since = now() - DAY, recent = Object.values(state.targets).filter((e) => e.purpose === "app" && Date.parse(e.at) > since);
      if (recent.filter((e) => e.host === c.name).length >= limits.appsPerHostPerDay)
        return bad(429, "host_daily_cap", `this host has ${limits.appsPerHostPerDay} app fundings in the last 24 hours; try again later`);
      if (recent.length >= limits.appsPerDay) return bad(429, "daily_cap", "the platform's daily TUNA funding is used up; try again later");
    }
    state.targets[label] = { purpose: c.purpose, host: c.name, ...(c.deploymentId ? { deploymentId: c.deploymentId } : {}),
                             nkn: c.spec.nkn, addresses: c.addresses, at: new Date(now()).toISOString() };
    save();
    log(`[tuna-funding] ${c.name}: ${c.purpose} ${label} recorded (${c.addresses.length} x ${c.spec.nkn} NKN)${old ? " (replacing " + old.host + "'s)" : ""}`);
    return { status: 201, body: { label, nkn: c.spec.nkn, recorded: state.targets[label].at } };
  }
  return { request, entries: () => JSON.parse(JSON.stringify(state.targets)) };
}

/** The relay's route: POST /v1/hosts/tuna-funding; off (404) unless configured. */
export function tunaFundingRouter({ funding, json, readBody }) {
  return async (req, res, url) => {
    if (url.pathname !== "/v1/hosts/tuna-funding") return false;
    if (!funding) { json(res, 404, { error: "not_offered", message: "this relay funds no TUNA wallets" }); return true; }
    if (req.method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
    let b;
    try { b = JSON.parse(String(await readBody(req, 16 * 1024))); } catch { json(res, 400, { error: "bad_json" }); return true; }
    const r = await funding.request(b);
    json(res, r.status, r.body);
    return true;
  };
}
