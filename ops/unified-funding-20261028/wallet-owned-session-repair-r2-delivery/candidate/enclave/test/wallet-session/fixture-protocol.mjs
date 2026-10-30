// wallet-owned-session-repair-r2: AUTHORED, NOT RUN. An INERT synthetic protocol for the resolver's authenticated
// discovery. The "code" here is NOT product bytecode and runs nothing: each template is a marker prefix + the immutable
// words (+ link) + a suffix, and the fixture manifest marks exactly those ranges - the same SHAPE
// tools/build-wallet-session-manifest.mjs derives from solc immutableReferences/linkReferences. Real qualification needs
// the root-generated manifest from compiled artifacts. Addresses are derived like the chain derives them (CREATE /
// CREATE2), so the resolver's derivation checks have something real to check.
import { keccak256, getAddress, getContractAddress, pad, concat, toHex } from "viem";
import "../../relay/sessions.mjs";   // injects viem into the shared policy module, as every production importer does
import { TOPICS } from "../../relay/wallet-session-policy.mjs";

const A = (n) => getAddress("0x" + n.toString(16).padStart(40, "0"));
const w = (hex) => pad(hex, { size: 32 }).slice(2).toLowerCase();
const zeros = (n) => "00".repeat(n);
const t = (hex) => "0x" + w(hex);

export function fixtureProtocol({ factory, ledger, catalog = A(0xca7), usdc = A(0x05dc), router = A(0x707), ka = A(0xa77),
  library = A(0x11b), maxVault6 = 10n ** 12n, chainId = 8453 }) {
  const profile = getContractAddress({ from: factory, nonce: 1n });
  const implementation = getContractAddress({ from: factory, nonce: 2n });
  const lib = library.slice(2).toLowerCase();
  const code = {
    factory: "0x6000" + w(implementation) + w(ledger) + w(profile) + "00",
    vault: "0x6100" + w(usdc) + w(profile) + w(router) + w(factory) + w(ka) + w(toHex(maxVault6)) + w(ledger) + lib + "00",
    profile: "0x6200" + w(ledger) + w(catalog) + "00",
    library: "0x73" + lib + "3014" + "00",
  };
  const masked = {
    factory: "0x6000" + zeros(96) + "00",
    vault: "0x6100" + zeros(7 * 32) + zeros(20) + "00",
    profile: "0x6200" + zeros(64) + "00",
    library: "0x73" + zeros(20) + "3014" + "00",
  };
  const r = (s) => [[s, 32]];
  const manifest = {
    format: "enclave.wallet-session.manifest/1",
    protocol: keccak256(new TextEncoder().encode("enclave.wallet-session.v1")).toLowerCase(),
    artifacts: {
      factory: { codeLength: 99, maskedHash: keccak256(masked.factory), immutables: { implementation: r(2), ledger: r(34), profile: r(66) }, links: {} },
      vault: { codeLength: 247, maskedHash: keccak256(masked.vault), links: { SessionVaultLib: [[226, 20]] },
        immutables: { usdc: r(2), book: r(34), router: r(66), factory: r(98), keyAttestations: r(130), maxVault6: r(162), ledger: r(194) } },
      profile: { codeLength: 67, maskedHash: keccak256(masked.profile), immutables: { deployments: r(2), appCatalog: r(34) }, links: {} },
      library: { codeLength: 24, maskedHash: keccak256(masked.library), immutables: {}, links: {}, self: [[1, 20]] },
    },
  };
  const clone = (impl) => "0x363d3d373d3d3d363d73" + impl.slice(2).toLowerCase() + "5af43d82803e903d91602b57fd5bf3";
  const cloneInit = (impl) => concat(["0x3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, "0x5af43d82803e903d91602b57fd5bf3"]);
  const vaultFor = (owner) => getContractAddress({ opcode: "CREATE2", from: factory, salt: pad(owner, { size: 32 }), bytecode: cloneInit(implementation) });
  const codes = new Map([[factory, code.factory], [implementation, code.vault], [profile, code.profile], [library, code.library]]);
  const extraCode = new Map();   // tests add vault clones / foreign contracts here
  const codeAt = (a) => extraCode.get(getAddress(a)) ?? codes.get(getAddress(a)) ?? "0x";

  /** chain history: blocks, logs, receipts. Births are appended as the ledger would emit them. */
  const hist = { head: 100n, blocks: new Map(), logs: [], receipts: new Map() };
  for (let n = 0n; n <= 200n; n++) hist.blocks.set(n, keccak256(toHex(`block-${n}`)));
  let txn = 0;
  const tx = (logs, from, block) => {
    const hash = keccak256(toHex(`tx-${++txn}`)), blockHash = hist.blocks.get(block);
    const full = logs.map((l, i) => ({ address: l[0], topics: l[1], data: "0x", blockNumber: block, blockHash, transactionHash: hash, logIndex: i, removed: false }));
    hist.logs.push(...full);
    hist.receipts.set(hash, { status: "success", blockHash, blockNumber: block, from, logs: full });
    return hash;
  };
  const births = {
    /** a vault's deploy.create: Created(owner=vault), RunnerRateSet, transfer vault->owner, factory Bound, vault Bound */
    vault(id, vault, owner, block = 10n, relayer = A(0x4e1a)) {
      extraCode.set(getAddress(vault), clone(implementation));
      return tx([[ledger, [TOPICS.created, id, t(vault)]], [ledger, [TOPICS.runnerRateSet, id]],
        [ledger, [TOPICS.transferred, id, t(vault), t(owner)]], [factory, [TOPICS.factoryBound, id, t(vault), t(owner)]],
        [vault, [TOPICS.vaultBound, id, "0x" + "33".repeat(32), t(owner)]]], relayer, block);
    },
    /** a plain wallet's own ledger.create */
    eoa(id, eoa, block = 11n, from = eoa) { return tx([[ledger, [TOPICS.created, id, t(eoa)]], [ledger, [TOPICS.runnerRateSet, id]]], from, block); },
    /** importDeployments: Created(owner = the IMPORTED holder), no RunnerRateSet */
    imported(id, owner, block = 12n, admin = A(0xad11)) { return tx([[ledger, [TOPICS.created, id, t(owner)]]], admin, block); },
    /** any later ledger transfer */
    transfer(id, from, to, block) { return tx([[ledger, [TOPICS.transferred, id, t(from), t(to)]]], from, block); },
    /** an owner policy decision on the vault */
    policyChanged(vault, id, block) { return tx([[vault, [TOPICS.policyChanged, id]]], A(0x0e1), block); },
    /** any contract emitting a Bound(id)-shaped log (forgery or a real vault elsewhere) */
    bound(emitter, id, owner, block) { return tx([[emitter, [TOPICS.vaultBound, id, "0x" + "44".repeat(32), t(owner)]]], A(0xbad), block); },
  };

  /** install the provenance reads on an inert client `pc` (its `st.fail` makes every read throw "rpc down") */
  function install(pc) {
    const st = pc.st || {};
    pc.getBlock = async ({ blockTag, blockNumber } = {}) => {
      if (st.fail) throw new Error("rpc down");
      const n = blockTag === "latest" || blockNumber === undefined ? hist.head : BigInt(blockNumber);
      return { number: n, hash: hist.blocks.get(n) };
    };
    pc.getLogs = async ({ address, event, args, fromBlock = 0n, toBlock }) => {
      if (st.fail) throw new Error("rpc down");
      const topic0 = keccak256(new TextEncoder().encode(`${event.name}(${event.inputs.map((i) => i.type).join(",")})`)).toLowerCase();
      return hist.logs.filter((l) => l.topics[0] === topic0 && (!address || getAddress(l.address) === getAddress(address))
        && (!args?.id || l.topics[1] === String(args.id).toLowerCase()) && l.blockNumber >= BigInt(fromBlock)
        && l.blockNumber <= BigInt(toBlock ?? hist.head) && hist.blocks.get(l.blockNumber) === l.blockHash).map((l) => ({ ...l }));
    };
    pc.getTransactionReceipt = async ({ hash }) => {
      if (st.fail) throw new Error("rpc down");
      const r = hist.receipts.get(hash);
      if (!r) throw new Error("fixture: no receipt");
      return { ...r, logs: r.logs.map((l) => ({ ...l })) };
    };
    return pc;
  }
  return { manifest, codes: code, implementation, profile, library, ledger, factory, vaultFor, codeAt, extraCode, clone, hist, births, install, chainId };
}
