// Last-chance lease read before a local expiry can destroy a running guest.
// No transaction or locally inferred extension: two independent RPCs must name
// the same recent canonical block and the same complete deployment row.
import {createPublicClient, http} from 'viem';
import {base} from 'viem/chains';

const key = value => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? String(v) : v);
const blockHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
function checkedHeader(header, blockNumber) {
  if (!header || typeof header.number !== 'bigint' || header.number !== blockNumber
      || !blockHash(header.hash) || typeof header.timestamp !== 'bigint' || header.timestamp < 0n)
    throw Error('invalid canonical lease block metadata');
  const timestamp = Number(header.timestamp) * 1000;
  if (!Number.isSafeInteger(timestamp)) throw Error('invalid canonical lease block timestamp');
  return {hash: header.hash.toLowerCase(), timestamp};
}
export function createLeaseExpiryReader({rpc, clients, chainId = 8453, now = Date.now,
  timeoutMs = 8000, maxBlockAgeMs = 15000}) {
  if (!clients) {
    const origins = new Map();
    for (const url of rpc) {
      const u = new URL(url);
      if (u.protocol !== 'https:') continue;
      if (!origins.has(u.hostname)) origins.set(u.hostname, url);
    }
    clients = [...origins.values()].map(url => createPublicClient({chain: base,
      transport: http(url, {timeout: timeoutMs / 2, retryCount: 0})}));
  }
  if (clients.length < 2) throw Error('two independent lease readers required');
  let lastBlock = 0n;
  const pending = new Map();
  const busyClients = new Set();
  return function read({id, ledger, abi, minBlock = 0}) {
    const identity = `${ledger.toLowerCase()}:${id.toLowerCase()}`;
    // Coalesce each deployment's decision. Independently retain each provider's
    // slot until ALL of its requests end, even when another pair already won.
    if (pending.has(identity)) {
      const prior = pending.get(identity);
      if (BigInt(minBlock) <= prior.minBlock) return prior.promise;
      return prior.promise.then(snapshot => {
        if (snapshot.blockNumber < BigInt(minBlock)) throw Error('coalesced lease below requested block floor');
        return snapshot;
      });
    }
    const operation = (async () => {
      const reserved = clients.filter(c => !busyClients.has(c)).map(c => ({c}));
      if (reserved.length < 2) throw Error('lease quorum providers still busy');
      for (const {c} of reserved) busyClients.add(c);
      try {
        const requests = reserved.map(peer => peer.headRead = (async () => {
          const [network, head] = await Promise.allSettled([
            Promise.resolve().then(() => peer.c.getChainId()),
            Promise.resolve().then(() => peer.c.getBlockNumber({cacheTime: 0})),
          ]);
          if (network.status !== 'fulfilled' || head.status !== 'fulfilled'
              || network.value !== chainId || typeof head.value !== 'bigint' || head.value < 2n)
            throw Error('invalid lease chain head');
          return {peer, head: head.value};
        })());
        // Do not let a hung third endpoint prevent two healthy peers agreeing.
        const heads = await new Promise(resolve => {
          const found = []; let remaining = requests.length, grace;
          const finish = () => { clearTimeout(grace); resolve([...found]); };
          for (const request of requests) request.then(value => found.push(value), () => {}).finally(() => {
            if (--remaining === 0) finish();
            else if (found.length >= 2 && !grace) grace = setTimeout(finish, 100);
          });
        });
        const peers = heads
          .sort((a, b) => a.head > b.head ? -1 : a.head < b.head ? 1 : 0);
        if (peers.length < 2) throw Error('lease quorum unavailable');
        const blockNumber = [peers[1].head - 2n, lastBlock, BigInt(minBlock)].reduce((a, b) => a > b ? a : b);
        const fresh = timestamp => Number.isSafeInteger(timestamp) && timestamp <= now() + 5000 && timestamp + maxBlockAgeMs > now();
        const answers = peers.filter(p => p.head >= blockNumber).map(({peer}) => peer.answer = (async () => {
          const {c} = peer;
          const header = checkedHeader(await c.getBlock({blockNumber}), blockNumber);
          const timestamp = header.timestamp;
          if (!fresh(timestamp)) throw Error('stale lease block');
          const d = await c.readContract({address: ledger, abi, functionName: 'get', args: [id], blockNumber});
          const after = checkedHeader(await c.getBlock({blockNumber}), blockNumber);
          if (after.hash !== header.hash || after.timestamp !== timestamp) throw Error('lease block replaced');
          if (!fresh(timestamp)) throw Error('lease read became stale');
          return {d, blockNumber, blockHash: header.hash, timestamp};
        })());
        if (answers.length < 2) throw Error('lease block below previously observed floor');
        return await new Promise((resolve, reject) => {
          const seen = new Map(); let remaining = answers.length;
          for (const answer of answers) answer.then(value => {
            const k = key(value), count = (seen.get(k) || 0) + 1;
            seen.set(k, count);
            if (count >= 2 && fresh(value.timestamp)) { if (blockNumber > lastBlock) lastBlock = blockNumber; resolve(value); }
          }, () => {}).finally(() => { if (--remaining === 0) reject(Error('no fresh agreeing lease quorum')); });
        });
      } finally {
        for (const peer of reserved) {
          Promise.allSettled([peer.headRead, peer.answer]).then(() => busyClients.delete(peer.c));
        }
      }
    })();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('lease reconciliation deadline')), timeoutMs); });
    const bounded = Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
    const entry = {promise: bounded, minBlock: BigInt(minBlock)};
    pending.set(identity, entry);
    operation.finally(() => { if (pending.get(identity) === entry) pending.delete(identity); }).catch(() => {});
    return bounded;
  };
}

// Deliberately no mutation here: the supervisor checks stop/restart authority
// again after awaiting the reader, before applying any observed extension.
export function leaseExpiryVerdict(snapshot, {id, runner, operator, now = Date.now()}) {
  if (!snapshot || typeof snapshot.blockNumber !== 'bigint' || snapshot.blockNumber < 0n
      || snapshot.blockNumber > BigInt(Number.MAX_SAFE_INTEGER) || !blockHash(snapshot.blockHash)
      || !Number.isSafeInteger(snapshot.timestamp) || snapshot.timestamp % 1000 !== 0
      || snapshot.timestamp > now + 5000 || snapshot.timestamp + 15000 <= now)
    throw Error('invalid canonical lease snapshot');
  const d = snapshot.d, same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  if (!same(d.id, id) || typeof d.active !== 'boolean') throw Error('invalid deployment row');
  const until = Number(d.leaseUntil);
  if (!Number.isSafeInteger(until) || until < 0) throw Error('invalid lease expiry');
  if (!d.active || !same(d.runner, runner) || !same(d.runnerOperator, operator)) return {kind: 'revoked'};
  return {kind: until * 1000 > now ? 'live' : 'expired', until};
}
