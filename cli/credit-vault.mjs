#!/usr/bin/env node
// enclave credit-vault: an EXISTING credit vault without Enclave's billing API (site/js/core/credit-vault-independent.js
// is the shared core; docs/credit-vault-independence.md the design). Reads come from 2-8 owner-chosen RPCs that must
// agree at one block; nothing here contacts api.enclave.host. Passkey SIGNATURES come from the /credit/ page at the
// vault's pinned origin (existing passkeys are origin-bound): this tool discovers, checks and reconciles, re-derives a
// signed request from its bytes, and submits it with a payer the owner names - their own key, or an untrusted relay.
// `relay` runs such a relay: it may only submit the exact signed bytes, and pays its own gas.
//
//   enclave credit-vault discover  (--x 0x.. --y 0x.. | --migration-file f | --profile f)
//   enclave credit-vault status    --profile f
//   enclave credit-vault verify    <request.json>
//   enclave credit-vault submit    <request.json> (--key-file f | --relay URL)
//   enclave credit-vault reconcile (--profile f | --vault 0x..)
//   enclave credit-vault mint      --x 0x.. --y 0x.. --key-file f [--factory 0x..]
//   enclave credit-vault relay     --listen 127.0.0.1:8788 --key-file f
//   enclave credit-vault gas       <deploymentId> --ledger 0x.. [--profile f --reserve-record f --reserve-record-digest sha256:..]
//   (verify / submit / reconcile / relay also take a signed request for the PROPOSED parallel lease-gas reserve, with its
//    reviewed record: --reserve-record FILE --reserve-record-digest sha256:<hex of the file>)
// common: --rpc URL (2-8, repeatable or comma list) [--quorum 2] [--confirmations 2] [--pins pins.json]
//         [--journal-dir ~/.enclave/credit-vault] [--json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import * as viem from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WebAuthnP256 } from "ox";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import * as CV from "../site/js/core/credit-vault-independent.js";
import * as R from "../site/js/core/credit-vault-reserve.js";
import { createQuorumReader, jsonRpc } from "../site/js/core/quorum.js";
import { QuorumChain, validateRpcOrigins, sendQuorumTx } from "./independent.mjs";

export const lib = { ...viem, WebAuthnP256, p256, sha256 };
const lc = (a) => String(a || "").toLowerCase();

/* ---- options ---- */
export function parseArgs(argv){
  const o = { _: [], rpc: [] };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (!a.startsWith("--")){ o._.push(a); continue; }
    const k = a.slice(2);
    if (["json", "allow-foreign"].includes(k)){ o[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    if (k === "rpc") o.rpc.push(...v.split(",").filter(Boolean)); else o[k] = v;
  }
  return o;
}
function loadPins(o){
  if (!o.pins) return CV.PRODUCTION_PINS;
  const p = JSON.parse(fs.readFileSync(o.pins, "utf8"));
  return CV.validatePins({ ...p, factories: p.factories.map((f) => ({ ...f, address: lc(f.address), implementation: lc(f.implementation) })), usdc: p.usdc ? lc(p.usdc) : undefined });
}
const intOpt = (v, d, lo, hi, what) => { if (v == null) return d; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${what} must be ${lo}..${hi}`); return n; };
export function readerFor(o, pins){
  const rpcs = validateRpcOrigins(o.rpc);
  const quorum = intOpt(o.quorum, 2, 2, rpcs.length, "quorum");
  const r = createQuorumReader({ rpcs, quorum, confirmations: intOpt(o.confirmations, 2, 0, 64, "confirmations"), maxBlockAgeSeconds: intOpt(o["max-block-age"], 600, 30, 86400, "max-block-age"), chainId: pins.chainId });
  return CV.withTxReads(r, jsonRpc());
}
function chainFor(o, pins){
  const rpcs = validateRpcOrigins(o.rpc);
  return new QuorumChain({ rpcs, quorum: intOpt(o.quorum, 2, 2, rpcs.length, "quorum"), confirmations: intOpt(o.confirmations, 2, 0, 64, "confirmations"),
    chainId: pins.chainId, maxBlockAgeMs: intOpt(o["max-block-age"], 600, 30, 86400, "max-block-age") * 1000 });
}
/** The payer's key: --key-file (0x-hex, the file's only content) or ENCLAVE_KEY. Never printed, never written. */
function payerAccount(o, env = process.env){
  let k = o["key-file"] ? fs.readFileSync(o["key-file"], "utf8").trim() : env.ENCLAVE_KEY ? String(env.ENCLAVE_KEY).trim() : "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("a payer is needed: --key-file <file holding a 0x private key> or ENCLAVE_KEY (it pays gas in ETH; it gains no authority over the vault)");
  const acct = privateKeyToAccount(k); k = null;
  return acct;
}
/* the journal: one file per vault, 0600, under the owner's own directory */
export function fileJournal(dir, chainId){
  const f = (vault) => path.join(dir, `pending-${chainId}-${lc(vault)}.json`);
  return {
    async get(vault){ try { return JSON.parse(fs.readFileSync(f(vault), "utf8")); } catch (e){ if (e.code === "ENOENT") return null; throw e; } },
    async put(entry){ fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const p = f(entry.request.vault), t = p + ".tmp"; fs.writeFileSync(t, JSON.stringify(entry, null, 2), { mode: 0o600 }); fs.renameSync(t, p); },
    async clear(vault){ fs.rmSync(f(vault), { force: true }); },
  };
}
const journalDir = (o) => o["journal-dir"] || path.join(os.homedir(), ".enclave", "credit-vault");
function readProfile(o, pins){ return CV.validateProfile(JSON.parse(fs.readFileSync(o.profile, "utf8")), pins); }
/** The REVIEWED record of the proposed parallel lease-gas reserve: --reserve-record FILE --reserve-record-digest sha256:<hex of
 *  the file's bytes>. A record never vouches for itself. -> the record, or null when neither flag is given. */
function reserveRecordOf(o, pins){
  if (!o["reserve-record"] && !o["reserve-record-digest"]) return null;
  if (!o["reserve-record"] || !o["reserve-record-digest"]) throw new Error("--reserve-record and --reserve-record-digest come together (the reviewed pin)");
  const bytes = fs.readFileSync(o["reserve-record"]);
  const d = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
  if (d !== String(o["reserve-record-digest"]).toLowerCase()) throw new Error(`the reserve record is ${d}, not the reviewed ${o["reserve-record-digest"]}`);
  return R.validateReserveRecord(JSON.parse(bytes.toString("utf8")), pins);
}
function readJson(file, max = 1 << 20){ const b = fs.readFileSync(file); if (b.length > max) throw new Error(file + " is too large"); return JSON.parse(b.toString("utf8")); }

/* ---- the raw transport: the owner's payer key signs ONE transaction, the same bytes go to every RPC ---- */
export function rawTransport(chain, account, { maxFeeGwei = 5, timeoutMs = 120000, log = () => {} } = {}){
  return { name: "key " + account.address, payer: lc(account.address), async send(req){
    try {
      const r = await sendQuorumTx(chain, { account, to: req.to, data: req.data, maxFeeGwei, timeoutMs, log });
      return { txHash: r.transactionHash };
    } catch (e){
      if (e && e.outcomeUnknown) throw Object.assign(new Error(e.message), { txHash: e.hash });
      if (/^refusing to send|nothing is pending/.test(String(e && e.message))) throw Object.assign(new Error(e.message), { definite: true });
      throw e;
    }
  } };
}

/* ---- the untrusted relay ---- */
/**
 * A relay anyone may run. It accepts ONLY a SignedVaultRequest whose bytes re-derive (verifyRequest), whose target is a
 * vault minted by a pinned factory (exact clone code at an agreed block), and that the vault accepts in an agreed
 * simulation from the relay's own account; it then sends exactly those bytes and pays the gas. It holds no authority:
 * it can drop a request, never change one. Idempotent by digest (a repeated request answers the same transaction).
 * Concurrency: from the moment a request's bytes verify, its digest has ONE flight (the agreed checks, the send and its
 * outcome) that every identical request joins, so one digest is never validated, signed or sent twice. Only a refusal that
 * leaves nothing pending is forgotten, once it completes, so the same bytes may be tried again; a transaction (sent, of
 * unknown outcome, or mined and reverted) is held for as long as the relay runs. The payer sends one transaction at a
 * time, so different requests never race for its nonce.
 */
// a failed send left nothing that can still be mined: refused before anything was signed ("refusing to send", the external
// signer's busy journal), every RPC definitely rejected the bytes ("nothing is pending"), the wallet sent nothing, or an
// error came before the payer signed (the external signer attaches its intent to any error after it signed)
const nothingPending = (e, signed) => /^refusing to send|nothing is pending|nothing was sent/.test(String(e && e.message || ""))
  || (!signed && !(e && (e.outcomeUnknown || e.mined || e.intent)));
export function createRelay({ reader, chain, account, pins, reserveRecord = null, maxFeeGwei = 5, log = () => {} }){
  const byDigest = new Map();
  let payerTurn = Promise.resolve();
  const record = reserveRecord ? R.validateReserveRecord(reserveRecord, pins) : null;
  const counts = { accepted: 0, refused: 0 };
  async function submit(req){
    const reserveReq = req && req.kind === R.RESERVE_REQUEST_KIND;
    try {
      if (reserveReq){
        // the PROPOSED parallel reserve: only when this relay's operator configured its reviewed record
        if (!record) throw Object.assign(new Error("this relay submits no reserve requests (no reviewed reserve record configured)"), { status: 422 });
        R.verifyReserveRequest(lib, req, { pins, record });
      } else CV.verifyRequest(lib, req, pins);
    } catch (e){ counts.refused++; throw e; }
    // no await between this lookup and installing the flight: an identical request arriving at any later point joins it
    const prior = byDigest.get(req.digest);
    if (prior) return prior;
    const flight = fly(req, reserveReq);
    byDigest.set(req.digest, flight);
    return flight;
  }
  async function fly(req, reserveReq){
    try {
      const snap = await reader.snapshot();
      const code = await reader.code(snap, req.to);
      if (reserveReq ? lc(viem.keccak256(code || "0x")) !== record.reserveCodeHash : !CV.isCreditVaultClone(lib, code, pins)){ counts.refused++;
        throw Object.assign(new Error(reserveReq ? "the target is not the reviewed reserve code" : "the target is not a vault of a pinned credit-vault factory"), { status: 422 }); }
      try { await reader.call(snap, req.to, req.data, { from: account.address }); }
      catch (e){ if (e && e.revert){ counts.refused++; throw Object.assign(new Error(`the ${reserveReq ? "reserve" : "vault"} refuses this request at the agreed block`), { status: 409 }); } throw e; }
    } catch (e){ byDigest.delete(req.digest); throw e; }   // nothing was signed: these bytes may be tried again
    counts.accepted++;
    // a raw key is wrapped to learn whether it signed; the external signer reports that itself (its intent on the error)
    let signed = false;
    const payer = typeof account.sendQuorumTx === "function" ? account
      : { address: account.address, signTransaction: async (tx) => { const raw = await account.signTransaction(tx); signed = true; return raw; } };
    // sendQuorumTx simulates again at a fresh agreed block when the turn comes, so waiting cannot make a stale send
    const turn = payerTurn.then(() => sendQuorumTx(chain, { account: payer, to: req.to, data: req.data, maxFeeGwei, log }));
    payerTurn = turn.then(() => {}, () => {});
    try { return { txHash: (await turn).transactionHash }; }
    catch (e){
      if (e && e.mined) throw Object.assign(new Error(`${String(e.message).slice(0, 200)}; this relay sends no second transaction for these bytes`), { status: 409 });
      if (nothingPending(e, signed)){ byDigest.delete(req.digest); throw e; }
      if (e && e.hash) return { txHash: e.hash, unknown: true };
      throw Object.assign(new Error(`the outcome is unknown and held (${String(e && e.message || e).slice(0, 200)})`), { status: 502 });
    }
  }
  submit.health = () => ({ ok: true, chainId: pins.chainId, payer: account.address, factories: pins.factories.map((f) => f.address),
    reserve: record ? record.reserve : null, ...counts });
  return submit;
}
export function relayServer(submit, { maxBody = 65536, perMinute = 30 } = {}){
  const hits = new Map();
  return http.createServer(async (req, res) => {
    const send = (s, j) => { res.writeHead(s, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }); res.end(JSON.stringify(j)); };
    if (req.method === "OPTIONS"){ res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" }); return res.end(); }
    if (req.url === "/health" && req.method === "GET") return send(200, submit.health ? submit.health() : { ok: true });
    if (req.url !== "/v1/credit-vault/submit") return send(404, { error: "not found" });
    if (req.method !== "POST") return send(405, { error: "POST only" });
    const ip = req.socket.remoteAddress || "?", now = Date.now(), w = (hits.get(ip) || []).filter((t) => now - t < 60000);
    if (w.length >= perMinute){ hits.set(ip, w); return send(429, { error: "rate limited" }); }
    w.push(now); hits.set(ip, w);
    const chunks = []; let n = 0;
    for await (const c of req){ n += c.length; if (n > maxBody) return send(413, { error: "request too large" }); chunks.push(c); }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { error: "body must be JSON" }); }
    try { send(200, await submit(body)); }
    catch (e){ send(e instanceof CV.VaultRefusal ? 422 : e.status || 502, { error: String(e && e.message || e).slice(0, 300) }); }
  });
}

/* ---- commands ---- */
export async function main(argv, { out = (s) => process.stdout.write(s + "\n"), env = process.env } = {}){
  const o = parseArgs(argv), cmd = o._[0], pins = loadPins(o);
  const show = (obj, lines) => out(o.json ? JSON.stringify(obj, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2) : lines.join("\n"));
  switch (cmd){
    case "discover": {
      let key;
      if (o.profile){ const p = readProfile(o, pins); key = { x: p.x, y: p.y }; }
      else if (o["migration-file"]){ const ks = CV.passkeysFromMigrationFile(readJson(o["migration-file"])); if (!ks.length) throw new Error("the migration file holds no passkey"); key = ks[Number(o.index || 0)]; }
      else key = { x: o.x, y: o.y };
      const d = await CV.discoverVaults(lib, key, { reader: readerFor(o, pins), pins });
      return show(d, [`key ${d.key.x.slice(0, 12)}…/${d.key.y.slice(0, 12)}… at agreed block ${d.block}`, ...d.vaults.map((v) => v.error ? `  ${v.factory}: ${v.error}` :
        `  ${v.vault}  ${v.label}${v.current ? " [book's current factory]" : ""}: ${v.deployed ? `minted, nonce ${v.nonce}, ${v.keyCount} key(s), this key ${v.keyActive ? "ACTIVE" : "not active"}` : "not minted"}, credit $${(Number(v.balance6 || 0) / 1e6).toFixed(2)}${v.ledger ? `, ledger ${v.ledger}` : ""}`)]);
    }
    case "status": {
      const p = readProfile(o, pins), reader = readerFor(o, pins);
      const st = await CV.vaultState(lib, p, { reader, pins });
      const pending = await fileJournal(journalDir(o), pins.chainId).get(p.vault);
      return show({ ...st, snap: undefined, implementationCode: undefined, block: st.snap.number, pending }, st.deployed ? [
        `vault ${p.vault} at agreed block ${st.snap.number}`, `  credit $${(Number(st.balance6) / 1e6).toFixed(2)} (closed-loop; pays Enclave runtime only)`,
        `  nonce ${st.nonce}; ${st.keyCount} key(s); this passkey ${st.keyActive ? "active" : "NOT active"}`,
        `  ledger (book "deployments") ${st.ledger} rev ${st.rev}; book "vaultFactory" ${st.bookVaultFactory}`,
        pending ? `  HELD: ${pending.request.op} nonce ${pending.request.nonce}, deadline ${pending.request.deadline} (${pending.status}) - run reconcile` : "  no undecided request"] : [`vault ${p.vault} is not minted yet`]);
    }
    case "verify": {
      const req = readJson(o._[1]);
      if (req && req.kind === R.RESERVE_REQUEST_KIND){
        const rv = R.verifyReserveRequest(lib, req, { pins, record: reserveRecordOf(o, pins) });
        return show({ ok: true, action: rv.action, args: rv.args }, [`OK: reserve ${rv.action} for ${req.id} by vault ${req.vault}, nonce ${req.nonce}, deadline ${req.deadline}`,
          `  digest ${req.digest} re-derived from the bytes; the assertion names it at ${pins.origin}`, "  The reserve and the vault judge the signature: submit simulates first."]);
      }
      const v = CV.verifyRequest(lib, req, pins);
      return show({ ok: true, ...v, sig: undefined }, [`OK: ${v.op} on vault ${req.vault}, nonce ${req.nonce}, deadline ${req.deadline}`, `  digest ${req.digest} re-derived from the bytes; the assertion names it at ${pins.origin}`,
        ...Object.entries(v.args).map(([k, x]) => `  ${k}: ${String(x).length > 80 ? String(x).slice(0, 80) + "…" : x}`), "  The vault itself judges the signature: submit simulates first."]);
    }
    case "submit": {
      const req = readJson(o._[1]), reader = readerFor(o, pins), journal = fileJournal(journalDir(o), pins.chainId);
      const transport = o.relay ? CV.relayTransport(o.relay) : rawTransport(chainFor(o, pins), payerAccount(o, env), { maxFeeGwei: Number(o["max-fee-gwei"] || 5) });
      const isReserve = req && req.kind === R.RESERVE_REQUEST_KIND;
      const rj = isReserve ? fileJournal(path.join(journalDir(o), "reserve"), pins.chainId) : journal;
      const r = isReserve ? await R.submitReserveRequest(lib, req, transport, { journal: rj, reader: transport.payer ? reader : null, pins, record: reserveRecordOf(o, pins) })
        : await CV.submitRequest(lib, req, transport, { journal, reader: transport.payer ? reader : null, pins });
      const entry = await rj.get(req.vault) || { request: req, txHashes: r.txHash ? [r.txHash] : [] };
      const rec = r.status === "not-sent" ? null : isReserve ? await R.reconcileReserve(lib, entry, { reader, journal: rj }) : await CV.reconcile(lib, entry, { reader, journal });
      return show({ submit: r.status, txHash: r.txHash || null, outcome: rec }, [`submit: ${r.status}${r.txHash ? " " + r.txHash : ""}${r.reason ? " (" + r.reason + ")" : ""}`,
        rec ? `outcome: ${rec.status}${rec.txHash ? " in " + rec.txHash : ""}${rec.status === "pending" ? " - held until it executes or its deadline passes; only these same bytes may be resent" : ""}` : "nothing was sent; nothing is held"]);
    }
    case "reconcile": {
      const vault = o.vault ? lc(o.vault) : readProfile(o, pins).vault, journal = fileJournal(journalDir(o), pins.chainId);
      const rj = fileJournal(path.join(journalDir(o), "reserve"), pins.chainId);
      const e = await journal.get(vault), er = await rj.get(vault);
      if (!e && !er) return show({ status: "none" }, ["no undecided request for " + vault]);
      if (!e){ const rr = await R.reconcileReserve(lib, er, { reader: readerFor(o, pins), journal: rj }); return show(rr, [`reserve ${er.request.action} nonce ${er.request.nonce}: ${rr.status}${rr.txHash ? " in " + rr.txHash : ""}`]); }
      const r = await CV.reconcile(lib, e, { reader: readerFor(o, pins), journal });
      return show(r, [`${e.request.op} nonce ${e.request.nonce}: ${r.status}${r.txHash ? " in " + r.txHash : ""}`]);
    }
    case "mint": {
      const k = CV.checkKey(lib, o.x, o.y), f = o.factory ? pins.factories.find((x) => lc(x.address) === lc(o.factory)) : pins.factories[pins.factories.length - 1];
      if (!f) throw new Error("--factory is not a pinned factory");
      const data = viem.encodeFunctionData({ abi: CV.ABI.factory, functionName: "createVault", args: [BigInt(k.x), BigInt(k.y)] });
      const r = await sendQuorumTx(chainFor(o, pins), { account: payerAccount(o, env), to: f.address, data, maxFeeGwei: Number(o["max-fee-gwei"] || 5) });
      return show({ vault: CV.deriveVault(lib, k.x, k.y, f), txHash: r.transactionHash }, [`minted ${CV.deriveVault(lib, k.x, k.y, f)} (${r.transactionHash}); createVault is permissionless and gives the payer no authority`]);
    }
    case "relay": {
      const [host, port] = String(o.listen || "127.0.0.1:8788").split(":");
      const account = payerAccount(o, env), submit = createRelay({ reader: readerFor(o, pins), chain: chainFor(o, pins), account, pins, reserveRecord: reserveRecordOf(o, pins) });
      const srv = relayServer(submit);
      await new Promise((r) => srv.listen(Number(port), host, r));
      out(JSON.stringify({ relay: `http://${host}:${srv.address().port}`, payer: account.address }));
      return new Promise(() => {});
    }
    case "gas": {
      const id = lc(o._[1]); if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error("gas <deploymentId>");
      const reader = readerFor(o, pins), snap = await reader.snapshot();
      const ledger = o.ledger ? lc(o.ledger) : null;
      if (!ledger) throw new Error("--ledger <the deployments ledger> (the book's \"deployments\")");
      const ret = String(await reader.call(snap, ledger, "0x8eaa6ac0" + id.slice(2))).slice(2);
      const owner = "0x" + ret.slice(128 + 24, 192);
      const vaultOwner = !!CV.isCreditVaultClone(lib, await reader.code(snap, owner), pins);
      const why = CV.reserveRefusal(vaultOwner);
      const record = vaultOwner ? reserveRecordOf(o, pins) : null;
      if (record && o.profile){   // the PROPOSED parallel reserve, with its reviewed record: this vault's reserve there
        const st = await R.reserveState(lib, readProfile(o, pins), record, id, { reader, pins });
        return show({ owner, creditVault: true, liveReserveSupported: false, parallelReserve: record.reserve, ownedByVault: st.ownedByVault, originBound: st.originBound,
          signerRefused: st.signerRefused, balanceWei: st.reserve.balanceWei.toString(), enabled: st.reserve.enabled, sigNonce: st.sigNonce.toString() },
          [`owner of record ${owner} (a credit vault); the live reserve cannot serve it`, `parallel reserve ${record.reserve} (reviewed record): ${st.reserve.balanceWei} wei, ${st.reserve.enabled ? "ENABLED" : "not enabled"}, signature nonce ${st.sigNonce}`,
            st.originBound ? "configure/claimant/withdraw are signed with the vault passkey on the /credit/ page and submitted with `submit`" : "OLDER vault build: its signatures are refused by the parallel reserve"]);
      }
      return show({ owner, creditVault: vaultOwner, reserveSupported: !why, reason: why }, [`owner of record ${owner}${vaultOwner ? " (a credit vault)" : ""}`, why || "not a credit vault: use `enclave lease-gas` for this record"]);
    }
    default:
      throw new Error("usage: enclave credit-vault discover|status|verify|submit|reconcile|mint|relay|gas (see the header of cli/credit-vault.mjs)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`){
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`credit-vault: ${e && e.message || e}\n`); process.exit(1); });
}
