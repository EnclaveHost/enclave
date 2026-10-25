// Concurrent requests to the untrusted credit-vault relay (cli/credit-vault.mjs createRelay, which the host role
// network/credit-vault-submitter.mjs serves), against the REAL sender: cli/independent.mjs sendQuorumTx over a 2-RPC
// quorum, paid by (a) a raw payer key (`enclave credit-vault relay`) and (b) the operator's loopback external signer
// (cli/independent-signer.mjs, sign mode, its durable intent journal; anvil's own eth_signTransaction is the wallet), as
// the host role pays. On anvil (test/credit-vault-fixture.mjs: the PRODUCTION credit-vault factory, the live ledger).
// Counting RPC proxies stand between the relay and anvil, so every signature and broadcast the payer makes is seen:
//   - the SAME request arriving several times before the relay's first agreed snapshot resolves: one validation, one
//     signature, one broadcast per RPC, one balance effect, and every caller gets the same transaction;
//   - DIFFERENT requests sharing one payer: they take turns, so they never race for the payer's nonce;
//   - a definite refusal (the sender's own "refusing to send": here the RPCs disagree on the payer's pending nonce, before
//     anything is signed): forgotten once complete, so the same bytes are validated again and execute once later;
//   - an unknown outcome: held. Repeats (sequential and overlapping) answer the same transaction and nothing is re-signed or
//     re-broadcast; the external signer's journal then refuses other sends until the operator resolves it.
//   node --test test/credit-vault-relay-concurrency.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = process.env.INJECT_FAILURE ? "negative-control run" : !haveAnvil ? "needs Foundry's anvil" : false;
const lc = (a) => String(a).toLowerCase();

if (process.env.INJECT_FAILURE) test("INJECTED FAILURE (negative control: the suite must exit nonzero)", () => assert.fail("injected"));

/** A JSON-RPC proxy that counts every method. Modes: "drop" answers eth_sendRawTransaction itself, without forwarding it
 *  (an answer that decides nothing: the bytes never arrive); "nonce-lie" reports the pending nonce one too high. */
async function countingRpc(target){
  const st = { calls: {}, raws: [], mode: null };
  const fwd = async (body) => (await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const one = async (item) => {
    st.calls[item.method] = (st.calls[item.method] || 0) + 1;
    if (item.method === "eth_sendRawTransaction"){
      st.raws.push(item.params[0]);
      if (st.mode === "drop") return { jsonrpc: "2.0", id: item.id, error: { code: -32603, message: "upstream request timed out" } };
    }
    if (st.mode === "nonce-lie" && item.method === "eth_getTransactionCount" && item.params[1] === "pending"){
      const r = await fwd(item); return { ...r, result: "0x" + (BigInt(r.result) + 1n).toString(16) };
    }
    return fwd(item);
  };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", async () => {
      try { const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out)); }
      catch { res.writeHead(502); res.end(); }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { st, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test("the credit-vault relay under concurrent requests: one flight per digest, one payer nonce at a time, refusals retried, unknowns held", { skip, timeout: 300000 }, async (t) => {
  const CV = await import(path.join(REPO, "site/js/core/credit-vault-independent.js"));
  const { createQuorumReader, jsonRpc } = await import(path.join(REPO, "site/js/core/quorum.js"));
  const CLI = await import(path.join(REPO, "cli/credit-vault.mjs"));
  const { QuorumChain } = await import(path.join(REPO, "cli/independent.mjs"));
  const { createExternalSigner, resolveIntent } = await import(path.join(REPO, "cli/independent-signer.mjs"));
  const F = await import(path.join(REPO, "test/credit-vault-fixture.mjs"));
  const { lib } = CLI;
  const stops = [];
  t.after(async () => { for (const s of stops.reverse()) try { await s(); } catch {} });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "credit-relay-conc-")); stops.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const A = await F.startChain(8453, stops);
  const S = await F.deployStack(A);
  const PINS = CV.validatePins({ chainId: 8453, origin: F.ORIGIN, rpId: F.RPID, usdc: S.usdc, factories: [S.older, S.current] });
  const prepReader = CV.withTxReads(createQuorumReader({ rpcs: A.rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 86400, chainId: 8453 }), jsonRpc());
  const opts = { reader: prepReader, pins: PINS };
  const mkVault = async () => {
    const K = F.passkey();
    await F.send(A, "admin", S.current.address, CV.ABI.factory, "createVault", [BigInt(K.x), BigInt(K.y)]);
    const vault = CV.deriveVault(lib, K.x, K.y, S.current);
    await F.send(A, "admin", S.usdc, F.CHAIN_FX.MockUSDC.abi, "mint", [vault, 40_000000n]);
    return { K, vault, profile: CV.makeProfile({ factory: S.current.address, vault, key: { x: K.x, y: K.y } }, { credentialId: K.credentialId }, PINS) };
  };
  const sign = async (V, op, params) => CV.signPrepared(lib, await CV.prepareVaultOp(lib, V.profile, op, params, opts), V.profile,
    { pins: PINS, origin: F.ORIGIN, getFn: V.K.getFn(), intent: { op, params } });
  const spec = { appRef: "catalog://app/0", gpuMilli: 0, cpuMilli: 500, appPort: 8080, ports: "", isPublic: true, configCid: "", maxRate6: "1000" };
  const deploymentOf = async (hash) => (await A.pub.getTransactionReceipt({ hash })).logs.find((l) => lc(l.address) === lc(S.ledger)).topics[1];
  const waitFor = async (f, what) => { const end = Date.now() + 10000; while (!f()) { if (Date.now() > end) throw new Error("timed out: " + what); await F.sleep(5); } };
  const settled = (ps) => Promise.allSettled(ps).then((rs) => rs.map((r) => r.status === "fulfilled" ? { ok: r.value } : { error: String(r.reason && r.reason.message || r.reason).slice(0, 160) }));

  for (const kind of ["payer key", "external signer"]){
    await t.test(`${kind}:`, async (tk) => {
      const rpcs = [await countingRpc(A.url), await countingRpc(A.url)];
      stops.push(() => Promise.all(rpcs.map((p) => p.close())));
      const broadcasts = () => rpcs.map((p) => p.st.calls.eth_sendRawTransaction || 0);
      const setMode = (m) => rpcs.forEach((p) => { p.st.mode = m; });
      const signerRpc = kind === "payer key" ? null : await countingRpc(A.url);
      if (signerRpc) stops.push(() => signerRpc.close());
      const from = kind === "payer key" ? F.ACCT.relay.address : F.ACCT.other.address;
      const signatures = () => signerRpc ? (signerRpc.st.calls.eth_signTransaction || 0) : null;
      const chain = new QuorumChain({ rpcs: rpcs.map((p) => p.url), quorum: 2, confirmations: 0, chainId: 8453, maxBlockAgeMs: 86400000 });
      // one relay as the role builds it (a fresh one per case, so each case stands alone): its own quorum reader and chain
      // over the counting RPCs, the payer key or the external signer with its own journal. The reader's agreed snapshot can
      // be held open, so requests provably overlap before it resolves.
      let n = 0;
      const mkRelay = async () => {
        const account = signerRpc ? createExternalSigner({ url: signerRpc.url, from, chainId: 8453, mode: "sign", journalDir: path.join(tmp, `signer-${kind.length}-${n++}`) }) : F.ACCT.relay;
        const g = { snapshots: 0, hold: null };
        const base = CLI.readerFor({ rpc: rpcs.map((p) => p.url), quorum: "2", confirmations: "0", "max-block-age": "86400" }, PINS);
        const reader = { ...base, snapshot: async (...a) => { g.snapshots++; if (g.hold) await g.hold.p; return base.snapshot(...a); } };
        const hold = () => { let release; g.hold = { p: new Promise((r) => { release = r; }) }; return () => { g.hold = null; release(); }; };
        const submit = CLI.createRelay({ reader, chain, account, pins: PINS });
        const server = CLI.relayServer(submit); await new Promise((r) => server.listen(0, "127.0.0.1", r)); stops.push(() => new Promise((r) => server.close(r)));
        const url = `http://127.0.0.1:${server.address().port}/v1/credit-vault/submit`;
        const post = (req) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) }).then(async (r) => ({ status: r.status, body: await r.json() }));
        return { account, g, hold, submit, post };
      };
      const nonce = () => A.pub.getTransactionCount({ address: from });
      // two customers' vaults, each with a deployment (deployed by the owner's own wallet, not through the relay)
      const mkDeployed = async () => {
        const V = await mkVault();
        const r = await CV.submitRequest(lib, await sign(V, "deploy", { spec, fundUsd: "10" }), CV.walletTransport(F.eip1193(A), F.ACCT.payer.address), { journal: F.memJournal(), reader: prepReader, pins: PINS });
        return { ...V, id: await deploymentOf(r.txHash) };
      };
      const V1 = await mkDeployed(), V2 = await mkDeployed();

      await tk.test("different requests sharing one payer overlap before the snapshot resolves: they take turns and both execute", async (s) => {
        const { g, hold, submit } = await mkRelay();
        const [f1, f2] = [await sign(V1, "fund", { id: V1.id, amountUsd: "1" }), await sign(V2, "fund", { id: V2.id, amountUsd: "1" })];
        const n0 = await nonce(), b0 = broadcasts(), u1 = await F.usdcOf(A, S, V1.vault), u2 = await F.usdcOf(A, S, V2.vault);
        const release = hold();
        const ps = [submit(f1), submit(f2)];
        await waitFor(() => g.snapshots === 2, "both requests reach the snapshot");
        release();
        const rs = await settled(ps);
        s.diagnostic(JSON.stringify({ results: rs, broadcasts: broadcasts().map((b, i) => b - b0[i]), payerNonce: `${n0} -> ${await nonce()}` }));
        for (const r of rs){ assert.ok(r.ok && /^0x[0-9a-f]{64}$/.test(r.ok.txHash) && !r.ok.unknown, JSON.stringify(rs)); }
        const tx = await Promise.all(rs.map((r) => A.pub.getTransaction({ hash: r.ok.txHash })));
        assert.deepEqual(tx.map((x) => x.nonce).sort(), [n0, n0 + 1], "consecutive payer nonces, no collision");
        for (const r of rs) assert.equal((await A.pub.getTransactionReceipt({ hash: r.ok.txHash })).status, "success");
        assert.equal(await nonce(), n0 + 2);
        assert.deepEqual(broadcasts().map((b, i) => b - b0[i]), [2, 2], "two transactions, each broadcast once to each RPC");
        assert.equal(await F.usdcOf(A, S, V1.vault), u1 - 1_000000n); assert.equal(await F.usdcOf(A, S, V2.vault), u2 - 1_000000n);
      });

      await tk.test("the SAME request three times over HTTP before the snapshot resolves: one validation, one signature, one broadcast, one balance effect", async (s) => {
        const { g, hold, post } = await mkRelay();
        const req = await sign(V1, "fund", { id: V1.id, amountUsd: "2" });
        const bal = await F.usdcOf(A, S, V1.vault), vn = await F.nonceOf(A, V1.vault), n0 = await nonce(), b0 = broadcasts(), g0 = g.snapshots, s0 = signatures();
        const release = hold();
        const ps = [post(req), post(req), post(JSON.parse(JSON.stringify(req)))];
        await waitFor(() => g.snapshots > g0, "the first request reaches the snapshot");
        await F.sleep(150);                                  // the other two have arrived (and, with no single flight, reached it too)
        const snapshotsWhileHeld = g.snapshots - g0;
        release();
        const rs = await Promise.all(ps);
        s.diagnostic(JSON.stringify({ answers: rs, snapshotsWhileHeld, broadcasts: broadcasts().map((b, i) => b - b0[i]), signatures: signerRpc ? signatures() - s0 : "local key", payerNonce: `${n0} -> ${await nonce()}` }));
        assert.equal(snapshotsWhileHeld, 1, "one validation for one digest");
        for (const r of rs){ assert.equal(r.status, 200, JSON.stringify(rs)); assert.equal(r.body.txHash, rs[0].body.txHash); assert.equal(r.body.unknown, undefined); }
        assert.deepEqual(broadcasts().map((b, i) => b - b0[i]), [1, 1], "one payer transaction, broadcast once to each RPC");
        if (signerRpc) assert.equal(signatures() - s0, 1, "the operator's wallet signed once");
        assert.equal(await nonce(), n0 + 1);
        assert.equal(await F.usdcOf(A, S, V1.vault), bal - 2_000000n, "one balance effect");
        assert.equal(await F.nonceOf(A, V1.vault), vn + 1n);
        // a later repeat answers the same transaction from the held flight: no validation, no broadcast
        const again = await post(req);
        assert.equal(again.body.txHash, rs[0].body.txHash); assert.deepEqual(broadcasts().map((b, i) => b - b0[i]), [1, 1]); assert.equal(g.snapshots - g0, 1);
      });

      await tk.test("a definite refusal (refusing to send: the RPCs disagree on the pending nonce) is forgotten once complete; the same bytes then execute once", async (s) => {
        const { g, hold, submit } = await mkRelay();
        const req = await sign(V1, "fund", { id: V1.id, amountUsd: "1" });
        const bal = await F.usdcOf(A, S, V1.vault), n0 = await nonce(), b0 = broadcasts(), g0 = g.snapshots, s0 = signatures();
        rpcs[1].st.mode = "nonce-lie";
        const release = hold();
        const ps = [submit(req), submit(req)];
        await waitFor(() => g.snapshots > g0, "the request reaches the snapshot"); await F.sleep(100);
        release();
        const rs = await settled(ps);
        setMode(null);
        s.diagnostic(JSON.stringify({ results: rs, snapshots: g.snapshots - g0, broadcasts: broadcasts().map((b, i) => b - b0[i]), signatures: signerRpc ? signatures() - s0 : "local key" }));
        for (const r of rs) assert.match(r.error || "", /refusing to send: the RPCs disagree on this wallet's pending nonce/, JSON.stringify(rs));
        assert.equal(g.snapshots - g0, 1, "one validation for both callers"); assert.deepEqual(broadcasts().map((b, i) => b - b0[i]), [0, 0], "nothing broadcast");
        if (signerRpc) assert.equal(signatures() - s0, 0, "nothing signed");
        assert.equal(await nonce(), n0); assert.equal(await F.usdcOf(A, S, V1.vault), bal, "nothing moved");
        const ok = await submit(req);                        // validated again (a new flight), sent, executed
        assert.equal(g.snapshots - g0, 2); assert.ok(!ok.unknown);
        assert.equal((await A.pub.getTransactionReceipt({ hash: ok.txHash })).status, "success");
        assert.equal(await nonce(), n0 + 1); assert.equal(await F.usdcOf(A, S, V1.vault), bal - 1_000000n, "exactly once");
      });

      await tk.test("an unknown outcome is held: repeats, sequential and overlapping, answer the same transaction; nothing is re-signed or re-broadcast", async (s) => {
        const { account, g, hold, submit, post } = await mkRelay();
        const req = await sign(V2, "fund", { id: V2.id, amountUsd: "1" });
        const bal = await F.usdcOf(A, S, V2.vault), n0 = await nonce(), b0 = broadcasts(), g0 = g.snapshots, s0 = signatures();
        setMode("drop");
        const release = hold();
        const first = [submit(req), submit(req)];
        await waitFor(() => g.snapshots > g0, "the request reaches the snapshot"); await F.sleep(100);
        release();
        const rs = await settled(first);
        const later = await settled([submit(req), submit(JSON.parse(JSON.stringify(req)))]);
        setMode(null);
        const viaHttp = await post(req);
        s.diagnostic(JSON.stringify({ results: rs, later, viaHttp, snapshots: g.snapshots - g0, broadcasts: broadcasts().map((b, i) => b - b0[i]), signatures: signerRpc ? signatures() - s0 : "local key" }));
        const H = rs[0].ok && rs[0].ok.txHash;
        for (const r of [...rs, ...later]) assert.deepEqual(r.ok, { txHash: H, unknown: true }, JSON.stringify([...rs, ...later]));
        assert.equal(viaHttp.status, 200); assert.equal(viaHttp.body.txHash, H);
        assert.equal(g.snapshots - g0, 1); assert.deepEqual(broadcasts().map((b, i) => b - b0[i]), [1, 1], "signed and broadcast once");
        if (signerRpc) assert.equal(signatures() - s0, 1);
        assert.equal(await nonce(), n0); assert.equal(await F.usdcOf(A, S, V2.vault), bal, "nothing moved yet");
        let busyReq = null;
        if (signerRpc){
          // the signer's journal holds the unknown intent: another request is refused before anything is signed, and that
          // definite refusal is not remembered
          busyReq = await sign(V1, "fund", { id: V1.id, amountUsd: "3" });
          await assert.rejects(submit(busyReq), /refusing to send: intent .* is unresolved/);
          assert.equal(signatures() - s0, 1, "nothing signed for the refused request");
        }
        // the operator's resolution: the SAME signed bytes, re-broadcast (the only safe repeat), land once
        const raw = rpcs[0].st.raws.at(-1);
        assert.equal(lib.keccak256(raw), H);
        await A.raw("eth_sendRawTransaction", [raw]);
        assert.equal((await A.pub.getTransactionReceipt({ hash: H })).status, "success");
        assert.equal(await F.usdcOf(A, S, V2.vault), bal - 1_000000n, "exactly once");
        assert.deepEqual(await submit(req), { txHash: H, unknown: true }, "the relay still answers the held transaction");
        if (signerRpc){
          const rec = account.journal.list().find((r) => lc(r.hash) === lc(H));
          assert.equal((await resolveIntent(chain, account.journal, rec.id)).state, "confirmed");
          const b1 = await F.usdcOf(A, S, V1.vault);
          const ok = await submit(busyReq);
          assert.equal((await A.pub.getTransactionReceipt({ hash: ok.txHash })).status, "success");
          assert.equal(await F.usdcOf(A, S, V1.vault), b1 - 3_000000n);
        }
      });
    });
  }
});
