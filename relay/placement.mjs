// Saved, advisory placement. This never changes a lease or relaxes a host's
// admission checks: a preferred host gets the first hint, then normal fallback.
import { JsonStore, makeRateLimiter } from './store.js';
import { recoverMessageAddress } from 'viem';

export const placementMessage = (ledger, id, hostId, expiry, nonce) =>
  `Enclave placement\nLedger: ${ledger}\nDeployment: ${id}\nPreferred host: ${hostId || 'Auto'}\nExpires: ${expiry}\nNonce: ${nonce}`;
const ID = /^0x[0-9a-f]{64}$/;
const liveLease = (d, now) => ID.test(String(d.runner)) && !/^0x0{64}$/.test(d.runner)
  && Number(d.leaseUntil) * 1000 > now;

export function createPlacement({ file, ledgerAddress, read, fleet, accountOwner = async () => null,
  recover = recoverMessageAddress, now = Date.now }) {
  const store = file ? new JsonStore(file, { byId: {} }, { durable: true }) : null;
  const replay = new Map(), attempts = new Map();
  const rate = makeRateLimiter({ capacity: 20, refillPerSec: 1 / 3 });
  const key = id => `${String(ledgerAddress()).toLowerCase()}:${id}`;
  const saved = (id, owner) => {
    const rec = store?.data.byId[key(id)];
    return rec && rec.owner === String(owner).toLowerCase() ? rec : null;
  };
  const view = rec => rec ? { configured: true, hostId: rec.hostId, name: rec.name,
    isolation: rec.isolation, updatedAt: rec.updatedAt } : { configured: false };
  return {
    hasAny() { return !!store && Object.keys(store.data.byId).length > 0; },
    has(id) { return !!store?.data.byId[key(id)]; },
    saved,
    async get(id) { return view(saved(id, (await read(id)).owner)); },
    async put(id, body, req) {
      const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
      if (!store) fail(503, 'Placement preferences are unavailable.');
      if (!ID.test(id) || !body || Array.isArray(body)) fail(400, 'Invalid placement request.');
      const hostId = body.hostId;
      if (typeof hostId !== 'string' || (hostId && (!ID.test(hostId) || /^0x0{64}$/.test(hostId))))
        fail(400, 'Select Auto or a registered host.');
      const d = await read(id), owner = String(d.owner).toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(owner) || /^0x0{40}$/.test(owner)) fail(404, 'Deployment not found.');
      let signature;
      if (await accountOwner(req) !== owner) {
        const { expiry, nonce } = body;
        if (!Number.isSafeInteger(expiry) || expiry * 1000 < now() || expiry * 1000 > now() + 600000
            || typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) fail(400, 'Sign a fresh placement request.');
        signature = String(body.signature || '');
        let signer;
        try { signer = await recover({ message: placementMessage(String(ledgerAddress()).toLowerCase(), id, hostId, expiry, nonce), signature }); }
        catch { fail(403, 'The placement signature is invalid.'); }
        if (String(signer).toLowerCase() !== owner) fail(403, 'Only the deployment owner can change placement.');
        for (const [sig, until] of replay) if (until < now()) replay.delete(sig);
        if (replay.has(signature)) fail(409, 'This placement signature was already used.');
      }
      if (!rate(owner)) fail(429, 'Too many placement changes; retry shortly.');
      const host = hostId ? fleet().find(h => String(h.id).toLowerCase() === hostId) : null;
      const prior = saved(id, owner);
      if (hostId && !host && prior?.hostId !== hostId) fail(409, 'That host is no longer in the fleet. Reopen Pin.');
      const rec = { owner, hostId, name: host?.name || host?.endpoint || (hostId ? prior?.name || '' : ''),
        isolation: host?.availability?.apps?.isolation || host?.availability?.isolation || (hostId ? prior?.isolation || '' : ''),
        updatedAt: now() };
      const old = store.data.byId[key(id)];
      store.data.byId[key(id)] = rec;
      try { store.flush(); } catch (e) { if (old) store.data.byId[key(id)] = old; else delete store.data.byId[key(id)]; throw e; }
      if (signature) replay.set(signature, body.expiry * 1000);
      return view(rec);
    },
    async sweep(rows, claim) {
      let count = 0;
      for (const d of rows) {
        const id = String(d.id).toLowerCase(), rec = saved(id, d.owner);
        if (!rec || !d.active || liveLease(d, now()) || now() - (attempts.get(id) || 0) < 30000) continue;
        attempts.set(id, now());
        await claim(id, rec.hostId, d).catch(() => {});
        if (++count >= 8) break;
      }
    },
  };
}
