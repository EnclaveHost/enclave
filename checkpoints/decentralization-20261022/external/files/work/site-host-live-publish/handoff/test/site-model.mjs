// An in-memory Base model for the site-activation tests: the catalog, ledger, registry, address book, lease-gas reserve,
// executor and L1 oracle calls the handoff (and the reviewed stage-B queue) make, eth_simulateV1 over a state copy, and
// landed transactions with receipts and event logs. Every call is decoded and every result/event encoded with the
// DEPLOYED ABIs (contracts/*.abi.json and the verified reserve artifact). Behaviour follows the contract sources:
// publish emits AppCreated/VersionPublished/VersionApprovalSet (owner => Approved); create derives
// id = keccak256(abi.encodePacked(sender, nonce++)) and emits MaxRateSet/Created/RunnerRateSet. Code hashes are fixtures.
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, keccak256, encodePacked, parseAbi, toHex } from "../../../enclave/node_modules/viem/_esm/index.js";
import { CATALOG_ABI, LEDGER_ABI } from "../site-trust.mjs";
import { budgetKey, VAULT_ABI } from "../../../lease-enrollment-signing/plan.mjs";

const ZERO = "0x0000000000000000000000000000000000000000", Z32 = "0x" + "00".repeat(32);
const lc = (a) => String(a).toLowerCase();
const BOOK_ABI = parseAbi(["function owner() view returns (address)", "function all() view returns (bytes32[], address[])"]);
const ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
const REGISTRY_ABI = parseAbi(["function get(bytes32 id) view returns ((string endpoint, string repo, bytes32 measurement, address operator, uint64 registeredAt, uint64 lastSeen, bool active, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey, address payoutWallet))"]);
const EXECUTOR_ABI = parseAbi(["function reserve() view returns (address)"]);
const FACTORY_ABI = parseAbi(["function isVault(address) view returns (bool)"]);
export const CODE = { catalog: "0x6000", ledger: "0x6001", registry: "0x6002", reserve: "0x6003", executor: "0x6004", factory: "0x6005", vault: "0x6006", book: "0x6007", oracle: "0x6008" };
export const FIXTURE_HASHES = Object.fromEntries(Object.entries(CODE).map(([k, v]) => [k, keccak256(v)]));
const key32 = (s) => "0x" + Buffer.from(s).toString("hex").padEnd(64, "0");

export function createModel({ t, reserveAbi, base }) {
  const A = lc(t.admin);
  const s = { head: 5000n, nonce: 40, pendingExtra: 0, balance: 10n ** 16n, adminCode: "0x", codes: {}, apps: {}, versions: {}, ledgerNonce: {}, deps: {}, res: {}, claim: {},
    registry: { [lc(t.minipc.hostId)]: { operator: t.minipc.operator, active: true, payoutWallet: t.admin } }, bookOwner: A, catalogOwner: A,
    book: { appCatalog: t.catalog, deployments: t.ledger }, reserveOwner: A, paused: false, executor: lc(t.executor), dch: base.delegationCodeHash,
    txs: {}, receipts: {}, tip: 1_000_000n, baseFee: 5_000_000n, salt: "a" };
  for (const [k, a] of [["catalog", t.catalog], ["ledger", t.ledger], ["registry", t.registry], ["reserve", t.reserve], ["executor", t.executor], ["book", t.book], ["oracle", t.oracle],
    ["factory", base.vaultFactory], ["vault", base.dnsVault]]) s.codes[lc(a)] = CODE[k];
  const out = (abi, functionName, result) => ({ returnData: encodeFunctionResult({ abi, functionName, result }), logs: [], gasUsed: 30000n });
  const ev = (abi, address, eventName, args) => { const e = abi.find((x) => x.type === "event" && x.name === eventName), non = e.inputs.filter((i) => !i.indexed);
    return { address, topics: encodeEventTopics({ abi, eventName, args }), data: encodeAbiParameters(non, non.map((i) => args[i.name])) }; };
  const reserveOut = reserveAbi.find((x) => x.name === "reserveOf").outputs[0].components;
  const zeroOf = (ty) => (ty === "bool" ? false : ty === "address" ? ZERO : ty.startsWith("bytes") ? Z32 : ty === "string" ? "" : 0n);
  const reserveOf = (st, id, o) => (st.res[budgetKey(id, o)] ??= Object.fromEntries(reserveOut.map((c) => [c.name, zeroOf(c.type)])));
  const emptyDep = (id) => ({ id, owner: ZERO, appRef: "", ports: "", configCid: "", gpuMilli: 0, cpuMilli: 0, appPort: 0, isPublic: false, active: false, createdAt: 0n, rate: 0n, balance6: 0n, spent6: 0n, runner: Z32, runnerOperator: ZERO, leaseUntil: 0n });

  /** Execute one call against state `st` -> { returnData, logs, gasUsed } or throws (revert). */
  function exec(st, from, to, data, value = 0n) {
    to = lc(to); from = lc(from); value = BigInt(value);
    if (to === lc(t.book)) { const f = decodeFunctionData({ abi: BOOK_ABI, data }).functionName;
      return f === "owner" ? out(BOOK_ABI, "owner", st.bookOwner) : out(BOOK_ABI, "all", [Object.keys(st.book).map(key32), Object.values(st.book)]); }
    if (to === lc(t.oracle)) return out(ORACLE_ABI, "getL1Fee", 1000n);
    if (to === lc(t.executor)) return out(EXECUTOR_ABI, "reserve", t.reserve);
    if (to === lc(t.registry)) { const [id] = decodeFunctionData({ abi: REGISTRY_ABI, data }).args; const e = st.registry[lc(id)] || { operator: ZERO, active: false, payoutWallet: ZERO };
      return out(REGISTRY_ABI, "get", { endpoint: "tunnel://minipc", repo: "", measurement: Z32, operator: e.operator, registeredAt: 1n, lastSeen: 1n, active: e.active, cpuPricePerSec6: 47n, gpuPricePerSec6: 12n, proofKey: "0x" + "ee".repeat(20), payoutWallet: e.payoutWallet }); }
    if (to === lc(base.vaultFactory)) return out(FACTORY_ABI, "isVault", true);
    if (to === lc(base.dnsVault)) { const d = decodeFunctionData({ abi: VAULT_ABI, data }); return d.functionName === "owner" ? out(VAULT_ABI, "owner", A) : out(VAULT_ABI, "factory", base.vaultFactory); }
    if (to === lc(t.catalog)) {
      const { functionName: f, args } = decodeFunctionData({ abi: CATALOG_ABI, data });
      if (f === "owner") return out(CATALOG_ABI, f, st.catalogOwner);
      if (f === "catalogSchema") return out(CATALOG_ABI, f, 9n);
      if (f === "appIdOf") return out(CATALOG_ABI, f, keccak256(encodePacked(["address", "string"], [args[0], args[1]])));
      if (f === "numVersions") return out(CATALOG_ABI, f, BigInt((st.versions[args[0]] || []).length));
      if (f === "getVersion") { const v = (st.versions[args[0]] || [])[Number(args[1])]; if (!v) throw Error("index"); return out(CATALOG_ABI, f, v); }
      if (f === "publishVersion") {
        const [slug, name, , version, cid, res, ports, config, fee] = args;
        if (fee !== 0n) throw Error("fee"); if (res[2] === 0) throw Error("memMb range");
        const appId = keccak256(encodePacked(["address", "string"], [from, slug]));
        const vs = (st.versions[appId] ||= []); if (vs.some((v) => v.version === version)) throw Error("version exists");
        const logs = [];
        if (!st.apps[appId]) { st.apps[appId] = { publisher: from, slug }; logs.push(ev(CATALOG_ABI, t.catalog, "AppCreated", { appId, publisher: from, slug, name })); }
        const approval = from === lc(st.catalogOwner) ? 1 : 0;
        vs.push({ cid, version, vramMb: res[0], gpuGflops: res[1], memMb: res[2], cpuGflops: res[3], createdAt: st.head, verified: false, yanked: false, ports, approval, config });
        logs.push(ev(CATALOG_ABI, t.catalog, "VersionPublished", { appId, index: BigInt(vs.length - 1), version, cid }));
        if (approval) logs.push(ev(CATALOG_ABI, t.catalog, "VersionApprovalSet", { appId, index: BigInt(vs.length - 1), status: 1 }));
        return { returnData: encodeFunctionResult({ abi: CATALOG_ABI, functionName: f, result: [appId, BigInt(vs.length - 1)] }), logs, gasUsed: 613937n };
      }
      throw Error("unmodelled catalog call " + f);
    }
    if (to === lc(t.ledger)) {
      const { functionName: f, args } = decodeFunctionData({ abi: LEDGER_ABI, data });
      if (f === "deploymentsSchema") return out(LEDGER_ABI, f, 16n);
      if (f === "get") return out(LEDGER_ABI, f, st.deps[lc(args[0])] || emptyDep(args[0]));
      if (f === "claimableBy") { const d = st.deps[lc(args[0])]; return out(LEDGER_ABI, f, !!d && d.active && (st.registry[lc(args[1])]?.payoutWallet && lc(st.registry[lc(args[1])].payoutWallet) === lc(d.owner))); }
      if (f === "create") {
        const [appRef, gpuMilli, cpuMilli, appPort, ports, isPublic, configCid, , feePerSec6, maxRate6] = args;
        if (feePerSec6 !== 0n || maxRate6 === 0n) throw Error("modelled create args only");
        let id; do { const n = st.ledgerNonce[from] ?? 0; st.ledgerNonce[from] = n + 1; id = keccak256(encodePacked(["address", "uint64"], [from, BigInt(n)])); } while (st.deps[lc(id)]);
        st.deps[lc(id)] = { ...emptyDep(id), id, owner: from, appRef, ports, configCid, gpuMilli, cpuMilli, appPort, isPublic, active: true, createdAt: st.head, rate: maxRate6 };
        const logs = [ev(LEDGER_ABI, t.ledger, "MaxRateSet", { id, maxRate6 }), ev(LEDGER_ABI, t.ledger, "Created", { id, owner: from, appRef, gpuMilli, cpuMilli, rate: maxRate6 }),
          ev(LEDGER_ABI, t.ledger, "RunnerRateSet", { id, runnerRate6: 0n })];
        return { returnData: encodeFunctionResult({ abi: LEDGER_ABI, functionName: f, result: id }), logs, gasUsed: 393153n };
      }
      throw Error("unmodelled ledger call " + f);
    }
    if (to === lc(t.reserve)) {
      const { functionName: f, args } = decodeFunctionData({ abi: reserveAbi, data });
      const simple = { owner: st.reserveOwner, pendingOwner: ZERO, ledger: t.ledger, registry: t.registry, l1Oracle: t.oracle, executor: st.executor, delegationCodeHash: st.dch, paused: st.paused };
      if (f in simple) return out(reserveAbi, f, simple[f]);
      if (f === "blockedDeployment") return out(reserveAbi, f, false);
      if (f === "reserveOf") return out(reserveAbi, f, reserveOf(st, args[0], lc(args[1])));
      if (f === "claimantAllowed") return out(reserveAbi, f, !!st.claim[args[0] + lc(args[1])]);
      const owner = lc(st.deps[lc(args[0])]?.owner || ZERO);
      if (f === "statusOf") { const r = reserveOf(st, args[0], owner), e = st.registry[lc(args[2])];
        const status = !r.enabled ? 5 : r.balanceWei === 0n ? 18 : Number(r.claimPolicy) === 1 && lc(e?.payoutWallet || ZERO) !== owner ? 11 : 0;
        return out(reserveAbi, f, [status, r.balanceWei, r.epochCapWei, r.maxPerOpWei]); }
      if (f === "deposit") { if (value === 0n) throw Error("amount"); reserveOf(st, args[0], owner).balanceWei += value;
        return { returnData: "0x", logs: [ev(reserveAbi, t.reserve, "Deposited", { id: args[0], owner, from, amountWei: value })], gasUsed: 92363n }; }
      if (from !== owner) throw Error("!owner");
      if (f === "configure") { Object.assign(reserveOf(st, args[0], owner), args[1], { lastClaimAt: 1n });
        return { returnData: "0x", logs: [ev(reserveAbi, t.reserve, "Configured", { id: args[0], owner, policy: args[1] })], gasUsed: 148491n }; }
      throw Error("unmodelled reserve call " + f);
    }
    throw Error("unmodelled call to " + to);
  }
  const clone = () => structuredClone({ ...s, txs: undefined, receipts: undefined });
  const blockHash = (n) => keccak256(toHex(`${s.salt}:${n}`));

  /** The wallet: lands `tx` exactly as given (the caller is "MetaMask"); mines one block, then `extra` more. -> hash */
  function land(tx, { extra = 2, mutate = null } = {}) {
    const sent = { ...tx };
    if (mutate) mutate(sent);
    const nonce = Number(BigInt(sent.nonce));
    if (lc(sent.from) !== A) throw Error("model wallet signs only for the admin");
    if (nonce !== s.nonce) throw Error(`nonce ${nonce} is not the account nonce ${s.nonce}`);
    s.head += 1n; const blockNumber = s.head;
    const hash = keccak256(toHex(`tx:${s.nonce}:${sent.to}:${sent.data}:${blockNumber}`));
    let status = "success", logs = [], gasUsed = 21000n;
    const snapshot = structuredClone({ ...s, txs: undefined, receipts: undefined });
    try { const r = exec(s, sent.from, sent.to, sent.data, sent.value); logs = r.logs; gasUsed = r.gasUsed; }
    catch { Object.assign(s, { ...snapshot, txs: s.txs, receipts: s.receipts, head: s.head }); status = "reverted"; }
    s.nonce += 1;
    s.txs[hash] = { hash, from: lc(sent.from), to: lc(sent.to), chainId: Number(BigInt(sent.chainId)), type: "eip1559", nonce: nonce, input: sent.data, value: BigInt(sent.value),
      gas: BigInt(sent.gas), maxFeePerGas: BigInt(sent.maxFeePerGas), maxPriorityFeePerGas: BigInt(sent.maxPriorityFeePerGas), authorizationList: sent.authorizationList };
    s.receipts[hash] = { transactionHash: hash, from: lc(sent.from), to: lc(sent.to), status, logs: logs.map((l) => ({ ...l, address: lc(l.address) })), blockNumber, blockHash: blockHash(blockNumber), gasUsed };
    s.head += BigInt(extra);
    return hash;
  }
  /** Two RPC clients over the same model; `tweak[i](method, args, result)` may alter what client i reports. */
  function clients(tweak = []) {
    return ["https://a.example", "https://b.example"].map((url, i) => {
      const tw = (m, a, r) => (tweak[i] ? tweak[i](m, a, r) : r);
      const readAt = (to, data, from) => exec(clone(), from || t.admin, to, data);
      return {
        transport: { url },
        getBlockNumber: async () => tw("getBlockNumber", [], s.head),
        getBlock: async ({ blockNumber }) => tw("getBlock", [blockNumber], { number: blockNumber, hash: blockHash(blockNumber), baseFeePerGas: s.baseFee }),
        getChainId: async () => tw("getChainId", [], 8453),
        getCode: async ({ address }) => tw("getCode", [address], lc(address) === A ? s.adminCode : s.codes[lc(address)] ?? "0x"),
        getTransactionCount: async ({ blockTag }) => tw("getTransactionCount", [blockTag], blockTag === "pending" ? s.nonce + s.pendingExtra : s.nonce),
        getBalance: async ({ address }) => tw("getBalance", [address], lc(address) === A ? s.balance : 0n),
        estimateMaxPriorityFeePerGas: async () => s.tip,
        call: async ({ account, to, data }) => ({ data: tw("call", [to, data], readAt(to, data, account?.address || account).returnData) }),
        readContract: async ({ address, abi, functionName, args = [] }) => {
          const { decodeFunctionResult, encodeFunctionData } = await import("../../../enclave/node_modules/viem/_esm/index.js");
          const r = readAt(address, encodeFunctionData({ abi, functionName, args }));
          return tw("readContract", [address, functionName, args], decodeFunctionResult({ abi, functionName, data: r.returnData }));
        },
        request: async ({ method, params }) => {
          if (method !== "eth_simulateV1") throw Error("unmodelled " + method);
          const st = clone(), calls = params[0].blockStateCalls[0].calls;
          const res = calls.map((c) => { try { const r = exec(st, c.from, c.to, c.data, c.value ?? 0n); return { status: "0x1", returnData: r.returnData, gasUsed: toHex(r.gasUsed), logs: r.logs }; }
            catch (e) { return { status: "0x0", returnData: "0x", gasUsed: "0x0", error: { message: e.message } }; } });
          return tw("eth_simulateV1", params, [{ calls: res }]);
        },
        getTransaction: async ({ hash }) => { const x = s.txs[lc(hash)]; if (!x) throw Error("not found"); return tw("getTransaction", [hash], structuredClone(x)); },
        getTransactionReceipt: async ({ hash }) => { const x = s.receipts[lc(hash)]; if (!x) throw Error("not found"); return tw("getTransactionReceipt", [hash], structuredClone(x)); },
      };
    });
  }
  return { state: s, exec, land, clients, mine: (n = 1) => { s.head += BigInt(n); } };
}
