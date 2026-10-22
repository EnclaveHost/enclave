#!/usr/bin/env python3
"""Host integration of the non-destructive wallet hold (revision 2), as exact text replacements.

Applies to windows/node/{host,agent,appzone,network-enroll}.mjs of a tree. Every replacement must match exactly once,
so the same script proves the patch applies unchanged to both bases (tree e41122d7/c2fe0fff and live c4629529/c223c043).
usage: patch-node.py <windows/node dir> [host agent appzone enroll]
"""
import sys, os

def rep(s, old, new, name):
    n = s.count(old)
    if n != 1:
        raise SystemExit(f"{name}: expected 1 match, found {n}: {old[:90]!r}")
    return s.replace(old, new)

HOST = [
# 1. constants and the env opt-in
("""const RENEW_LEAD_MS = 15 * 60_000;
""",
"""const RENEW_LEAD_MS = 15 * 60_000;
// NON-DESTRUCTIVE WALLET HOLD (network/wallet-admission.mjs). An UNKNOWN host-wallet answer keeps a running domain (its
// key and certificate) ONLY once the network agent confirms it withdrew that deployment's ingress and egress
// (walletHoldAcknowledged); otherwise the domain is retired exactly as before. The wait is bounded: WALLET_HOLD_ACK_MS
// covers the agent's 1-s admission timer, its serialized snapshot, the circuit closes and an allocation already in flight
// (which must settle before it acknowledges); it is spent only while that agent is up and reads this host's channel.
// The channel document is re-issued every WALLET_CHANNEL_HEARTBEAT_MS (it lives 30 s); that never extends a decision,
// whose deadline is the chain snapshot's own (host-admission decision().validUntil).
const WALLET_HOLD_ACK_MS = 15_000, WALLET_HOLD_POLL_MS = 250, WALLET_CHANNEL_HEARTBEAT_MS = 10_000;
/** The wallet hold channel, opted into per host (ENCLAVE_NETWORK_WALLET_HOLD=1) beside the network agent it enrolls. */
export function walletAdmissionFromEnv(env = process.env) {
  if (env.ENCLAVE_NETWORK_WALLET_HOLD !== "1") return null;
  const dir = String(env.ENCLAVE_NETWORK_AGENT_DIR || "");
  if (!path.isAbsolute(dir)) return { error: "ENCLAVE_NETWORK_WALLET_HOLD=1 needs an absolute ENCLAVE_NETWORK_AGENT_DIR" };
  // the privacy agent's state directory is <agent dir>\\state (network-enroll.mjs baseConfig, repointed on every pass)
  return { file: path.join(dir, "wallet-admission.json"), statusFile: path.join(dir, "state", "status.json") };
}
""", "constants"),
# 2. constructor: the configured channel (started by init / walletChannelStart)
("""    this.cfg.isolationDataAddr  = this.cfg.isolationDataAddr  || process.env.ENCLAVE_ISOLATION_DATA_ADDR || "";
""",
"""    this.cfg.isolationDataAddr  = this.cfg.isolationDataAddr  || process.env.ENCLAVE_ISOLATION_DATA_ADDR || "";
    // The wallet hold channel's configuration ({file, statusFile}, or null: off, and an UNKNOWN policy retires as before).
    this.walletAdmission = cfg.walletAdmission !== undefined ? cfg.walletAdmission : walletAdmissionFromEnv();
    this.walletChannel = null;
    this.walletChannelOff = !this.walletAdmission ? "off (not configured)" : this.walletAdmission.error || "not started";
""", "constructor"),
# 3. init: the channel first (a fresh EMPTY generation retires every earlier grant), then the timers
("""  async init() {
    try {
      await chain.resolveAddresses();""",
"""  async init() {
    await this.walletChannelStart({ heartbeat: true });
    try {
      await chain.resolveAddresses();""", "init"),
# 4. the tick: a definite allow is published with its chain deadline; one that cannot be is an UNKNOWN
("""      const wallet = await this.#walletPolicyState({ ...d, id });
      if (wallet.refusal) { await this.#giveUp(id, wallet.refusal, { retry: true }); continue; }
      if (wallet.unknown) {
        if (untilMs < Date.now()) { await this.#stopApp(id, `its lease lapsed while the host wallet policy was unavailable (not renewed): ${wallet.unknown}`); continue; }
        await this.#walletHold(id, wallet.unknown);
        continue;   // nothing renewed, launched or released on an unknown policy
      }""",
"""      const wallet = await this.#walletPolicyState({ ...d, id });
      if (wallet.refusal) { await this.#giveUp(id, wallet.refusal, { retry: true }); continue; }
      if (!wallet.unknown) wallet.unknown = this.#walletGrant(id, d, wallet);
      if (wallet.unknown) {
        if (untilMs < Date.now()) { await this.#stopApp(id, `its lease lapsed while the host wallet policy was unavailable (not renewed): ${wallet.unknown}`); continue; }
        await this.#walletHold(id, wallet.unknown);
        continue;   // nothing renewed, launched or released on an unknown policy
      }""", "tick"),
# 5. not ours (any more): no allow of this box's stays published for it
("""      if (!ours) {
        if (rec.claimedAt && Date.now() - rec.claimedAt < 120_000) continue;
        await this.consider(id)""",
"""      if (!ours) {
        if (rec.claimedAt && Date.now() - rec.claimedAt < 120_000) continue;
        this.#walletRevoke(id);
        await this.consider(id)""", "not-ours"),
# 6. ensureApp
("""    const wallet = await this.#walletPolicyState({ ...d, id });
    if (wallet.refusal) return await this.#giveUp(id, wallet.refusal, { retry: true });
    if (wallet.unknown) return await this.#walletHold(id, wallet.unknown);""",
"""    const wallet = await this.#walletPolicyState({ ...d, id });
    if (wallet.refusal) return await this.#giveUp(id, wallet.refusal, { retry: true });
    if (!wallet.unknown) wallet.unknown = this.#walletGrant(id, d, wallet);
    if (wallet.unknown) return await this.#walletHold(id, wallet.unknown);""", "ensureApp"),
# 7. give up: the allow goes first (a confirmed refusal is enforced on the network before the retire and the release)
("""  async #giveUpOnce(id, why, { retry = false } = {}) {
    this.#respawnAfter.delete(id);""",
"""  async #giveUpOnce(id, why, { retry = false } = {}) {
    this.#walletRevoke(id);
    this.#respawnAfter.delete(id);""", "giveUp"),
# 8. stop (lease lapse, stopped, transferred...): the same
("""  async #stopApp(id, why) {
""",
"""  async #stopApp(id, why) {
    this.#walletRevoke(id);
""", "stopApp"),
# 9. decision with its chain deadline when the channel is on; refusal() exactly as before otherwise
("""    if (!this.hostAdmission) return { refusal: null, unknown: null };
    try { return { refusal: (await this.hostAdmission.refusal({ deploymentId: d.id, appRef: d.appRef, forPrivate: d.isPublic === false })) || null, unknown: null }; }""",
"""    if (!this.hostAdmission) return { refusal: null, unknown: null };
    try {
      const q = { deploymentId: d.id, appRef: d.appRef, forPrivate: d.isPublic === false };
      // with the hold channel on, the same decision plus the chain deadline its allow may be published until
      if (this.walletChannel) { const r = await this.hostAdmission.decision(q); return { refusal: r?.refusal || null, unknown: null, validUntil: r?.validUntil }; }
      return { refusal: (await this.hostAdmission.refusal(q)) || null, unknown: null };
    }""", "policyState"),
# 10. the hold itself
("""  async #walletHold(id, unknown) {
    const why = `host wallet policy unavailable (${unknown}): not served, renewed or released until it is established; asked again each pass`;
    const gone = await this.#retireIsolated(id, why);
    const app = this.apps.get(id);
    if (app) { await app.stop(); this.apps.delete(id); }
    const rec = this.records.get(id) || {};
    if (rec.reason !== why) this.log(`${String(id).slice(0, 10)} ${why}`);
    return this.#record(id, { status: "held", walletHeld: true, port: null,
      reason: gone ? why : `${why}; the isolated domain could not be confirmed gone yet (retried)` });
  }""",
"""  async #walletHold(id, unknown) {
    const why = `host wallet policy unavailable (${unknown}): not served, renewed or released until it is established; asked again each pass`;
    const prev = this.records.get(id) || {};
    if (this.walletChannel) {
      // NOTHING HERE SERVES IT FROM NOW, before anything is asked: the app zone refuses a record that is not running, the
      // streams it already splices are cut, an in-process app stops. Then the network agent must confirm the hold.
      this.#record(id, { status: "held", walletHeld: true, port: null });
      try { this.servingWithdrawn?.(id); } catch (e) { this.log(`${String(id).slice(0, 10)} app-zone withdrawal: ${e.message}`); }
      const app = this.apps.get(id);
      if (app) { await app.stop(); this.apps.delete(id); }
      const held = await this.#walletHoldConfirmed(id);
      if (held.ok) {
        const inst = prev.isolation?.instance || prev.isolationHeld || null;
        const reason = `${why}; ${inst ? `its domain ${inst}` : "its domain"} is KEPT: the network agent confirmed its ingress and egress withdrawn`;
        if (prev.reason !== reason) this.log(`${String(id).slice(0, 10)} ${reason} (hold revision ${held.revision})`);
        return this.#record(id, { status: "held", walletHeld: true, walletKept: true, port: null, reason });
      }
      unknown = `${unknown}; not kept: ${held.why}`;
    }
    const whyRetired = this.walletChannel ? `host wallet policy unavailable (${unknown}): not served, renewed or released until it is established; asked again each pass` : why;
    const gone = await this.#retireIsolated(id, whyRetired);
    const app = this.apps.get(id);
    if (app) { await app.stop(); this.apps.delete(id); }
    const rec = this.records.get(id) || {};
    if (rec.reason !== whyRetired) this.log(`${String(id).slice(0, 10)} ${whyRetired}`);
    return this.#record(id, { status: "held", walletHeld: true, walletKept: null, port: null,
      reason: gone ? whyRetired : `${whyRetired}; the isolated domain could not be confirmed gone yet (retried)` });
  }
  /** The wallet hold channel (network/wallet-admission.mjs): written EMPTY under a fresh generation, so no grant of an
   *  earlier process survives this one's start; re-issued by the heartbeat; off (the old retire) on any failure. */
  async walletChannelStart({ heartbeat = false } = {}) {
    const wa = this.walletAdmission;
    if (!wa || wa.error || this.walletChannel) return this.walletChannel;
    try {
      if (!this.hostAdmission) throw new Error("this host has no wallet admission");
      if (typeof this.hostAdmission.decision !== "function") throw new Error("the host admission has no decision() with its chain deadline (an older host-admission bundle)");
      if (!this.cfg.isolationManager) throw new Error("no isolation manager: no domain here is preserved by a network hold");
      if (!path.isAbsolute(String(wa.file || "")) || !path.isAbsolute(String(wa.statusFile || ""))) throw new Error("absolute channel and status files required");
      const mod = await import("../../network/wallet-admission.mjs");
      this.#walletAck = mod.walletHoldAcknowledged;
      this.walletChannel = new mod.WalletAllowWriter({ file: wa.file, runner: this.enclaveId.toLowerCase() });
      this.walletChannelOff = null;
      this.log(`wallet hold channel: ${wa.file}, generation ${this.walletChannel.generation.slice(0, 8)}, written EMPTY (nothing is admitted on the network until a fresh allow)`);
      if (heartbeat) this.#walletBeat = setInterval(() => this.walletHeartbeat(), WALLET_CHANNEL_HEARTBEAT_MS).unref?.();
    } catch (e) {
      this.walletChannel = null; this.walletChannelOff = e.message;
      this.log(`wallet hold channel OFF (an UNKNOWN wallet policy retires the domain, as before): ${e.message}`);
    }
    return this.walletChannel;
  }
  #walletAck = null; #walletBeat = null; #walletBeatError = null;
  /** Re-issue the channel document (its 30-s life). Decisions keep their own deadlines; a failure lets it lapse (closed). */
  walletHeartbeat() {
    if (!this.walletChannel) return;
    try { this.walletChannel.heartbeat(); if (this.#walletBeatError) this.log("wallet hold channel: written again"); this.#walletBeatError = null; }
    catch (e) { if (this.#walletBeatError !== e.message) this.log(`wallet hold channel NOT written (the network admits nothing once it lapses): ${e.message}`); this.#walletBeatError = e.message; }
  }
  /** A DEFINITE allow, published to the network with its own chain deadline -> null, or why it could not be (an UNKNOWN). */
  #walletGrant(id, d, w) {
    if (!this.walletChannel) return null;
    try {
      this.walletChannel.allow(String(id).toLowerCase(), { appRef: d.appRef, configCid: String(d.configCid ?? ""), validUntil: w.validUntil });
      return null;
    } catch (e) { return `the allow could not be published to the network agent (${e.message})`; }
  }
  /** Withdraw this box's published allow (a refusal, a stop, a lease no longer ours). Unconfirmed: the caller retires. */
  #walletRevoke(id) {
    if (!this.walletChannel) return;
    try { this.walletChannel.hold(String(id).toLowerCase()); }
    catch (e) { this.log(`${String(id).slice(0, 10)} wallet hold channel: the allow could not be withdrawn (${e.message}); it lapses with its deadline`); }
  }
  /** Write the hold, then wait (bounded) for the network agent's acknowledgement of exactly it. -> {ok, revision} | {ok:false, why} */
  async #walletHoldConfirmed(id) {
    // Windows refuses the rename while the network agent has the file open (its 1-s read): a sharing refusal is retried
    // briefly (a hold rewritten is the same hold); anything else, or a refusal that persists, is the old retire
    let hold;
    for (let attempt = 0; ; attempt++) {
      try { hold = this.walletChannel.hold(String(id).toLowerCase()); break; }
      catch (e) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(e.code) || attempt >= 9) return { ok: false, why: `the hold could not be written (${e.message})` };
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
      }
    }
    // (cfg.walletHoldAckMs: a shorter bound for tests only; production uses WALLET_HOLD_ACK_MS)
    const ackMs = Number(this.cfg.walletHoldAckMs) > 0 ? Number(this.cfg.walletHoldAckMs) : WALLET_HOLD_ACK_MS;
    const runner = this.enclaveId.toLowerCase(), end = Date.now() + ackMs;
    for (;;) {
      let status = null;
      try { status = JSON.parse(fs.readFileSync(this.walletAdmission.statusFile, "utf8")); } catch {}
      const now = Date.now();
      if (this.#walletAck({ status, runner, id: String(id).toLowerCase(), hold, now })) return { ok: true, revision: hold.revision };
      // waiting helps only while an agent reports enforcing THIS host's channel; with none, the old retire, now. A late
      // status (an agent slowed by load) is waited for, within the same bound.
      const w = status?.walletAdmission;
      if (!status) return { ok: false, why: "the network agent's status cannot be read" };
      if (!w) return { ok: false, why: "the network agent does not enforce wallet holds (no walletAdmission in its status)" };
      if (w.runner !== runner) return { ok: false, why: "the network agent reads another runner's channel" };
      if (now >= end) return { ok: false, why: `the network agent did not confirm the withdrawal within ${ackMs / 1000} s`
        + (Number.isSafeInteger(status.updatedAt) && now - status.updatedAt >= 5000 ? " (its status is stale)" : "") };
      await new Promise((r) => setTimeout(r, WALLET_HOLD_POLL_MS));
    }
  }""", "walletHold"),
# 11. app zone: a held record is never spliced; the agent re-checks after its own resolve
("""    const rec = this.records.get(id);
    // WHOSE app: in owner-only scope""",
"""    const rec = this.records.get(id);
    // HELD ON AN UNKNOWN WALLET POLICY: nothing is spliced or served here (the domain may be kept, its traffic is not)
    if (rec?.walletHeld) return null;
    // WHOSE app: in owner-only scope""", "appZoneTarget"),
("""  async appZoneTarget(ref) {""",
"""  /** Asked by the app zone at the moment it would splice or serve (after its own resolve): still served here? */
  appZoneAdmitted(id) {
    const rec = this.records.get(String(id).toLowerCase());
    return !!rec && !rec.walletHeld && rec.status === "running";
  }
  async appZoneTarget(ref) {""", "appZoneAdmitted"),
]

AGENT = [
("""            config: { agentDir: NET.agentDir, binDir: NET.binDir, nodeBinary: process.execPath,""",
"""            config: { agentDir: NET.agentDir, binDir: NET.binDir, nodeBinary: process.execPath,
                      // the wallet hold channel the node writes (host.mjs walletChannelStart): the network agent enforces it
                      // only while this node actually runs one; otherwise the block is dropped (and the agent restarted once)
                      walletAdmission: host.walletChannel ? { file: host.walletAdmission.file } : null,""", "enroll-config"),
("""      resolve: (id) => host.appZoneTarget(id),
""",
"""      resolve: (id) => host.appZoneTarget(id),
      // re-asked after the resolve, at the moment of splicing: a wallet hold between the two is not served
      admitted: (id) => host.appZoneAdmitted(id),
""", "zone-admitted"),
("""      log: (m) => log(`[app-zone] ${m}`),
    });
""",
"""      log: (m) => log(`[app-zone] ${m}`),
    });
    // a wallet hold cuts what the app zone already splices or serves for that deployment (host.mjs #walletHold)
    host.servingWithdrawn = (id) => zone.closeDeployment(id);
""", "zone-withdrawn"),
]

APPZONE = [
("""export function appZone({ resolve, serveHttp, maxBodyBytes = 0, log = () => {}, isolationSplicer = null }) {""",
"""export function appZone({ resolve, serveHttp, maxBodyBytes = 0, log = () => {}, isolationSplicer = null, admitted = null }) {""", "signature"),
("""    const ref = m[1].toLowerCase();
    let target = null;
    try { target = await resolve(ref); } catch (e) { log(`app-zone ${ref}: ${e.message}`); }
    const id = target?.id || ref;
""",
"""    const ref = m[1].toLowerCase();
    let target = null;
    try { target = await resolve(ref); } catch (e) { log(`app-zone ${ref}: ${e.message}`); }
    const id = target?.id || ref;
    // NAMED from here, so a later closeDeployment(id) finds this stream; and re-asked now, synchronously with the naming,
    // so a withdrawal that landed while resolve awaited is not served (host.appZoneAdmitted)
    st.id = id;
    if (target && admitted && !admitted(id)) {
      log(`app-zone ${id.slice(0, 10)}: no longer served here`);
      st.sock.write(`HTTP/1.1 503 Service Unavailable\\r\\nConnection: close\\r\\n\\r\\n`);
      return drop(st.sid);
    }
""", "onHead"),
("""  return { handleUpgrade, open: () => streams.size, closeAll: () => { for (const sid of [...streams.keys()]) drop(sid); } };""",
"""  // closeDeployment(id): every stream this zone splices or serves for one deployment ends now (a wallet hold) -> count
  const closeDeployment = (id) => { let n = 0; for (const [sid, st] of [...streams]) if (st.id === id) { drop(sid); n++; } return n; };
  return { handleUpgrade, open: () => streams.size, closeAll: () => { for (const sid of [...streams.keys()]) drop(sid); }, closeDeployment };""", "closeDeployment"),
]

ENROLL = [
("""      ...(hostServices ? { hostServices, serviceWorkerModule: path.join(binDir, "host-service-ingress.mjs") } : {}) };""",
"""      ...(hostServices ? { hostServices, serviceWorkerModule: path.join(binDir, "host-service-ingress.mjs") } : {}),
      // the node's wallet hold channel (host.mjs walletChannelStart), only while the node runs one: the agent then admits an
      // app only on a fresh allow there; dropped (one restart) when the node stops writing it, so nothing waits on a dead file
      ...(walletAdmission ? { walletAdmission } : {}) };""", "want"),
("""    const directories = cfg?.enclaveNetwork?.directories || config.enclaveNetwork.directories;""",
"""    const directories = cfg?.enclaveNetwork?.directories || config.enclaveNetwork.directories;
    const walletAdmission = config.walletAdmission?.file && path.isAbsolute(config.walletAdmission.file) ? { file: config.walletAdmission.file } : null;""", "wallet-cfg"),
]

def appzone_opts(s):
    # the factory's options gain admitted (default: always admitted, the old behaviour)
    import re
    m = re.search(r"export function appZone\(\{([^}]*)\}\)", s)
    if not m: raise SystemExit("appzone: factory signature not found")
    if "admitted" in m.group(1): return s
    return s.replace(m.group(0), "export function appZone({" + m.group(1).rstrip() + ", admitted = null })", 1)

def main():
    d = sys.argv[1]; which = sys.argv[2:] or ["host", "agent", "appzone", "enroll"]
    plan = {"host": ("host.mjs", HOST), "agent": ("agent.mjs", AGENT), "appzone": ("appzone.mjs", APPZONE), "enroll": ("network-enroll.mjs", ENROLL)}
    for w in which:
        f, reps = plan[w]; p = os.path.join(d, f); s = open(p).read()
        for old, new, name in reps: s = rep(s, old, new, f"{f}:{name}")
        open(p, "w").write(s); print("patched", p)

main()
