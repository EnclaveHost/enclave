// windows/node/hvcert.mjs - M4 on the NucBox hv node: a WebPKI certificate for each isolated partition's OWN key, so a
// browser reaches <id8>.app.enclave.host without a warning while its TLS still ends in the partition and its private key
// never leaves it.
//
// The node is the only party that may ask the platform certificate service for a deployment's name (it holds the lease
// and the operator key the service checks), and the partition is the only party that holds the key. So the node
// RELAYS, exactly as the Linux supervisor does, with the same code (isolation/m4/guestd/supervisor-guestcert.mjs
// ensureGuestCert): it fetches the domain's CSR over a TLS session on the partition's verified key, has it issued
// (apptls.requestCert: the operator's personal_sign, no fleet secret on this box), and installs the chain in the domain.
// It sees a CSR and a certificate, both public; nothing here could create, read or replace the key.
//
// What is checked before anything is issued, each on bytes this process observed itself:
//   1. the route: the manager's view of the partition (routeFor): running, tier T0-hv, a whole identity, and the app
//      this node launched for the deployment;
//   2. every TLS session through the manager's data plane presents exactly that key;
//   3. the domain's attestation, over such a session with a fresh nonce, judged by judge-hv as the manager's own
//      readiness rule judges it: signed by the launcher key the manager's view states, for the partition that key signs
//      for (launcherVmId), binding THIS session's key and nonce and the app, the launcher's (partition, image) statement
//      when it made one, and the runtime - whose id must be this node's pinned ENCLAVE_ISOLATION_RUNTIME_ID, as must the
//      manager's. Only "monitor-signed" issues;
//   4. the CSR is for exactly that key; the issued leaf is for that key and the deployment's name.
// A partition has no launch measurement and the relay has no prediction for it (requirePrediction: false: this box's
// backend, never the route's shape). Whether the NAME is this box's to certify is the certificate service's decision
// (relay/certs.js: this box's lease on the name's deployment, and its owner among the owners this row serves).
//
// THE CEILING, stated: T0-hv, host_excluded=no. The name reaches the domain from the launcher (the monitor's /cert.name)
// and the launcher key is the manager's word: both the HOST's statements, trusted by definition on this tier. The
// certificate means "this key answers for this name" on the platform's word, as on the Linux tier (F2). What a
// verifying client relies on is unchanged: the attestation over the same key.
import { ensureGuestCert } from "../../isolation/m4/guestd/supervisor-guestcert.mjs";
import { judge as judgeHv } from "../vbslike/verify/judge-hv.mjs";
import { runtimeId } from "../../isolation/contract/runtime.mjs";
import { appHostFor, requestCert } from "./apptls.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * A transport for routeFor that REMEMBERS the manager view it answered with, so the judge below holds the domain to the
 * launcher key and partition of the very view its route came from (never a second, possibly newer, read).
 *   client  the manager client (isolation-client.mjs: .get(id) -> its normalized view, or null)
 */
export function viewTransport(client) {
  const seen = new Map();
  return {
    seen: (id) => seen.get(id) ?? null,
    async request(method, p) {
      const id = decodeURIComponent(String(p).replace(/^\/vms\//, ""));
      const v = await client.get(id);
      if (v) seen.set(id, v); else seen.delete(id);
      return v ? { status: 200, body: v } : { status: 404, body: null };
    },
  };
}

/**
 * hvJudge(view, pinnedRuntimeId) -> ensureGuestCert's judge(doc, spki, nonce, want): judge-hv with the inputs the
 * manager's own readiness rule uses (server.mjs #judgeReadiness), taken from `view`. It refuses, before judging, a view
 * without a launcher key or the partition it signs for, and a runtime that is not the pinned one.
 */
export function hvJudge(view, pinnedRuntimeId) {
  return async (doc, spki, nonce, want) => {
    const no = (why) => ({ verdict: "reject", reasons: [why] });
    if (!view) return no("no manager view of the partition to judge it against");
    if (!view.launcherKey) return no("the manager's view states no launcher key for the domain's reports");
    if (!view.launcherVmId) return no("the manager's view names no partition for its launcher key (launcherVmId)");
    const pin = String(pinnedRuntimeId || "").toLowerCase();
    if (!HEX64.test(pin)) return no("this node pins no runtime (ENCLAVE_ISOLATION_RUNTIME_ID)");
    if (String(view.runtimeId || "").toLowerCase() !== pin) return no(`the manager serves runtime ${String(view.runtimeId).slice(0, 16)}…, not the pinned ${pin.slice(0, 16)}…`);
    // the identity the domain states must BE the pinned one (its id), and is then what judge-hv holds the report's
    // binding to (ABI/2): a domain that states another runtime, or drops to ABI/1, is refused
    let rid;
    try { rid = Buffer.from(runtimeId(doc && doc.runtime)).toString("hex"); } catch (e) { return no(`the domain states no admissible runtime identity: ${e.message}`); }
    if (rid !== pin) return no(`the domain states runtime ${rid.slice(0, 16)}…, not the pinned ${pin.slice(0, 16)}…`);
    const gi = view.guestIdentity;
    const statement = gi && gi.partition ? { expectedStatement: { partition: gi.partition, guestImageKind: gi.guestImageKind },
                                            expectedImageSha256: view.image } : {};
    return judgeHv({ doc, spki, nonce, expectedAppSha256: want.appSha, launcherKey: view.launcherKey,
                     expectedVmId: view.launcherVmId, ...statement, expectRuntime: doc.runtime });
  };
}

/**
 * The platform certificate service, as ensureGuestCert's issue(name, csrPem, spkiHash): apptls.requestCert with the
 * operator's signature. A 202 (the order is in flight or paced) and every refusal throw, with the relay's own words and
 * its retry hint; nothing is installed.
 */
export function issuer({ endpoint, sign, base, request = requestCert }) {
  return async (name, csrPem, spkiHash) => {
    const r = await request({ name, csrPem, spkiHash, endpoint, sign, ...(base ? { base } : {}) });
    if (r && r.ok && r.certPem) return r.certPem;
    const e = new Error(r && r.retryAfterSec && !r.error ? `the order for ${name} is in flight (${r.why})`
      : `the certificate service refused ${name}: ${r ? `${r.error || ""} ${r.why || ""}`.trim() : "no answer"}`);
    if (r && r.retryAfterSec) e.retryMs = Math.min(3600_000, Math.max(5_000, Number(r.retryAfterSec) * 1000));
    throw e;
  };
}

/**
 * createHvCertPass(opts) -> { pass(records), state(id), snapshot() }
 *   client      the manager client (IsolationManagerClient)        dataAddr   the manager's data plane (host:port)
 *   runtimeId   ENCLAVE_ISOLATION_RUNTIME_ID                          endpoint   this box's registered endpoint (PUBLIC_URL)
 *   sign        the operator key's personal_sign (message -> sig)    base       the certificate service's origin (default api.enclave.host)
 * pass(records) runs once over the host's records (id -> record): every PUBLIC deployment this box RUNS as a partition
 * (status running, rec.isolation.instance/appId) whose certificate is missing or due. An installed one is left until its
 * renewal point (2/3 of its life); a guest that already serves a valid one for its key is reused, not re-issued (a node
 * restart asks the CA for nothing); a failure backs off (5 min doubling to 1 h, or the service's retry hint).
 */
export function createHvCertPass({ client, dataAddr, runtimeId: pinned, endpoint, sign, base, zone = "app.enclave.host",
                                   log = () => {}, now = Date.now, _ensure = ensureGuestCert, _deps } = {}) {
  const st = new Map();       // id -> { instanceId, key, name, serial, notAfter, renewAt, issuer } | { instanceId, backoffUntil, failures, why }
  const transport = viewTransport(client);
  const issue = issuer({ endpoint, sign, base });
  async function one(id, rec) {
    const iso = rec.isolation, name = appHostFor(id, zone), t = now();
    const s = st.get(id);
    if (s && s.instanceId === iso.instance && s.backoffUntil && t < s.backoffUntil) return;
    if (s && s.instanceId === iso.instance && s.renewAt && t < s.renewAt) return;           // installed and fresh
    try {
      const got = await _ensure({ transport, dataAddr, instanceId: iso.instance, expectAppId: iso.appId, deploymentId: id, name,
        judge: (doc, spki, nonce, want) => hvJudge(transport.seen(iso.instance), pinned)(doc, spki, nonce, want),
        judgeOk: ["monitor-signed"], requirePrediction: false, issue, ...(_deps ? { _deps } : {}) });
      st.set(id, { ...got, instanceId: iso.instance });
      log(got.reused
        ? `${id.slice(0, 10)} certificate: partition ${iso.instance} already serves a valid one for ${name} on its key `
          + `${got.key.slice(0, 16)}… (serial ${got.serial}, until ${new Date(got.notAfter).toISOString()}); nothing issued`
        : `${id.slice(0, 10)} certificate: ${name} installed in partition ${iso.instance} (key ${got.key.slice(0, 16)}…, `
          + `${String(got.issuer).slice(0, 60)}, until ${new Date(got.notAfter).toISOString()}; domain ${got.verdict})`);
    } catch (e) {
      const failures = (s && s.instanceId === iso.instance && s.failures || 0) + 1;
      const wait = e.retryMs || Math.min(3600_000, 300_000 * 2 ** (failures - 1));
      st.set(id, { instanceId: iso.instance, backoffUntil: t + wait, failures, why: e.message });
      log(`${id.slice(0, 10)} certificate: none for ${name} (${e.message}); retry in ${Math.round(wait / 1000)}s`);
    }
  }
  return {
    async pass(records) {
      for (const [id, rec] of records) {
        const iso = rec && rec.isolation;
        if (!rec || rec.status !== "running" || rec.isPublic === false || !iso || !iso.instance || !iso.appId) continue;
        if (!/^0x[0-9a-f]{64}$/.test(String(id))) continue;
        await one(id, rec);
      }
      for (const id of st.keys()) if (!records.has(id)) st.delete(id);                     // a deployment gone from this box
    },
    state: (id) => st.get(id) ?? null,
    snapshot: () => Object.fromEntries(st),
  };
}
