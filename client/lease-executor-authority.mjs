// Authority checks BEFORE an operator signs any EIP-7702 delegation. The deployment record comes from reviewed local
// configuration, never an RPC or relay response. All authority reads use one fresh, quorum-agreed canonical block hash.
// Admin migrations remain possible: distribute a reviewed replacement record and reauthorize deliberately.
import { getAddress, keccak256, encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import { rpcEndpoint } from "../network/rpc-identity.mjs";

const HASH = /^0x[0-9a-f]{64}$/i;
const ZERO = /^0x0{40}$/i;
const EMPTY_HASH = keccak256("0x");
const ABI = parseAbi([
  "function executor() view returns (address)",
  "function reserve() view returns (address)",
  "function ledger() view returns (address)",
  "function registry() view returns (address)",
  "function delegationCodeHash() view returns (bytes32)",
]);
const keyOf = (v) => JSON.stringify(v, (_k, x) => typeof x === "bigint" ? x.toString() : x);
const lower = (v) => String(v).toLowerCase();

export function leaseDeploymentPins(record) {
  if (!record || !Number.isSafeInteger(record.chainId) || record.chainId <= 0)
    throw new Error("lease-gas needs a reviewed deployment record with a nonzero chain ID");
  const out = { chainId: record.chainId };
  for (const k of ["reserve", "executor", "ledger", "registry"]) {
    try { out[k] = getAddress(record[k]); } catch { throw new Error(`lease-gas deployment pin: invalid ${k}`); }
    if (ZERO.test(out[k])) throw new Error(`lease-gas deployment pin: zero ${k}`);
  }
  for (const k of ["reserveCodeHash", "executorCodeHash"]) {
    if (!HASH.test(record[k] || "") || lower(record[k]) === EMPTY_HASH)
      throw new Error(`lease-gas deployment pin: invalid ${k}`);
    out[k] = lower(record[k]);
  }
  return Object.freeze(out);
}

// Distinct configured endpoints are not proof of independent organizations. This uses the repository's shared URL
// identity rule to prevent counting one public host's paths or ports as several votes. A single local fixture node is
// allowed only with explicit loopback permission AND an actual loopback transport URL.
//
// The host's LOCAL VERIFIER (a client network/chain-authority.mjs built for the operator's explicit
// ENCLAVE_CHAIN_AUTHORITY=verifier; marked in-process, never from configuration) is ONE proof-checking authority, not a
// vote: it is used alone (required 1, whatever quorum a provider configuration names), and never mixed with provider
// peers or repeated to make up a quorum. Its answers are proven against its sequencer-signed head chain (the unsafe tier).
const LOCAL_VERIFIER = Symbol.for("enclave.chain-authority.local-verifier");
export function leaseRpcSet(clients, { quorum, allowLoopbackHttp = false, timeoutMs = 15_000 } = {}) {
  if (!Array.isArray(clients) || !clients.length || clients.length > 16)
    throw new Error("lease-gas requires 1..16 explicit RPC clients");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error("lease-gas RPC timeout must be 1..60000 ms");
  let peers, required, localFixture = false, authority = "rpc-quorum";
  if (clients.some((c) => c && c[LOCAL_VERIFIER])) {
    if (clients.length !== 1) throw new Error("lease-gas: the local verifier is one authority, never a quorum member (not mixed with RPCs, not repeated)");
    peers = [{ client: clients[0], endpoint: { label: "local verifier", identity: "local-verifier", loopback: true } }];
    required = 1; authority = "local-verifier";
  } else {
    peers = clients.map((client) => {
      const endpoint = rpcEndpoint(client?.transport?.url);
      if (endpoint.url.protocol === "http:" && !allowLoopbackHttp)
        throw new Error("lease-gas plain HTTP RPC needs explicit loopback permission");
      return { client, endpoint };
    });
    if (new Set(peers.map((p) => p.endpoint.identity)).size !== peers.length)
      throw new Error("lease-gas RPCs repeat a provider");
    localFixture = peers.length === 1 && peers[0].endpoint.loopback && allowLoopbackHttp;
    required = quorum ?? Math.floor(peers.length / 2) + 1;
    if (!Number.isInteger(required) || required > peers.length || required <= peers.length / 2 || (required < 2 && !localFixture))
      throw new Error("lease-gas RPC quorum must be a strict majority of at least two peers");
  }
  async function request(client, method, params) {
    let timer;
    try {
      return await Promise.race([
        client.request({ method, params }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("lease-gas RPC timeout")), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function agree(members, read, what) {
    const results = await Promise.allSettled(members.map(async (member) => {
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => read(member)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("lease-gas read timeout")), timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    }));
    const groups = new Map();
    for (let i = 0; i < results.length; i++) {
      if (results[i].status !== "fulfilled") continue;
      const value = results[i].value, key = keyOf(value);
      if (!groups.has(key)) groups.set(key, { value, members: [] });
      groups.get(key).members.push(members[i]);
    }
    const winner = [...groups.values()].find((g) => g.members.length >= required);
    if (!winner) throw new Error(`lease-gas RPC quorum did not agree on ${what}`);
    return winner;
  }
  return { peers, required, localFixture, authority, request, agree };
}

/** A fresh, hash-bound read client, backed ONLY by peers that verified the pinned deployment at that same hash. */
export async function verifiedLeaseAuthority({ clients, deployment, quorum, allowLoopbackHttp = false,
  confirmations, maxBlockAgeSecs = 120, timeoutMs = 15_000, now = Date.now }) {
  const pins = leaseDeploymentPins(deployment);
  const rpc = leaseRpcSet(clients, { quorum, allowLoopbackHttp, timeoutMs });
  const depth = confirmations ?? (rpc.localFixture ? 0 : 2);
  if (!Number.isInteger(depth) || depth < 0 || depth > 1024) throw new Error("lease-gas invalid confirmation depth");
  if (!Number.isInteger(maxBlockAgeSecs) || maxBlockAgeSecs < 1 || maxBlockAgeSecs > 300)
    throw new Error("lease-gas freshness bound must be 1..300 seconds");
  const heads = await Promise.allSettled(rpc.peers.map(async (p) => {
    if (BigInt(await rpc.request(p.client, "eth_chainId", [])) !== BigInt(pins.chainId))
      throw new Error("wrong chain");
    return { ...p, head: BigInt(await rpc.request(p.client, "eth_blockNumber", [])) };
  }));
  const answering = heads.filter((x) => x.status === "fulfilled").map((x) => x.value);
  if (answering.length < rpc.required) throw new Error("lease-gas RPC quorum cannot read the configured chain");
  const heights = answering.map((p) => p.head).sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  const target = heights[rpc.required - 1] - BigInt(depth);
  if (target < 0n) throw new Error("lease-gas confirmation depth exceeds chain height");
  const agreed = await rpc.agree(answering, async (p) => {
    const b = await rpc.request(p.client, "eth_getBlockByNumber", ["0x" + target.toString(16), false]);
    if (!b || BigInt(b.number) !== target || !HASH.test(b.hash || "")) throw new Error("invalid block");
    return { number: target, hash: lower(b.hash), timestamp: BigInt(b.timestamp), baseFeePerGas: BigInt(b.baseFeePerGas ?? 0) };
  }, "the authority block");
  const block = Object.freeze(agreed.value), at = Object.freeze({ blockHash: block.hash, requireCanonical: true });
  function assertFresh() {
    const seconds = BigInt(Math.floor(now() / 1000));
    if (block.timestamp > seconds + 30n || seconds - block.timestamp > BigInt(maxBlockAgeSecs))
      throw new Error("lease-gas authority block is stale or ahead of the local clock");
  }
  assertFresh();
  const rawCall = (p, args) => rpc.request(p.client, "eth_call", [
    { to: args.address, data: encodeFunctionData({ abi: args.abi, functionName: args.functionName, args: args.args ?? [] }) }, at,
  ]).then((data) => decodeFunctionResult({ abi: args.abi, functionName: args.functionName, data }));
  const authorized = await rpc.agree(agreed.members, async (p) => {
    const read = (address, functionName) => rawCall(p, { address, abi: ABI, functionName });
    const [rc, ec, executor, ledger, registry, back, dch] = await Promise.all([
      rpc.request(p.client, "eth_getCode", [pins.reserve, at]), rpc.request(p.client, "eth_getCode", [pins.executor, at]),
      read(pins.reserve, "executor"), read(pins.reserve, "ledger"), read(pins.reserve, "registry"),
      read(pins.executor, "reserve"), read(pins.reserve, "delegationCodeHash"),
    ]);
    if (keccak256(rc) !== pins.reserveCodeHash || keccak256(ec) !== pins.executorCodeHash)
      throw new Error("unreviewed runtime code");
    if (getAddress(executor) !== pins.executor || getAddress(ledger) !== pins.ledger ||
        getAddress(registry) !== pins.registry || getAddress(back) !== pins.reserve ||
        lower(dch) !== keccak256(`0xef0100${pins.executor.slice(2)}`))
      throw new Error("deployment bindings differ from reviewed pins");
    return true;
  }, "the pinned reserve, executor and ledger bindings");
  assertFresh();
  const read = async (fn, what) => {
    assertFresh();
    const result = await rpc.agree(authorized.members, fn, what);
    assertFresh();
    return result.value;
  };
  const client = {
    chain: { id: pins.chainId },
    getBlock: async () => { assertFresh(); return block; },
    readContract: (args) => read((p) => rawCall(p, args), args.functionName),
    getCode: ({ address }) => read((p) => rpc.request(p.client, "eth_getCode", [address, at]), "account code"),
    getTransactionCount: ({ address }) => read(async (p) => {
      const n = BigInt(await rpc.request(p.client, "eth_getTransactionCount", [address, at]));
      if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid account nonce");
      return Number(n);
    }, "account nonce"),
  };
  return { pins, block, client, assertFresh, agreeing: authorized.members.length, quorum: rpc.required };
}
