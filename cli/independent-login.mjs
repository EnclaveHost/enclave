// cli/independent-login.mjs -- signing in from the CLI with no Enclave authority: a device flow on the chain itself.
//
// The command makes a fresh P-256 session key and a bounded SessionGrant naming it, saves both locally (crash-safe), and
// prints an approval link to a frontend origin the OWNER chose and reviewed (`<origin>/grant#<request>`, the request in
// the URL fragment so it never reaches a server; the request carries the PUBLIC key and the grant, never a secret) and a
// check code. The owner opens it with their own account (a wallet, or a passkey Safe through any ERC-1271-capable
// frontend), checks the code, signs, and the grant is opened on the PINNED session factory by whoever pays its gas (the
// owner's frontend, or this CLI with a separate gas key after a "sign only" hand-back). The command then watches the chain
// - fresh, quorum-agreed reads; no relay, no mailbox, no bearer service - and adopts ONLY the session that
//   * has the id this key and grant determine (sid = keccak(vault, keyHash, grantNonce)),
//   * lives in a vault of the pinned factory (the vault and the factory both say so at one agreed block),
//   * stores exactly this grant's policy (actions, environments, apps, caps, period, measurement; expiry never earlier;
//     budget never less), and is live,
//   * belongs to the owner this login is bound to (--owner), or, when the owner was left open, to one the person at the
//     terminal confirmed (acceptOwner) or already pinned in an earlier login. Anyone holding the link can open our key in
//     THEIR vault; such a session is never adopted silently.
// Logout drops the local "active" pointer only; it never claims the session ended on chain. Ending it is a separate,
// separately authorized act (the session key's own terminate, or the owner's revoke), which logout names.
//
// Every dependency is injected (the sessions SDK, the quorum chain, its PublicClient view, the key store), so the CLI
// glue and the tests share this code. Node-only (files); no network access of its own beyond the injected chain.
import fs from "node:fs";
import path from "node:path";
import { getAbiItem, getAddress } from "viem";
import { canonicalHost } from "../network/rpc-identity.mjs";

export const LOGIN_FORMAT = "enclave-independent-login/v1";
export const IDENTITY_FORMAT = "enclave-independent-identity/v1";
const ADDR = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/;
const lower = (a) => String(a).toLowerCase();

export class LoginError extends Error {
  constructor(code, message) { super(message); this.name = "LoginError"; this.code = code; }
}

/** An owner-chosen frontend: an exact origin (https; plain http only on loopback, for a local frontend). No path, query,
 *  fragment or credentials: the link appends `/grant#…` and `/sessions#…` itself. -> the origin. */
export function frontendOrigin(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new LoginError("frontend", "--frontend is not a URL"); }
  const h = canonicalHost(u.hostname);
  if (!h) throw new LoginError("frontend", "--frontend has a malformed host");
  if (!(u.protocol === "https:" || (u.protocol === "http:" && h.loopback))) throw new LoginError("frontend", "--frontend must be https (plain http only on loopback)");
  if (u.username || u.password || u.search || u.hash || String(raw).includes("#") || (u.pathname !== "/" && u.pathname !== ""))
    throw new LoginError("frontend", "--frontend must be an origin only (no path, query, fragment or credentials)");
  return `${u.protocol}//${h.host}${u.port ? `:${u.port}` : ""}`;
}

/** The policy the vault stores for `grant` (SessionVault._open), from the SDK's own name tables. */
export function expectedPolicy(S, grant) {
  let actions = 0n;
  for (const a of grant.actions) {
    if (!(a in S.ACTIONS)) throw new LoginError("grant", `unknown action ${a}`);
    actions |= 1n << BigInt(S.ACTIONS[a]);
  }
  let envs = 0;
  for (const e of grant.environments) {
    if (!(e in S.ENVIRONMENTS)) throw new LoginError("grant", `unknown environment ${e}`);
    envs |= S.ENVIRONMENTS[e];
  }
  const named = grant.apps.filter((a) => a !== "*");
  return { keyHash: lower(grant.sessionKey), measurement: lower(grant.measurement), actions, envs, anyApp: grant.apps.includes("*"),
    apps: named.length, hexApps: named.filter((a) => HASH.test(a)).map(lower), perPeriod6: BigInt(grant.spendPerPeriod),
    maxFee6: BigInt(grant.maxFeePerOp), maxAppFeeHour6: BigInt(grant.maxAppFeePerHour), maxRateHour6: BigInt(grant.maxRatePerHour),
    period: Number(grant.periodSeconds), opsPerPeriod: Number(grant.opsPerPeriod), expiresAt: BigInt(grant.expiresAt), budget: BigInt(grant.budget) };
}

/** Why the session the chain holds is not exactly this grant's, or null. `snap` is a sessionSnapshot. */
export function policyMismatch(S, grant, snap) {
  if (!snap.exists) return "no session with this id";
  const want = expectedPolicy(S, grant), s = snap.session;
  const checks = [
    ["key", lower(s.keyHash) === want.keyHash],
    ["measurement", lower(s.measurement) === want.measurement],
    ["actions", BigInt(s.actions) === want.actions],
    ["environments", Number(s.envs) === want.envs],
    ["app scope", !!s.anyApp === want.anyApp && snap.apps.length === want.apps && want.hexApps.every((h) => snap.apps.map(lower).includes(h))],
    ["spend per period", BigInt(s.perPeriod6) === want.perPeriod6],
    ["fee cap", BigInt(s.maxFee6) === want.maxFee6],
    ["app fee cap", BigInt(s.maxAppFeeHour6) === want.maxAppFeeHour6],
    ["rate cap", BigInt(s.maxRateHour6) === want.maxRateHour6],
    ["period", Number(s.period) === want.period],
    ["ops per period", Number(s.opsPerPeriod) === want.opsPerPeriod],
    // the owner may extend or top up an open session; it can never be shorter or smaller than what was granted
    ["expiry", BigInt(s.expiresAt) >= want.expiresAt],
    ["budget", BigInt(s.balance6) + BigInt(s.spent6) >= want.budget],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  return bad.length ? `the session's ${bad.join(", ")} differ from this login's grant` : null;
}

// atomic, private JSON files: a crash leaves either the old file or the new one
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, (_k, v) => typeof v === "bigint" ? `${v}n` : v, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  if ((fs.statSync(file).mode & 0o077) !== 0) throw new LoginError("state", `${file} is readable by others; chmod 600 it`);
  return JSON.parse(fs.readFileSync(file, "utf8"), (_k, v) => typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
}
const revertOf = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (/Revert/.test(x.name || "") || /reverted/i.test(x.shortMessage || "")) return String(x.reason || x.shortMessage || "reverted").slice(0, 200); return null; };

/**
 * deps:
 *   S        the sessions SDK (sdk/sessions/dist/node.mjs)
 *   chain    a QuorumChain (cli/independent.mjs): snapshot(fn) -> {value, blockNumber, timestamp(ms)}
 *   pc       its PublicClient view (quorumPublicClient(chain)): vaultAddress and prepareSessionOpen read through it
 *   sessionSnapshot  (chain, {factory, vault, sid}) -> the agreed session (cli/independent.mjs sessionSnapshot)
 *   store    the session key store (S.FileStore): save, load, remove, list, activeId, setActive
 *   stateDir where login state and the identity pin live (e.g. <session dir>/login)
 *   factory, chainId, profileDigest   the pinned trust this login is bound to
 *   frontend the owner-chosen frontend origin (frontendOrigin)
 *   scan     { chunk = 2000, chunksPerPoll = 25 }  bounded event scans for an unbound owner
 *   now, sleep
 */
export function createIndependentLogin(deps) {
  const { S, chain, pc, sessionSnapshot, store, stateDir, chainId, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = deps;
  if (!S || !chain || !pc || !sessionSnapshot || !store || !stateDir) throw new LoginError("config", "login needs the sessions SDK, a quorum chain, its client view, a session snapshot reader, a key store and a state directory");
  if (!ADDR.test(deps.factory || "") || /^0x0{40}$/i.test(deps.factory)) throw new LoginError("config", "login needs the pinned session factory");
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new LoginError("config", "login needs the chain id");
  const factory = getAddress(deps.factory), profileDigest = deps.profileDigest || null;
  const frontend = deps.frontend ? frontendOrigin(deps.frontend) : null;
  const chunk = BigInt(deps.scan?.chunk ?? 2000), chunksPerPoll = deps.scan?.chunksPerPoll ?? 25;
  const fileOf = (id) => {
    if (!/^pending-[0-9a-f]{8,64}$/.test(id)) throw new LoginError("state", `bad login id ${id}`);      // the SDK's pendingId
    return path.join(stateDir, `${id}.json`);
  };
  const identityFile = path.join(stateDir, "identity.json");
  const openedEvent = getAbiItem({ abi: S.sessionVaultAbi, name: "SessionOpened" });
  // the session this login's vault holds, if any. Before its first session an owner's vault is only an address (the
  // pinned factory's CREATE2 prediction): no code there means no session, while code that is not the factory's vault
  // stays a refusal
  async function sessionAt(vault, sid) {
    try { return await sessionSnapshot(chain, { factory, vault, sid }); }
    catch (e) {
      const code = await chain.snapshot((c, blockNumber) => c.getCode({ address: getAddress(vault), blockNumber })).then((x) => x.value);
      if (!code || code === "0x") return { exists: false, live: false };
      throw e;
    }
  }

  /** The account this CLI acts for, pinned by the first adopted login on this factory and chain: {owner, factory, chainId}. */
  function identity() {
    const p = readJson(identityFile);
    return p && p.format === IDENTITY_FORMAT && p.chainId === chainId && lower(p.factory) === lower(factory) ? p : null;
  }
  function pinIdentity(owner) { writeJson(identityFile, { format: IDENTITY_FORMAT, owner: lower(owner), factory: lower(factory), chainId, pinnedAt: now() }); }
  function bound(st) {
    if (st.format !== LOGIN_FORMAT) throw new LoginError("state", `${st.id} is not a login record`);
    if (st.chainId !== chainId || lower(st.factory) !== lower(factory) || (st.profileDigest || null) !== profileDigest)
      throw new LoginError("binding", `login ${st.id} was made for chain ${st.chainId}, factory ${st.factory}${st.profileDigest ? `, profile ${st.profileDigest}` : ""}; `
        + "this command runs with different trust, so it neither adopts nor discards it");
    return st;
  }
  const load = (id) => { const st = readJson(fileOf(id)); if (!st) throw new LoginError("state", `no login ${id}`); return bound(st); };
  const save = (st) => writeJson(fileOf(st.id), st);
  const agreedHead = async () => { const s = await chain.snapshot(async () => 0); return { block: BigInt(s.blockNumber), timeMs: s.timestamp }; };

  /**
   * Start a sign-in. -> { id, link, checkCode, owner, vault, sid, signBefore, expiresAt, startBlock }. The key and the
   * state are on disk before the link is returned, so an interrupted command resumes (pending(), poll, wait).
   */
  async function begin({ preset = "auth-only", apps, days, label = "enclave CLI sign-in", owner = null, budgetUsd = 0, signWithinSec = 1800, switchOwner = false } = {}) {
    if (!frontend) throw new LoginError("frontend", "name the frontend you approve sessions on: --frontend https://… (an origin you reviewed; nothing is assumed)");
    if (!S.PRESETS[preset]) throw new LoginError("grant", `unknown preset ${preset}: ${Object.keys(S.PRESETS).join(" | ")}`);
    if (!(Number.isSafeInteger(signWithinSec) && signWithinSec >= 60 && signWithinSec <= 86400)) throw new LoginError("grant", "the approval window must be 1 minute to 1 day");
    if (owner !== null && !ADDR.test(String(owner))) throw new LoginError("owner", "--owner takes an account address");
    const pin = identity();
    if (owner && pin && lower(owner) !== pin.owner && !switchOwner)
      throw new LoginError("identity-switch", `this CLI acts for ${pin.owner}; signing in as ${lower(owner)} needs an explicit switch (--switch-account)`);
    const policy = {};
    if (apps !== undefined) policy.apps = apps;
    if (days !== undefined) { if (!(days > 0)) throw new LoginError("grant", "--days must be above 0"); policy.expiresIn = Math.round(days * 86400); }
    const budget = BigInt(Math.round(Number(budgetUsd || 0) * 1e6));
    if (budget < 0n) throw new LoginError("grant", "a budget cannot be negative");
    if (budget > 0n) policy.budget = budget;
    S.buildGrant({ preset, label, sessionKey: S.ZERO_HASH, policy, signWithin: signWithinSec });     // a bad option leaves no key behind
    const head = await agreedHead();
    const vault = owner ? getAddress(await S.vaultAddress(pc, factory, getAddress(owner))) : null;
    const { signer, record } = await S.newSessionKey(store, { relay: "", chainId, label, extractable: true });
    const grant = S.buildGrant({ preset, label, sessionKey: signer.keyHash, policy, signWithin: signWithinSec });
    await store.save({ ...record, grant, ...(owner ? { wantOwner: getAddress(owner) } : {}) });
    const request = { v: 1, chainId, relay: "", x: record.x, y: record.y, grant, ...(owner ? { owner: getAddress(owner) } : {}) };
    const link = S.grantLink(frontend, request);
    if (record.pkcs8 && link.includes(record.pkcs8)) throw new LoginError("secret", "refusing: the private key would be in the link");
    const sid = vault ? S.sessionIdOf(vault, grant.sessionKey, grant.grantNonce) : null;
    const st = { format: LOGIN_FORMAT, id: record.id, keyHash: lower(signer.keyHash), chainId, factory: lower(factory), profileDigest,
      frontend, owner: owner ? lower(owner) : null, vault: vault ? lower(vault) : null, sid, grant, startBlock: head.block,
      scannedTo: head.block - 1n, candidates: {}, createdAt: now(), state: "waiting", adopted: null, switchOwner: !!(owner && switchOwner) };
    save(st);
    return { id: st.id, link, checkCode: S.checkCode(signer.keyHash), owner: st.owner, vault: st.vault, sid, factory: lower(factory),
      signBefore: Number(grant.signBefore), expiresAt: Number(grant.expiresAt), startBlock: head.block };
  }

  // Vaults where a session with THIS key and THIS grant nonce was opened, from SessionOpened events in a bounded window.
  // Every vault found is kept in the saved state with the scan position, so a later poll (or a resumed process) checks it
  // again: the window only moves forward.
  async function discover(st) {
    const found = new Map(Object.entries(st.candidates || {}));
    for (let i = 0; i < chunksPerPoll; i++) {
      const from = st.scannedTo + 1n;
      const s = await chain.snapshot(async (c, block) => {
        if (from > block) return { to: block, logs: [] };
        const to = from + chunk - 1n < block ? from + chunk - 1n : block;
        // SessionOpened(sid indexed, keyHash indexed, ...) from any address, filtered on OUR key hash
        const logs = await c.getLogs({ event: openedEvent, args: { keyHash: st.keyHash }, fromBlock: from, toBlock: to, strict: true });
        return { to, logs: logs.map((l) => ({ address: lower(l.address), sid: lower(l.args.sid), keyHash: lower(l.args.keyHash), blockNumber: BigInt(l.blockNumber) })) };
      });
      const { to, logs } = s.value;
      for (const l of logs) {
        if (l.keyHash !== st.keyHash) continue;
        // a session of THIS grant: the vault itself computed sid from our key and our nonce
        if (lower(S.sessionIdOf(getAddress(l.address), st.grant.sessionKey, st.grant.grantNonce)) !== l.sid) continue;
        found.set(l.address, l.sid);
      }
      if (to > st.scannedTo || found.size !== Object.keys(st.candidates || {}).length) { st.scannedTo = to > st.scannedTo ? to : st.scannedTo; st.candidates = Object.fromEntries(found); save(st); }
      if (to >= BigInt(s.blockNumber)) break;
    }
    return found;
  }

  async function adopt(st, { vault, sid, owner }) {
    const rec = await store.load(st.id);
    if (!rec) throw new LoginError("state", `the session key for ${st.id} is gone from this machine; nothing can be adopted (sign in again)`);
    if (lower(rec.keyHash) !== st.keyHash) throw new LoginError("state", `the stored key for ${st.id} is not this login's key`);
    const open = await S.completeSession(store, rec, { vault: getAddress(vault), owner: getAddress(owner), grant: st.grant });
    store.setActive?.(open.id);
    const pin = identity();
    if (!pin || pin.owner !== lower(owner)) pinIdentity(owner);
    st.state = "open"; st.adopted = { sid: lower(sid), vault: lower(vault), owner: lower(owner) }; save(st);
    return { state: "open", id: st.id, sid: lower(sid), vault: lower(vault), owner: lower(owner) };
  }

  /**
   * One check of the chain for this login. -> { state: "waiting" | "open" | "confirm-owner" | "expired" | "refused", ... }.
   * `acceptOwner`: the owner the person at the terminal confirmed for an unbound login.
   */
  async function poll(id, { acceptOwner = null } = {}) {
    const st = load(id);
    if (st.adopted) return { state: "open", id, ...st.adopted };
    if (st.state === "expired") return { state: "expired", id };
    const head = await agreedHead();
    const candidates = st.vault ? new Map([[st.vault, st.sid]]) : await discover(st);
    const seen = [];
    for (const [vault, sid] of candidates) {
      const snap = st.vault ? await sessionAt(vault, sid) : await sessionSnapshot(chain, { factory, vault, sid });
      if (!snap.exists) continue;
      const why = policyMismatch(S, st.grant, snap);
      if (why) { seen.push({ vault, owner: snap.owner, refused: why }); continue; }
      if (!snap.live) { seen.push({ vault, owner: snap.owner, refused: "the session is not live (ended, expired or revoked)" }); continue; }
      seen.push({ vault, sid, owner: snap.owner });
    }
    const ok = seen.filter((c) => !c.refused);
    if (st.owner) {
      const mine = ok.find((c) => c.owner === st.owner);
      if (mine) return adopt(st, mine);
      const bad = seen.find((c) => c.refused);
      if (bad) return { state: "refused", id, reason: bad.refused, vault: bad.vault };
    } else if (ok.length) {
      // anyone holding the link could have opened this key in their own vault: only the account a person confirmed now,
      // or the one this CLI already acts for, is adopted; any other opener is reported, never followed
      const pin = identity();
      const pick = acceptOwner ? ok.find((c) => c.owner === lower(acceptOwner)) : pin ? ok.find((c) => c.owner === pin.owner) : null;
      if (pick) {
        const r = await adopt(st, pick), others = [...new Set(ok.filter((c) => c.owner !== pick.owner).map((c) => c.owner))];
        return others.length ? { ...r, alsoOpenedBy: others } : r;
      }
      return { state: "confirm-owner", id, candidates: ok.map(({ vault, sid, owner }) => ({ vault, sid, owner })), pinned: pin?.owner || null };
    }
    // the owner can no longer open this grant once the agreed chain time passes signBefore (the vault refuses it)
    if (head.timeMs / 1000 > Number(st.grant.signBefore) && (st.vault || st.scannedTo >= head.block)) {
      st.state = "expired"; save(st);
      await store.remove(st.id).catch(() => {});
      return { state: "expired", id };
    }
    return { state: "waiting", id, scannedTo: st.scannedTo, refusedCandidates: seen.filter((c) => c.refused) };
  }

  /** poll until open / expired / refused / confirm-owner, or `timeoutMs` (then state "waiting": resume later). */
  async function wait(id, { timeoutMs = 30 * 60_000, pollMs = 4000, acceptOwner = null, onTick = () => {} } = {}) {
    const end = now() + timeoutMs;
    for (;;) {
      const r = await poll(id, { acceptOwner });
      if (r.state !== "waiting") return r;
      onTick(r);
      if (now() + pollMs > end) return { ...r, resumable: true };
      await sleep(pollMs);
    }
  }

  /** Logins that can still be resumed (not adopted, not expired), oldest first. */
  function pending() {
    if (!fs.existsSync(stateDir)) return [];
    return fs.readdirSync(stateDir).filter((n) => n.endsWith(".json") && n !== "identity.json").map((n) => readJson(path.join(stateDir, n)))
      .filter((st) => st && st.format === LOGIN_FORMAT && !st.adopted && st.state !== "expired")
      .map((st) => { try { return bound(st); } catch (e) { return { ...st, unusable: e.message }; } })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * The owner signed this login's grant elsewhere and handed the signature back (a 65-byte ECDSA signature, or a contract
   * account's ERC-1271 bytes, e.g. a Safe's). -> { to, data, vault, sid } for a gas payer to submit, ONLY once the exact
   * openFor it builds succeeds in a simulation at an agreed block (the vault's own signature check decides).
   */
  async function signedOpen(id, signature, { owner = null } = {}) {
    const st = load(id);
    if (st.adopted) throw new LoginError("state", `login ${id} is already open (${st.adopted.sid})`);
    const who = st.owner || (owner && ADDR.test(owner) ? lower(owner) : null);
    if (!who) throw new LoginError("owner", "name the account that signed (--owner): this login was not bound to one");
    if (!/^0x([0-9a-fA-F]{2})+$/.test(String(signature)) || signature.length > 2 + 2 * 4096) throw new LoginError("signature", "the owner signature must be hex bytes");
    if (BigInt(st.grant.budget) > 0n) throw new LoginError("signature", "a session with a budget also needs the owner's USDC authorization: open it from the frontend instead");
    const prep = await S.prepareSessionOpen({ publicClient: pc, factory, chainId, grant: st.grant,
      owner: { address: getAddress(who), signTypedData: async () => signature } });
    const sim = await chain.snapshot(async (c, blockNumber) => {
      try { await c.call({ to: prep.to, data: prep.data, blockNumber }); return { ok: true }; }
      catch (e) { const r = revertOf(e); if (r !== null) return { revert: r }; throw e; }
    });
    if (sim.value.revert !== undefined)
      throw new LoginError("signature", `the pinned factory refuses this signature for ${who}'s vault (agreed at block ${sim.blockNumber}): ${sim.value.revert}. Nothing was sent`);
    if (!st.owner) { st.owner = who; st.vault = lower(prep.vault); st.sid = lower(prep.sid); save(st); }
    return { to: prep.to, data: prep.data, vault: lower(prep.vault), sid: lower(prep.sid), owner: who };
  }

  /** The active pointer goes; the session does NOT end. -> { cleared, sid, live, endWith }. With forgetKey, the local key
   *  is deleted too, but only once the chain shows the session is not live (or `force`): without its key nobody can make
   *  the session end itself, and only the owner's revoke remains. */
  async function logout({ sid = null, forgetKey = false, force = false } = {}) {
    const active = store.activeId?.() || null, target = sid || active;
    if (!target) return { cleared: false, sid: null, live: null, endWith: null };
    const rec = await store.load(target);
    if (!rec?.handle) throw new LoginError("state", `no open session ${target} on this machine`);
    let live = null;
    try { live = (await sessionSnapshot(chain, { factory, vault: rec.handle.vault, sid: rec.handle.sid })).live; } catch { live = null; }
    // a refusal changes nothing: decide before touching the pointer or the key
    if (forgetKey && live !== false && !force)
      throw new LoginError("live", `session ${target} is ${live ? "still live" : "of unknown state"} on chain; deleting its key leaves only the owner's revoke to end it (pass --force to do so anyway)`);
    if (active === target) store.setActive?.(null);
    if (forgetKey) await store.remove(target);
    return { cleared: active === target, sid: target, live, keyKept: !forgetKey,
      endWith: live === false ? null : `the session stays usable until ${new Date(Number(rec.grant?.expiresAt ?? 0) * 1000).toISOString()} unless ended: `
        + `enclave --independent session terminate ${target} (signed by its own key; any gas payer submits), or the owner's revoke` };
  }

  /** A link the OWNER opens to add budget to a live session of theirs (the frontend's `/sessions#topup=` flow: the owner
   *  signs the USDC authorization; this CLI only proposes an amount). */
  async function topUpLink({ sid = null, amountUsd }) {
    if (!frontend) throw new LoginError("frontend", "name the frontend the owner uses: --frontend https://…");
    const id = sid || store.activeId?.();
    if (!id) throw new LoginError("state", "no active session: name one");
    const rec = await store.load(id);
    if (!rec?.handle) throw new LoginError("state", `no open session ${id} on this machine`);
    const amount6 = BigInt(Math.round(Number(amountUsd) * 1e6));
    if (!(amount6 > 0n)) throw new LoginError("amount", "--amount must be above 0");
    const snap = await sessionSnapshot(chain, { factory, vault: rec.handle.vault, sid: rec.handle.sid });
    if (!snap.live) throw new LoginError("live", `session ${id} is not live; a top-up cannot revive it`);
    if (snap.owner !== lower(rec.handle.owner)) throw new LoginError("owner", `the vault's owner ${snap.owner} is not the session's recorded owner ${lower(rec.handle.owner)}`);
    return { link: `${frontend}/sessions#topup=${getAddress(rec.handle.vault)}:${lower(rec.handle.sid)}:${amount6}`, owner: snap.owner, sid: lower(rec.handle.sid), amount6 };
  }

  /** Give up a pending login: its key and state go (nothing on chain changes). */
  async function discard(id) {
    const st = load(id);
    if (st.adopted) throw new LoginError("state", `login ${id} is open (${st.adopted.sid}); use logout`);
    await store.remove(st.id).catch(() => {});
    fs.rmSync(fileOf(id), { force: true });
  }

  return { begin, poll, wait, pending, signedOpen, logout, topUpLink, discard, identity, frontend, factory };
}
