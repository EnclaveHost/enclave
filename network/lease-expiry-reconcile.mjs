// Last-chance lease read before a local expiry can destroy a running guest.
// No transaction or locally inferred extension: two independent RPCs must name
// the same recent canonical block and the same complete deployment row.
import {createPublicClient, http} from 'viem';
import {base} from 'viem/chains';

const key = value => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? String(v) : v);
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
  return function read({id, ledger, abi, minBlock = 0}) {
    const identity = `${ledger.toLowerCase()}:${id.toLowerCase()}`;
    // A timed-out request still owns its slot until its underlying reads end.
    // A hung provider cannot create an unbounded stack of background requests.
    if (pending.has(identity)) return pending.get(identity);
    const operation = (async () => {
      const requests = clients.map(async c => {
        const [network, head] = await Promise.all([c.getChainId(), c.getBlockNumber({cacheTime: 0})]);
        if (network !== chainId) throw Error('wrong chain');
        return {c, head};
      });
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
      const answers = peers.filter(p => p.head >= blockNumber).map(async ({c}) => {
        const header = await c.getBlock({blockNumber});
        const timestamp = Number(header.timestamp) * 1000;
        if (!fresh(timestamp)) throw Error('stale lease block');
        const d = await c.readContract({address: ledger, abi, functionName: 'get', args: [id], blockNumber});
        if ((await c.getBlock({blockNumber})).hash !== header.hash) throw Error('lease block replaced');
        if (!fresh(timestamp)) throw Error('lease read became stale');
        return {d, blockNumber, blockHash: header.hash, timestamp};
      });
      if (answers.length < 2) throw Error('lease block below previously observed floor');
      return new Promise((resolve, reject) => {
        const seen = new Map(); let remaining = answers.length;
        for (const answer of answers) answer.then(value => {
          const k = key(value), count = (seen.get(k) || 0) + 1;
          seen.set(k, count);
          if (count >= 2 && fresh(value.timestamp)) { if (blockNumber > lastBlock) lastBlock = blockNumber; resolve(value); }
        }, () => {}).finally(() => { if (--remaining === 0) reject(Error('no fresh agreeing lease quorum')); });
      });
    })();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('lease reconciliation deadline')), timeoutMs); });
    const bounded = Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
    pending.set(identity, bounded);
    operation.finally(() => { if (pending.get(identity) === bounded) pending.delete(identity); }).catch(() => {});
    return bounded;
  };
}

// Deliberately no mutation here: the supervisor checks stop/restart authority
// again after awaiting the reader, before applying any observed extension.
export function leaseExpiryVerdict(snapshot, {id, runner, operator, now = Date.now()}) {
  const d = snapshot.d, same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  if (!same(d.id, id) || typeof d.active !== 'boolean') throw Error('invalid deployment row');
  const until = Number(d.leaseUntil);
  if (!Number.isSafeInteger(until) || until < 0) throw Error('invalid lease expiry');
  if (!d.active || !same(d.runner, runner) || !same(d.runnerOperator, operator)) return {kind: 'revoked'};
  return {kind: until * 1000 > now ? 'live' : 'expired', until};
}
