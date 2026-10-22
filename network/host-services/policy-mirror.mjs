// Host role "policy-mirror" (network/host-services/roles.mjs; work/hosted-service-placement): a public, UNTRUSTED carrier of
// the administrator's signed platform host policy documents, run by an Enclave host instead of the fleet's /platform-policy
// routes. It serves what the platform host policy gate fetches (network/host-policy-mirrors.mjs):
//   GET  /platform-policy/<digest>.json   { document, signature }  (latest.json is never served: anchored documents only)
//   POST /platform-policy                 { document, signature }  publication by anyone holding an admin-signed document
//   GET  /health
// It stores a document only after checking it against FRESH authoritative state: the EnclaveAddressBook's CURRENT owner signs
// it (EIP-712, or ERC-1271 at that block) at a majority-agreed fresh block of the operator's RPC quorum, and it names this
// book, the book's registry and the configured hostOwnership. That keeps junk out of the store; it confers nothing - every
// gate verifies the anchor, signature, sequence and bans itself. It fills itself by digest from the anchored policy: from
// `importDir` (an operator-imported copy) and from `peers` (other carriers), and accepts publications, so a new policy
// reaches it without any fleet machine. It holds no key; its store is public data, refillable from any carrier.
//   node policy-mirror.mjs <config.json>
//   config: { port, bind, stateDir, rpc[2..8], minAgree?, book, hostOwnership, peers?[], importDir?, syncSec?, maxDocuments? }
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { quorumSnapshot } from '../host-policy-runtime.mjs';
import { MAX_POLICY_RESPONSE } from '../host-policy-mirrors.mjs';
import { fileCarrier, httpCarriers, freshVerifier, candidateDigest } from '../policy-carriers.mjs';

export function startPolicyMirror(cfg, { snapshot = null, fetch = globalThis.fetch, log = (m) => console.log(new Date().toISOString(), m) } = {}) {
  const docsDir = path.join(cfg.stateDir, 'documents');
  fs.mkdirSync(docsDir, { recursive: true, mode: 0o755 });
  const verify = freshVerifier({ snapshot: snapshot || quorumSnapshot({ rpcs: cfg.rpc, minAgree: cfg.minAgree ?? null }), book: cfg.book, hostOwnership: cfg.hostOwnership });
  const max = cfg.maxDocuments || 32, syncMs = (cfg.syncSec || 30) * 1000;
  const store = new Map();             // digest -> { document, signature, sequence }
  const carriers = [...(cfg.importDir ? [fileCarrier(cfg.importDir)] : []), ...httpCarriers(cfg.peers || [], { fetch })];
  let last = { at: null, block: null, anchor: null, anchoredAvailable: false, error: null };

  // documents kept by an earlier run were verified when stored; each is re-verified on the next sync (and dropped if the
  // current owner no longer signs it)
  for (const f of fs.readdirSync(docsDir).filter((n) => /^0x[0-9a-f]{64}\.json$/.test(n)).slice(0, max)) {
    try { const j = JSON.parse(fs.readFileSync(path.join(docsDir, f), 'utf8')); if (candidateDigest(j) === f.slice(0, 66)) store.set(f.slice(0, 66), { ...j, sequence: j.sequence ?? 0 }); } catch {}
  }
  const keep = (v) => {
    const file = path.join(docsDir, `${v.digest}.json`), tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ document: v.document, signature: v.signature, sequence: v.sequence }), { mode: 0o644 });
    fs.renameSync(tmp, file);
    store.set(v.digest, { document: v.document, signature: v.signature, sequence: v.sequence });
  };
  const drop = (d) => { store.delete(d); try { fs.unlinkSync(path.join(docsDir, `${d}.json`)); } catch {} };
  const prune = (anchored) => {
    const order = [...store.entries()].filter(([d]) => d !== anchored).sort((a, b) => b[1].sequence - a[1].sequence);
    for (const [d] of order.slice(Math.max(0, max - (anchored && store.has(anchored) ? 1 : 0)))) drop(d);
  };

  let syncing = null;
  async function sync() {
    try {
      const stored = [...store.entries()].map(([, v]) => ({ document: v.document, signature: v.signature }));
      const first = await verify(stored);
      const ok = new Set(first.verified.map((v) => v.digest));
      for (const d of [...store.keys()]) if (!ok.has(d)) { drop(d); log(`[policy-mirror] dropped ${d.slice(0, 18)}…: not signed by the address book's current owner at block ${first.block}`); }
      let anchored = first.anchor.state === 'anchored' ? first.anchor.digest : null;
      if (anchored && !store.has(anchored)) {
        for (const c of carriers) {
          const cands = (await c(anchored).catch(() => [])).filter((x) => candidateDigest(x) === anchored);
          if (!cands.length) continue;
          const v = (await verify(cands)).verified.find((x) => x.digest === anchored);
          if (v) { keep(v); log(`[policy-mirror] stored the anchored policy #${v.sequence} ${anchored.slice(0, 18)}…`); break; }
        }
      }
      prune(anchored);
      last = { at: new Date().toISOString(), block: first.block, anchor: first.anchor.state === 'anchored' ? anchored : first.anchor.state, anchoredAvailable: !!anchored && store.has(anchored), error: null };
    } catch (e) { last = { ...last, error: e.message }; log(`[policy-mirror] sync failed (serving what is stored): ${e.message}`); }
  }
  const syncOnce = () => (syncing ||= sync().finally(() => { syncing = null; }));

  let busy = false;
  const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': status === 200 ? 'max-age=30' : 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true, role: 'policy-mirror', documents: store.size, ...last });
    const m = /^\/platform-policy\/(0x[0-9a-f]{64})\.json$/.exec(url);
    if ((req.method === 'GET' || req.method === 'HEAD') && m) {
      const v = store.get(m[1]);
      return v ? send(res, 200, { document: v.document, signature: v.signature }) : send(res, 404, { error: 'not stored' });
    }
    if (req.method === 'GET' && url === '/platform-policy/latest.json') return send(res, 404, { error: 'this carrier serves anchored documents by digest only' });
    if (req.method === 'POST' && url === '/platform-policy') {
      if (busy) { req.resume(); return send(res, 429, { error: 'one publication at a time' }); }
      busy = true;
      const chunks = []; let n = 0, ended = false;
      req.on('data', (d) => { n += d.length; if (n > MAX_POLICY_RESPONSE) req.destroy(); else chunks.push(d); });
      req.on('close', () => { if (!ended) busy = false; });          // aborted or oversized: nothing was verified
      req.on('end', async () => {
        ended = true;
        try {
          let c; try { c = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'body must be JSON { document, signature }' }); }
          const digest = c && typeof c.signature === 'string' ? candidateDigest(c) : null;
          if (!digest) return send(res, 400, { error: 'not a well-formed platform host policy document with a signature' });
          let r; try { r = await verify([c]); } catch (e) { return send(res, 503, { error: `chain unavailable: ${e.message}` }); }
          const v = r.verified.find((x) => x.digest === digest);
          if (!v) return send(res, 422, { error: 'refused: not signed by the address book\'s current owner at a fresh block, or bound to another book, registry or ownership extension' });
          keep(v); prune(r.anchor.state === 'anchored' ? r.anchor.digest : null);
          log(`[policy-mirror] stored published policy #${v.sequence} ${digest.slice(0, 18)}…${v.anchored ? ' (the anchored one)' : ' (not anchored yet)'}`);
          return send(res, 201, { digest, sequence: v.sequence, anchored: v.anchored, block: r.block });
        } finally { busy = false; }
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  });
  const timer = setInterval(() => void syncOnce(), syncMs); timer.unref?.();
  void syncOnce();
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(cfg.port, cfg.bind, () => { log(`[policy-mirror] serving /platform-policy on ${cfg.bind}:${cfg.port} (${store.size} stored)`);
      ok({ server, sync: syncOnce, status: () => ({ documents: store.size, ...last }), close: () => { clearInterval(timer); server.closeAllConnections?.(); return new Promise((r) => server.close(() => r())); } }); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('usage: policy-mirror.mjs <config.json>'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  startPolicyMirror(cfg).then((m) => { for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => m.close().then(() => process.exit(0))); })
    .catch((e) => { console.error(`[policy-mirror] ${e.message}`); process.exit(1); });
}
