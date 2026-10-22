// An in-memory Base model for the IPNS Publisher release tests: the catalog, ledger, address book and L1 oracle calls the
// handoff makes, eth_simulateV1 over a state copy, and landed transactions with receipts and event logs. Every call is
// decoded and every result/event encoded with the DEPLOYED ABIs. Behaviour follows the contract sources: publishVersion
// rewrites name/description, appends a version, emits VersionPublished (+ VersionApprovalSet when the sender is the catalog
// owner); setAppRef/setConfig are owner-only and emit AppRefSet/ConfigSet. Code hashes are fixtures. (The same shape as the
// reviewed site-activation model, site-host-live-publish/handoff/test/site-model.mjs, for these calls.)
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, keccak256, encodePacked, parseAbi, toHex, decodeFunctionResult, encodeFunctionData } from "../../../enclave/node_modules/viem/_esm/index.js";
import { CATALOG_ABI, LEDGER_ABI } from "../trust.mjs";

const ZERO = "0x0000000000000000000000000000000000000000", Z32 = "0x" + "00".repeat(32);
const lc = (a) => String(a).toLowerCase();
const BOOK_ABI = parseAbi(["function owner() view returns (address)", "function all() view returns (bytes32[], address[])"]);
const ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
export const CODE = { catalog: "0x6000", ledger: "0x6001" };
export const FIXTURE_HASHES = Object.fromEntries(Object.entries(CODE).map(([k, v]) => [k, keccak256(v)]));
const key32 = (s) => "0x" + Buffer.from(s).toString("hex").padEnd(64, "0");

export function createModel({ t, plan }) {
  const A = lc(t.admin);
  const ver = (i, over = {}) => ({ cid: `bafy-old-${i}`, version: `1.0.${i}`, vramMb: 0, gpuGflops: 0, memMb: 128, cpuGflops: 1, createdAt: 1n, verified: false, yanked: i === 4, ports: "http:8000", approval: 1, config: t.publish.config, ...over });
  const s = { head: 5000n, nonce: 1141, pendingExtra: 0, balance: 10n ** 16n, adminCode: "0x", codes: { [lc(t.catalog)]: CODE.catalog, [lc(t.ledger)]: CODE.ledger },
    bookOwner: A, catalogOwner: A, book: { appCatalog: t.catalog, deployments: t.ledger },
    app: { appId: plan.appId, publisher: A, slug: t.app.slug, name: t.app.name, description: t.app.description, versionCount: 6, createdAt: 1n, updatedAt: 1n, active: true },
    versions: [0, 1, 2, 3, 4].map((i) => ver(i)).concat([ver(5, { cid: t.prev.cid, version: t.prev.version })]),
    dep: { id: t.deployment.id, owner: A, appRef: plan.appRefPrev, ports: "http:8000", configCid: t.deployment.envelopeCurrent, gpuMilli: 0, cpuMilli: 50, appPort: 8000, isPublic: true, active: true,
      createdAt: 7n, rate: 0n, balance6: 0n, spent6: 0n, runner: "0x" + "2f".repeat(32), runnerOperator: "0x" + "1a".repeat(20), leaseUntil: 99999n },
    txs: {}, receipts: {}, tip: 1_000_000n, baseFee: 5_000_000n, salt: "a" };
  const out = (abi, functionName, result, gasUsed = 30000n) => ({ returnData: encodeFunctionResult({ abi, functionName, result }), logs: [], gasUsed });
  const ev = (abi, address, eventName, args) => { const e = abi.find((x) => x.type === "event" && x.name === eventName), non = e.inputs.filter((i) => !i.indexed);
    return { address, topics: encodeEventTopics({ abi, eventName, args }), data: encodeAbiParameters(non, non.map((i) => args[i.name])) }; };

  /** Execute one call against state `st` -> { returnData, logs, gasUsed } or throws (revert). */
  function exec(st, from, to, data) {
    to = lc(to); from = lc(from);
    if (to === lc(t.book)) { const f = decodeFunctionData({ abi: BOOK_ABI, data }).functionName;
      return f === "owner" ? out(BOOK_ABI, "owner", st.bookOwner) : out(BOOK_ABI, "all", [Object.keys(st.book).map(key32), Object.values(st.book)]); }
    if (to === lc(t.oracle)) return out(ORACLE_ABI, "getL1Fee", 1000n);
    if (to === lc(t.catalog)) {
      const { functionName: f, args } = decodeFunctionData({ abi: CATALOG_ABI, data });
      if (f === "owner") return out(CATALOG_ABI, f, st.catalogOwner);
      if (f === "catalogSchema") return out(CATALOG_ABI, f, 9n);
      if (f === "appIdOf") return out(CATALOG_ABI, f, keccak256(encodePacked(["address", "string"], [args[0], args[1]])));
      if (f === "getApp") { if (lc(args[0]) !== lc(st.app.appId)) throw Error("no app"); return out(CATALOG_ABI, f, { ...st.app, versionCount: st.versions.length }); }
      if (f === "numVersions") return out(CATALOG_ABI, f, lc(args[0]) === lc(st.app.appId) ? BigInt(st.versions.length) : 0n);
      if (f === "getVersion") { const v = st.versions[Number(args[1])]; if (!v || lc(args[0]) !== lc(st.app.appId)) throw Error("index"); return out(CATALOG_ABI, f, v); }
      if (f === "publishVersion") {
        const [slug, name, description, version, cid, res, ports, config, fee] = args;
        const appId = keccak256(encodePacked(["address", "string"], [from, slug]));
        if (lc(appId) !== lc(st.app.appId) || lc(st.app.publisher) !== from) throw Error("not publisher");
        if (st.versions.some((v) => v.version === version)) throw Error("version exists");
        if (fee !== 0n) throw Error("modelled fee 0 only");
        st.app.name = name; st.app.description = description;
        const approval = from === lc(st.catalogOwner) ? 1 : 0;
        st.versions.push({ cid, version, vramMb: res[0], gpuGflops: res[1], memMb: res[2], cpuGflops: res[3], createdAt: st.head, verified: false, yanked: false, ports, approval, config });
        const index = BigInt(st.versions.length - 1);
        const logs = [ev(CATALOG_ABI, t.catalog, "VersionPublished", { appId, index, version, cid })];
        if (approval) logs.push(ev(CATALOG_ABI, t.catalog, "VersionApprovalSet", { appId, index, status: 1 }));
        return { returnData: encodeFunctionResult({ abi: CATALOG_ABI, functionName: f, result: [appId, index] }), logs, gasUsed: 759003n };
      }
      throw Error("unmodelled catalog call " + f);
    }
    if (to === lc(t.ledger)) {
      const { functionName: f, args } = decodeFunctionData({ abi: LEDGER_ABI, data });
      if (f === "deploymentsSchema") return out(LEDGER_ABI, f, 16n);
      if (f === "get") return out(LEDGER_ABI, f, lc(args[0]) === lc(st.dep.id) ? st.dep : { ...st.dep, id: args[0], owner: ZERO, appRef: "", configCid: "" });
      if (lc(args[0]) !== lc(st.dep.id) || lc(st.dep.owner) !== from) throw Error("not owner");
      if (f === "setAppRef") { st.dep.appRef = args[1]; return { returnData: "0x", logs: [ev(LEDGER_ABI, t.ledger, "AppRefSet", { id: args[0], appRef: args[1] })], gasUsed: 43615n }; }
      if (f === "setConfig") { st.dep.configCid = args[1]; return { returnData: "0x", logs: [ev(LEDGER_ABI, t.ledger, "ConfigSet", { id: args[0], configCid: args[1] })], gasUsed: 107075n }; }
      throw Error("unmodelled ledger call " + f);
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
    if (lc(sent.from) !== A) throw Error("model wallet signs only for the owner");
    if (nonce !== s.nonce) throw Error(`nonce ${nonce} is not the account nonce ${s.nonce}`);
    s.head += 1n; const blockNumber = s.head;
    const hash = keccak256(toHex(`tx:${s.nonce}:${sent.to}:${sent.data}:${blockNumber}:${sent.gas}`));
    let status = "success", logs = [], gasUsed = 21000n;
    const snapshot = clone();
    try { const r = exec(s, sent.from, sent.to, sent.data); logs = r.logs; gasUsed = r.gasUsed; }
    catch { Object.assign(s, { ...snapshot, txs: s.txs, receipts: s.receipts, head: s.head }); status = "reverted"; }
    s.nonce += 1;
    s.txs[hash] = { hash, from: lc(sent.from), to: lc(sent.to), chainId: Number(BigInt(sent.chainId)), type: "eip1559", nonce, input: sent.data, value: BigInt(sent.value),
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
          const r = readAt(address, encodeFunctionData({ abi, functionName, args }));
          return tw("readContract", [address, functionName, args], decodeFunctionResult({ abi, functionName, data: r.returnData }));
        },
        request: async ({ method, params }) => {
          if (method !== "eth_simulateV1") throw Error("unmodelled " + method);
          const st = clone(), calls = params[0].blockStateCalls[0].calls;
          const res = calls.map((c) => { try { const r = exec(st, c.from, c.to, c.data); return { status: "0x1", returnData: r.returnData, gasUsed: toHex(r.gasUsed), logs: r.logs }; }
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
