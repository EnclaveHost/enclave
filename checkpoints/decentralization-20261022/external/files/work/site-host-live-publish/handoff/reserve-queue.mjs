// Stage B of the site activation: the two lease-gas operations for the site deployment (deposit + configure), served by
// the EXISTING reviewed enrollment queue. Nothing here is new signing logic:
//   - operations: work/lease-enrollment-signing/plan.mjs expectedOperations (the reviewed builder);
//   - chain checks: work/lease-enrollment-signing/chain.mjs (anchor, 7702/code-hash/binding/authority, pre/post state,
//     exact-request landing, two providers);
//   - transport: work/lease-enrollment-signing/queue-server.mjs + queue-app.js (ordered, journaled; MetaMask signs);
//   - trust: the reviewed ENROLLMENT, DERIVED with apps = [the site deployment] and no relay transfers.
// Every reused file is pinned by sha256; nothing is written into the reviewed directories (own journals).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), W = path.resolve(here, "../.."), ROOT = path.resolve(W, "..");
export const ENR = path.join(W, "lease-enrollment-signing"), SIGN = path.join(W, "lease-gas-wallet-signing");
const sha = (b) => createHash("sha256").update(b).digest("hex");
// the reviewed files this stage reuses, exactly as frozen (work/lease-enrollment-signing/frozen-inventory.json and root's pins in serve.mjs)
export const REUSED_PINS = Object.freeze({
  [path.join(ENR, "chain.mjs")]: "a735dcb4623584d28c8605b31abb6dc1a9e1f5fae37eda4e7d88529566bedc11",
  [path.join(ENR, "plan.mjs")]: "15b1465f4e37b6f32dcec3b895b7e0100523ff0c758fa094b8ec65b45752125e",
  [path.join(ENR, "queue-server.mjs")]: "579a912930e1e9392980fe403368db108294ed763d6bdad0036bcb3326e612c5",
  [path.join(ENR, "queue-app.js")]: "a5fcc15fe1ef16fe9623638b671f54fecfed10b6bca813f917cd0dfd537dcf73",
  [path.join(ENR, "queue.html")]: "0ab89e772cd386c41951dae276d5b123977e4cb0dcb5cd6a2af44875d5d82eb7",
  [path.join(ENR, "queue.css")]: "573930158aa07ea4cd6101c03c382762b3ddf606a3515478f8ebb08b7a83450a",
  [path.join(ENR, "trust.mjs")]: "6118af83c5b6ea23f2a1f1292c41c0c494062d455c502d1a193dba3756c125a4",
  [path.join(ENR, "handoff-server.mjs")]: "fb189e4610c8579739fb59fe385b91b461bc5bfb06d95780e94ec92e53d95b75",
  [path.join(SIGN, "handoff-server.mjs")]: "fb189e4610c8579739fb59fe385b91b461bc5bfb06d95780e94ec92e53d95b75",
  [path.join(SIGN, "rpc-clients.mjs")]: "a46de84eba226dd17d8f8521014186b8a4dd1f940e6d29ef7de9770b82b1b201",
  [path.join(SIGN, "artifacts.mjs")]: "6cb2f95ca862210412f46faffb3d1331e2206734297907839a918e5ee87831a7",
  [path.join(SIGN, "trust.mjs")]: "0636f14538e2ff3658c8e56b6e750ae15fb11c4bf33c328b3b6340b070b1faf0",
  [path.join(SIGN, "stages.mjs")]: "a4994bdb8b6c6d32f06fdcb5db2205c759982f3e8e67101d11bdcdb5e729d37c",
});
export function checkReusedPins() { for (const [f, h] of Object.entries(REUSED_PINS)) if (sha(fs.readFileSync(f)) !== h) throw Error(`reused module ${path.relative(W, f)} changed since review`); }

const { ENROLLMENT } = await import(path.join(ENR, "trust.mjs"));
const { expectedOperations } = await import(path.join(ENR, "plan.mjs"));

/** The reviewed ENROLLMENT narrowed to this one admin-owned deployment (claimPolicy 1 = self-hosted runner). */
export function reserveTrust({ id, depositWei, base = ENROLLMENT }) {
  return Object.freeze({ ...base, apps: Object.freeze([[id, "admin", "enclave-site v1 (site-host)"]]), relays: Object.freeze([]), perAppWei: depositWei, totalWei: depositWei });
}

/** -> { trust, operations, opsSha256 } for a deployment id and deposit; refuses anything but admin -> reserve deposit + configure. */
export function reserveOperations({ id, depositWei, abi, base = ENROLLMENT }) {
  id = String(id || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw Error("deployment id must be 0x<64 hex> (the verified Created id)");
  depositWei = BigInt(depositWei);
  if (depositWei <= 0n || depositWei > 5_000_000_000_000_000n) throw Error("deposit must be > 0 and <= 0.005 ETH");
  const trust = reserveTrust({ id, depositWei, base });
  const operations = expectedOperations(trust, abi);
  if (operations.length !== 2 || operations[0].kind !== "deposit" || operations[1].kind !== "configure") throw Error("unexpected operation set");
  for (const o of operations) if (o.to.toLowerCase() !== base.reserve || o.from !== base.admin.toLowerCase() || o.app !== id) throw Error("operation is not admin -> reserve for this deployment");
  if (BigInt(operations[0].value) !== depositWei || BigInt(operations[1].value) !== 0n || operations[1].policy.claimPolicy !== 1) throw Error("unexpected values or policy");
  const opsSha256 = sha(JSON.stringify(operations.map((o) => [o.index, o.kind, o.from, o.to, o.value, o.gas, o.data])));
  return { trust, operations, opsSha256 };
}

/** The production reserve ABI, its source/artifact provenance re-verified (root's helper). */
export async function reserveAbi() {
  const { PRODUCTION } = await import(path.join(SIGN, "trust.mjs"));
  const { verifiedArtifacts } = await import(path.join(SIGN, "artifacts.mjs"));
  return verifiedArtifacts({ trust: PRODUCTION }).EnclaveLeaseGasReserve.abi;
}

/**
 * stageBStarter({ open(id) -> a reserve queue (not listening), port }) -> { start(id) -> { url }, close(), get url }
 * Process-local: each process opens the reviewed queue on its own disk journals (so a submitted attempt survives a
 * restart) and listens once; concurrent starts share one attempt; a failed listen closes that queue and leaves nothing
 * behind, so a later start() tries again from scratch.
 */
export function stageBStarter({ open, port }) {
  let live = null, opening = null;
  return {
    get url() { return live?.url ?? null; },
    start(id) {
      if (live) return live.id === id ? Promise.resolve({ url: live.url }) : Promise.reject(Error("stage B is already serving another deployment"));
      opening ??= (async () => {
        const q = await open(id);
        try { const url = await q.listen(port); live = { id, q, url }; return { url }; }
        catch (e) { await q.close().catch(() => {}); throw e; }
      })().finally(() => { opening = null; });
      return opening;
    },
    async close() { const q = live?.q; live = null; if (q) await q.close(); },
  };
}

/**
 * createReserveQueue({ id, depositWei, approvedOpsSha256, abi, clients, receiptClients, journalDir, chain })
 *   -> the reviewed queue server for exactly the approved two operations (not listening yet). `chain` defaults to the
 *   reviewed chain.mjs (a test may inject the same module bound to a model).
 */
export async function createReserveQueue({ id, depositWei, approvedOpsSha256, abi, clients, receiptClients, journalDir, chain = null, base = ENROLLMENT }) {
  const { trust, operations, opsSha256 } = reserveOperations({ id, depositWei, abi, base });
  if (opsSha256 !== approvedOpsSha256) throw Error("refusing stage B: these operations are not the approved ones (sha256 " + opsSha256 + ")");
  const { fileJournal } = await import(path.join(ENR, "handoff-server.mjs"));
  const { createQueueServer } = await import(path.join(ENR, "queue-server.mjs"));
  const c = chain || await import(path.join(ENR, "chain.mjs"));
  return createQueueServer({
    operations, planSha256: opsSha256, setupHashes: base.setupHashes,
    journals: operations.map((_o, i) => fileJournal(path.join(journalDir, `op-${i + 1}.json`))),
    session: (() => { const j = fileJournal(path.join(journalDir, "session.json")); return { read: () => { const s = j.read(); return s.status === "ready" ? { status: "not started" } : s; }, write: j.write }; })(),
    start: (ops) => c.startCheck({ trust, abi, ops, clients }),
    prepare: (op, { reservedNonce, laterValueWei }) => c.prepareOperation({ trust, abi, op, planSha256: opsSha256, reservedNonce, laterValueWei, clients }),
    verify: (op, attempts, hash) => c.verifyOperation({ trust, abi, op, attempts, hash, clients: receiptClients }),
    release: (_op, nonce) => c.releaseCheck({ trust, clients, nonce }),
    assets: { "/": { type: "text/html", body: fs.readFileSync(path.join(ENR, "queue.html"), "utf8") }, "/app.js": { type: "text/javascript", body: fs.readFileSync(path.join(ENR, "queue-app.js"), "utf8") },
      "/style.css": { type: "text/css", body: fs.readFileSync(path.join(ROOT, "work/metamask-bridge/style.css"), "utf8") + fs.readFileSync(path.join(ENR, "queue.css"), "utf8") } },
  });
}
