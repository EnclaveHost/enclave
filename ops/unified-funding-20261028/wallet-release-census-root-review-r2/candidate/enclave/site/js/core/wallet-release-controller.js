/* ============================================================
   Wallet release controller: one deployment, one owner click, one
   signature, at most one relay POST - through the ACTUAL SDK
   ownerOperation({ op: "release" }) with an injected signer and relay
   that guard it (SDK-SEAMS.md). The SDK generates nonce and deadline;
   the wrapped signer validates and journals that exact typed data
   BEFORE the wallet is asked; the wrapped relay re-reads the chain after
   the signature, journals "dispatching", then makes the single real
   request. Nothing retries. Recovery only reads.
   ============================================================ */
import { readSnapshot, checkReleaseTypedData, verifyOutcome, releaseCalldata, PINS, ReleaseBlocked } from "./wallet-release-chain.js";
import { evaluateRelease, isWalletCensus } from "./wallet-release-census.js";
import { journalKey, JOURNAL_SCHEMA, PRE_DISPATCH, IN_FLIGHT } from "./wallet-release-store.js";
import { keccak256Hex } from "./keccak.js";

export class ReleaseError extends Error {
  constructor(code, message){ super(message); this.code = code; }
}

const lower = (a) => String(a || "").toLowerCase();
const short = (e) => String((e && (e.shortMessage || e.message)) || e).slice(0, 200);
const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (_k, x) => typeof x === "bigint" ? x.toString() : x));
const DEADLINE_MARGIN_SEC = 30;    // never dispatch a signature that could expire in the relay's queue

/**
 * deps: { sdk: { ownerOperation, ownerFromProvider }, provider (EIP-1193), relay (RelayClient), reader (wallet-release-chain
 * reader), journal (IdbJournal | MemoryJournal), census (createWalletCensus, shared per page), wallet, ownerAddress?,
 * vault, deployment, nowSec?, writer? }
 */
export function createReleaseController(deps){
  const { sdk, provider, relay, reader, journal, census } = deps;
  const wallet = lower(deps.wallet), vault = lower(deps.vault), id = lower(deps.deployment);
  const ownerAddress = deps.ownerAddress || deps.wallet;          // as the SDK puts it in the POST body
  const chainId = PINS.chainId;
  /** One fresh snapshot plus a census bound to that exact block. `extend` lets an eligibility check scan the history of
   *  a newly delegated vault; the pre-sign and pre-dispatch re-checks never extend (a new vault blocks instead). */
  async function gate(extend){
    if (!isWalletCensus(census) || census.wallet !== wallet || census.vault !== vault)
      throw new ReleaseError("census", "No authority census for this wallet and vault is attached; nothing can move.");
    const snap = await readSnapshot(reader, { wallet, vault, id }, nowSec()).catch((e) => { throw e instanceof ReleaseBlocked ? new ReleaseError(e.code, e.message) : e; });
    const ev = evaluateRelease(snap, await census.qualify(snap, { extend }), { nowSec: nowSec() });
    return { snap, ev };
  }
  const nowSec = deps.nowSec || (() => Math.floor(Date.now() / 1000));
  const writer = deps.writer || keccak256Hex("0x" + Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join(""));
  const identity = { chainId, ledger: PINS.ledger, vault, wallet, deployment: id, owner: wallet };
  const key = journalKey(identity);
  let live = true, busy = false;

  const assertLive = () => { if (!live) throw new ReleaseError("gone", "The page, wallet account or chain changed; nothing was sent."); };

  /** The wallet as it is NOW, without asking it to connect: eth_chainId + eth_accounts only. */
  async function providerGate(){
    if (!provider || typeof provider.request !== "function") throw new ReleaseError("provider", "No wallet connected.");
    const [cid, accts] = await Promise.all([provider.request({ method: "eth_chainId" }), provider.request({ method: "eth_accounts" })]);
    if (Number(cid) !== chainId) throw new ReleaseError("provider-chain", "Your wallet is on chain " + Number(cid) + ", not Base.");
    if (!Array.isArray(accts) || lower(accts[0]) !== wallet) throw new ReleaseError("provider-account", "Your wallet's active account is not " + wallet + ".");
  }

  /** Read-only: journal record + fresh chain eligibility + wallet state. */
  async function check(){
    let record;
    try { record = await journal.get(key); }
    catch(e){ return { kind: "blocked", blockers: [{ code: "storage", text: "The release journal (browser storage) is unavailable: " + short(e) }] }; }
    const blockers = [];
    let snap = null, ev = null;
    try { ({ snap, ev } = await gate(true)); blockers.push(...ev.blockers); }
    catch(e){ blockers.push({ code: e instanceof ReleaseError ? e.code : "read", text: e instanceof ReleaseError ? e.message : "Could not read the chain: " + short(e) }); }
    try { await providerGate(); } catch(e){ blockers.push({ code: e.code || "provider", text: e.message }); }
    if (record && record.state !== "cancelled") return { kind: "journal", record, blockers, review: ev && ev.review };
    return { kind: blockers.length ? "blocked" : "eligible", record, blockers, review: ev && ev.review };
  }

  /** The owner's explicit click. Throws ReleaseError; code "uncertain" means it MAY have been sent. */
  async function release(){
    if (busy) throw new ReleaseError("busy", "A release is already in progress here.");
    busy = true;
    const ctx = { rec: null, sig: null };
    const cancel = async (why) => {
      if (!ctx.rec || !PRE_DISPATCH.has(ctx.rec.state)) return;
      try { ctx.rec = await journal.cas(key, { state: ctx.rec.state, rev: ctx.rec.rev, writer }, { state: "cancelled", note: why.slice(0, 300) }); }
      catch(e){ /* stays pre-dispatch; recovery cancels it once its deadline has passed on-chain */ }
    };
    const settle = async (patch) => {
      try { ctx.rec = await journal.cas(key, { state: ctx.rec.state, rev: ctx.rec.rev, writer }, patch); }
      catch(e){ ctx.settleError = short(e); }          // stays "dispatching" = uncertain; recovery looks it up by nonce
    };
    try {
      assertLive();
      await providerGate();
      const existing = await journal.get(key);
      if (existing && existing.state !== "cancelled") throw new ReleaseError("exists", "A release of this deployment is already recorded (" + existing.state + ").");
      const { snap, ev } = await gate(true);
      if (!ev.eligible) throw new ReleaseError("blocked", ev.blockers.map((b) => b.text).join(" "));
      assertLive();
      const real = sdk.ownerFromProvider(provider, ownerAddress);

      const signer = {
        address: ownerAddress,
        async signTypedData(td){
          assertLive();
          if (ctx.rec) throw new ReleaseError("twice", "Only one signature per release.");
          const g = checkReleaseTypedData(td, { chainId, vault, id, wallet }, nowSec());
          await providerGate();
          assertLive();
          // fresh grants/delegations and tails through a NEW canonical block, immediately before the wallet is asked
          const pre = await gate(false);
          if (!pre.ev.eligible) throw new ReleaseError("blocked", "No longer eligible: " + pre.ev.blockers.map((b) => b.text).join(" "));
          if (pre.ev.prestateHash !== ev.prestateHash || pre.ev.censusPolicy !== ev.censusPolicy)
            throw new ReleaseError("changed", "The deployment, its sessions or its delegations changed since you reviewed it; check again. Nothing was signed.");
          assertLive();
          const now = Date.now();
          ctx.rec = await journal.putIfAbsent({
            schema: JOURNAL_SCHEMA, key, identity, state: "intent", rev: 0, writer, createdAt: now, updatedAt: now,
            typed: jsonSafe({ domain: td.domain, primaryType: td.primaryType, types: { Release: td.types.Release }, message: td.message }),
            nonce: g.nonce, deadline: g.deadline, prestate: snap.pre, prestateHash: ev.prestateHash,
            census: { policyHash: ev.censusPolicy, block: pre.snap.block.number, blockHash: pre.snap.block.hash },
            startBlock: snap.block.number, startBlockHash: snap.block.hash, sigHash: null, txHash: null, note: "",
          }, { replaceRev: existing && existing.state === "cancelled" ? existing.rev : undefined });
          assertLive();
          // the durable intent exists: only now is the wallet asked
          const sig = await real.signTypedData(td);
          let why = null;
          if (!live) why = "The page, wallet account or chain changed while your wallet was open";
          else if (!/^0x[0-9a-fA-F]{130,}$/.test(String(sig))) why = "The wallet returned a malformed signature";
          else { try { await providerGate(); } catch(e){ why = e.message; } }
          if (!why && !live) why = "The page, wallet account or chain changed while your wallet was open";
          if (why){ await cancel(why); throw new ReleaseError("after-sign", why + "; nothing was sent."); }
          ctx.rec = await journal.cas(key, { state: "intent", rev: ctx.rec.rev, writer }, { state: "signed", sigHash: keccak256Hex(sig) });
          ctx.sig = sig;
          return sig;
        },
      };

      const guardedRelay = {
        async request(method, path, body){
          if (method !== "POST" || path !== "/owner") throw new ReleaseError("relay-shape", "Refused an unexpected relay request.");
          if (!ctx.rec || ctx.rec.state !== "signed" || !ctx.sig) throw new ReleaseError("relay-order", "No durable signed release to send.");
          const m = ctx.rec.typed.message, a = body && body.args;
          const exact = body && Object.keys(body).sort().join() === "args,op,owner,sig,vault" && body.op === "release" &&
            lower(body.owner) === wallet && lower(body.vault) === vault && body.sig === ctx.sig && keccak256Hex(body.sig) === ctx.rec.sigHash &&
            a && Object.keys(a).sort().join() === "deployment,opNonce,signBefore,to" && lower(a.deployment) === lower(m.deployment) &&
            lower(a.to) === lower(m.to) && lower(a.opNonce) === ctx.rec.nonce && String(a.signBefore) === ctx.rec.deadline;
          if (!exact){ await cancel("relay body did not match the signed release"); throw new ReleaseError("relay-shape", "The release to send did not match what you signed; nothing was sent."); }
          // full revalidation AFTER the signature (not atomic with inclusion: release() takes no expected state)
          let why = null;
          try {
            assertLive();
            await providerGate();
            const { snap: s2, ev: e2 } = await gate(false);     // census re-read: sessions/delegates added during the prompt
            if (!e2.eligible) why = "No longer eligible: " + e2.blockers.map((b) => b.text).join(" ");
            else if (e2.prestateHash !== ctx.rec.prestateHash) why = "The deployment, escrow or reserve state changed while you were signing";
            else if (e2.censusPolicy !== ctx.rec.census.policyHash) why = "Your sessions or delegations changed while you were signing";
            else if (BigInt(ctx.rec.deadline) <= BigInt(nowSec() + DEADLINE_MARGIN_SEC)) why = "The signature is too close to its deadline";
            else if (typeof reader.simulate === "function"){
              try { await reader.simulate(vault, releaseCalldata(id, wallet, ctx.rec.nonce, BigInt(ctx.rec.deadline), ctx.sig), BigInt(s2.block.number)); }
              catch(e){ why = "A simulation of the exact signed release reverted (" + short(e) + ")"; }
            }
            assertLive();
          } catch(e){ why = why || e.message; }
          if (why){ await cancel(why); throw new ReleaseError("revalidate", why + ". Nothing was sent."); }
          // last durable boundary: once this commits, any failure below is "maybe sent"
          ctx.rec = await journal.cas(key, { state: "signed", rev: ctx.rec.rev, writer }, { state: "dispatching", dispatchedAt: Date.now() });
          // Persistence can yield to account/chain/page invalidation. Check at the actual effect boundary.
          assertLive();
          let res;
          try { res = await relay.request("POST", "/owner", body); }
          catch(e){
            await settle({ state: "uncertain", note: ("relay error after dispatch: " + short(e)).slice(0, 300) });
            throw new ReleaseError("uncertain", "The relay did not confirm (" + short(e) + "). It may still have been sent: this release is now checked on-chain only and will not be signed or sent again.");
          }
          const tx = res && /^0x[0-9a-fA-F]{64}$/.test(String(res.txHash)) ? lower(res.txHash) : null;
          await settle(tx ? { state: "submitted", txHash: tx } : { state: "uncertain", note: "relay answered without a transaction hash" });
          return res;
        },
      };

      try {
        return await sdk.ownerOperation({ relay: guardedRelay, owner: signer, chainId, vault: deps.vault, op: { op: "release", deployment: id, to: ownerAddress } });
      } catch(e){
        if (e instanceof ReleaseError || e instanceof ReleaseBlocked) throw e;
        await cancel("wallet or SDK error before dispatch: " + short(e));
        const m = short(e);
        if ((e && e.code === 4001) || /reject|denied|declin|cancel/i.test(m)) throw new ReleaseError("rejected", "Signature rejected; nothing was sent.");
        throw new ReleaseError(ctx.rec && IN_FLIGHT.has(ctx.rec.state) ? "uncertain" : "failed", m);
      }
    } finally {
      ctx.sig = null;                 // the signature lives only for this one dispatch
      busy = false;
    }
  }

  /** Read-only reconciliation of the journaled operation: never signs, never posts, never restarts. */
  async function recover(){
    const rec = await journal.get(key);
    if (!rec) return { record: null, outcome: null };
    if (PRE_DISPATCH.has(rec.state)){
      // never dispatched by any tab; once the CHAIN is past the deadline the signature (if any) can no longer execute
      const b = await reader.latestBlock();
      if (b && BigInt(b.timestamp) > BigInt(rec.deadline))
        return { record: await journal.cas(key, { state: rec.state, rev: rec.rev }, { state: "cancelled", note: "expired on-chain before dispatch; this browser never sent it" }), outcome: null };
      return { record: rec, outcome: { status: "pre-dispatch", reasons: ["started but not sent; resolves after its deadline"] } };
    }
    if (!IN_FLIGHT.has(rec.state)) return { record: rec, outcome: null };
    const v = await verifyOutcome(reader, rec);
    let patch = null;
    if (v.status === "finalized" || v.status === "conflict") patch = { state: v.status, txHash: v.txHash || rec.txHash, block: v.block || null, note: v.reasons.join("; ").slice(0, 300) };
    else if (v.status === "included" && rec.state !== "included") patch = { state: "included", txHash: v.txHash, block: v.block, note: v.reasons.join("; ").slice(0, 300) };
    else if (v.status === "pending" && v.txHash && rec.state !== "submitted") patch = { state: "submitted", txHash: v.txHash, note: v.reasons.join("; ").slice(0, 300) };
    if (!patch) return { record: rec, outcome: v };
    // a late result lands only on this exact identity and revision
    return { record: await journal.cas(key, { state: rec.state, rev: rec.rev }, patch), outcome: v };
  }

  return {
    key, identity, check, release, recover,
    get busy(){ return busy; },
    dispose(){ live = false; },
  };
}
