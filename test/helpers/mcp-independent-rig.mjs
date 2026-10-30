// The ORIGINAL platform on a local Base stand-in, for the independent MCP tests: anvil (chain id 8453) with
//   - the live rev-16d ledger (test/fixtures/ledger-rev16d-source, the source pinned for the deployed ledger) and its
//     bandwidth library, from the reproducible lease-gas Foundry build (test/helpers/lease-gas-forge.mjs);
//   - the deployed schema-4 registry, compiled from its exact historical source (cli-independent-rig compileRegistrySchema4);
//   - the admin-owned EnclaveAddressBook, the catalog, PaymentRouter and EnclaveReviews (contracts/, main's Foundry build);
//   - the PRODUCTION SessionVaultFactory (contracts/SessionVault.sol, legacy-sessions-v2): its implementation resolves the
//     ledger and catalog through that address book, exactly as production vaults do;
// three scriptable JSON-RPC proxies (ok | down | lie | wrongchain), a stand-in Enclave API that records every hit, and the
// management plane and storage adapters of test/helpers/cli-independent-rig.mjs (real directory, operator-signed record,
// gateway with the session verifier; HTTPS adapters that verify the wallet upload signature).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeDeployData, getAddress, http as viemHttp, keccak256, parseUnits, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { linkBytecode } from "../../site/js/lib/contract-linker.js";
import { compileRegistrySchema4, KEYS, chain, freePort } from "./cli-independent-rig.mjs";
import { art as leaseArt } from "./lease-gas-world.mjs";
import { artifactIdentity } from "../../sdk/storage/unixfs.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(REPO, "contracts", "foundry", "out");
const mainArt = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const leased = (file, name) => { const a = leaseArt(file, name); return { abi: a.abi, bytecode: a.bytecode, linkReferences: a.links }; };
const body = (req) => new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c).toString())); });
export const PUBLISHER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";   // anvil account 1: a third-party publisher

export async function startOriginalRig() {
  const stops = [];
  const stop = async () => { while (stops.length) { const f = stops.pop(); try { await Promise.race([Promise.resolve().then(f), new Promise((ok) => setTimeout(ok, 3000).unref())]); } catch {} } };
  const closeServer = (srv) => () => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); });
  try {
    const anvilPort = await freePort();
    const anvil = spawn("anvil", ["--port", String(anvilPort), "--chain-id", "8453", "--hardfork", "osaka", "--silent", "--base-fee", "0", "--gas-price", "0"], { stdio: "ignore" });
    const killAnvil = () => { try { anvil.kill("SIGKILL"); } catch {} };
    process.once("exit", killAnvil);
    stops.push(() => { process.removeListener("exit", killAnvil); killAnvil(); });
    const rpc = `http://127.0.0.1:${anvilPort}`;
    const pc = createPublicClient({ chain, transport: viemHttp(rpc) });
    for (let i = 0; i < 100; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const wc = (key) => createWalletClient({ chain, account: privateKeyToAccount(key), transport: viemHttp(rpc) });
    const dep = wc(KEYS.deployer);
    const deploy = async (a, args = [], libs = {}) => {
      const bytecode = Object.keys(a.linkReferences).length ? linkBytecode(a.bytecode, a.linkReferences, libs) : a.bytecode;
      const rc = await pc.waitForTransactionReceipt({ hash: await dep.sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode, args }) }) });
      if (rc.status !== "success") throw new Error("deploy failed");
      return getAddress(rc.contractAddress);
    };
    const write = async (who, address, abi, functionName, args) => {
      const rc = await pc.waitForTransactionReceipt({ hash: await who.writeContract({ address, abi, functionName, args }) });
      if (rc.status !== "success") throw new Error(functionName + " reverted");
      return rc;
    };
    const A = { usdc: mainArt("SessionMocks.sol", "MockUSDC3009"), registry4: compileRegistrySchema4(), feed: leased("MockFeed.sol", "MockFeed"),
      bandwidth: leased("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"), ledger: leased("EnclaveDeployments.sol", "EnclaveDeployments"),
      catalog: mainArt("EnclaveAppCatalog.sol", "EnclaveAppCatalog"), router: mainArt("PaymentRouter.sol", "PaymentRouter"),
      book: mainArt("EnclaveAddressBook.sol", "EnclaveAddressBook"), reviews: mainArt("EnclaveReviews.sol", "EnclaveReviews"),
      svlib: leased("SessionVault.sol", "SessionVaultLib"), factory: leased("SessionVault.sol", "SessionVaultFactory"), vault: leased("SessionVault.sol", "SessionVault") };
    const treasury = "0x00000000000000000000000000000000000e2e01";
    const usdc = await deploy(A.usdc), feed = await deploy(A.feed), registry = await deploy(A.registry4), bw = await deploy(A.bandwidth);
    const ledger = await deploy(A.ledger, [usdc, treasury, registry, feed], { [`${Object.keys(A.ledger.linkReferences)[0]}:EnclaveLedgerBandwidth`]: bw });
    await write(dep, ledger, A.ledger.abi, "setProofRequiredFrom", [0n]);
    const catalog = await deploy(A.catalog), router = await deploy(A.router, [usdc, treasury]), book = await deploy(A.book);
    const reviews = await deploy(A.reviews, [book, ledger]);
    const key = (s) => toHex(s, { size: 32 });
    for (const [k, v] of [["deployments", ledger], ["appCatalog", catalog], ["reviews", reviews]]) await write(dep, book, A.book.abi, "set", [key(k), v]);
    const svlib = await deploy(A.svlib);
    const factory = await deploy(A.factory, [usdc, book, router, "0x0000000000000000000000000000000000000000", parseUnits("1000", 6)],
      { [`${Object.keys(A.factory.linkReferences)[0]}:SessionVaultLib`]: svlib });
    await write(dep, book, A.book.abi, "set", [key("sessionVaultFactory"), factory]);
    const owner = privateKeyToAccount(KEYS.owner).address, other = privateKeyToAccount(KEYS.other).address, operator = privateKeyToAccount(KEYS.operator).address;
    for (const who of [owner, other]) await write(dep, usdc, A.usdc.abi, "mint", [who, parseUnits("100", 6)]);
    // an independent host on the schema-4 registry: $0.001/s per whole node
    const endpoint = "https://host.independent.test";
    await write(wc(KEYS.operator), registry, A.registry4.abi, "register", [endpoint, "independent/host", "0x" + "00".repeat(32), 1000n, 0n, "0x0000000000000000000000000000000000000000"]);
    const runner = keccak256(toBytes(endpoint));
    // the catalog: the owner's app (approved on publish), a third party's pending and rejected releases
    const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
    for (const v of ["1", "2"]) await write(dep, catalog, A.catalog.abi, "publishVersion", ["hello", "Hello", "a test app", v, CID, [0, 0, 64, 1], "http:8080", "{}", 0n]);
    const appId = await pc.readContract({ address: catalog, abi: A.catalog.abi, functionName: "appIdOf", args: [privateKeyToAccount(KEYS.deployer).address, "hello"] });
    const pub = wc(PUBLISHER);
    const CID3 = artifactIdentity(new Uint8Array(Buffer.from("a third-party component"))).cid;   // a CID belongs to one app
    for (const v of ["1", "2"]) await write(pub, catalog, A.catalog.abi, "publishVersion", ["thirdparty", "Third party", "pending and rejected", v, CID3, [0, 0, 64, 1], "http:8080", "{}", 0n]);
    const thirdId = await pc.readContract({ address: catalog, abi: A.catalog.abi, functionName: "appIdOf", args: [pub.account.address, "thirdparty"] });
    await write(dep, catalog, A.catalog.abi, "setApproval", [thirdId, 1n, 2]);   // v2 rejected by the catalog owner; v1 stays pending
    const appRef = `catalog://${appId}/0`;
    const create = (who, { maxRate = 100000n, isPublic = true } = {}) => write(wc(who), ledger, A.ledger.abi, "create",
      [appRef, 0, 100, 8080, "http:8080", isPublic, "", "0x0000000000000000000000000000000000000000", 0n, maxRate]);
    const CREATED = "0x3b201eb11e77934b296f908775fc0a82679683fd83a1232579f1014bcf7d3239";
    const createdId = (rc) => rc.logs.find((l) => l.address.toLowerCase() === ledger.toLowerCase() && l.topics[0] === CREATED).topics[1];

    // three JSON-RPC origins in front of the chain
    const rpcModes = {}, rpcLog = [], rpcs = [];
    for (const i of [0, 1, 2]) {
      const srv = http.createServer(async (req, res) => {
        const mode = rpcModes[i] || "ok";
        if (mode === "down") { res.writeHead(503); return res.end(); }
        const raw = await body(req);
        let q; try { q = JSON.parse(raw); } catch { res.writeHead(400); return res.end(); }
        for (const m of [q].flat()) rpcLog.push({ i, method: m.method, to: m.params?.[0]?.to?.toLowerCase?.() ?? null });
        const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
        let text = await r.text();
        if (mode === "lie" || mode === "wrongchain") {
          const answers = [JSON.parse(text)].flat(), qs = [q].flat();
          answers.forEach((j, k) => {
            const m = qs[k]?.method;
            // corrupt the FIRST data word (a value, or a dynamic offset): a trailing padding byte may be ignored by the decoder
            if (mode === "lie" && m === "eth_call" && typeof j.result === "string" && j.result.length >= 66) j.result = j.result.slice(0, 65) + (j.result[65] === "0" ? "1" : "0") + j.result.slice(66);
            if (mode === "wrongchain" && m === "eth_chainId") j.result = "0x1";
          });
          text = JSON.stringify(Array.isArray(JSON.parse(text)) ? answers : answers[0]);
        }
        res.writeHead(200, { "content-type": "application/json" }); res.end(text);
      });
      stops.push(closeServer(srv));
      const port = await freePort();
      await new Promise((ok) => srv.listen(port, "127.0.0.1", ok));
      rpcs.push(`http://127.0.0.1:${port}`);
    }
    // a stand-in Enclave API: it would answer, so any request reaching it is a real call
    const apiHits = [];
    const api = http.createServer((req, res) => { apiHits.push(`${req.method} ${req.url}`); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    stops.push(closeServer(api));
    const apiPort = await freePort();
    await new Promise((ok) => api.listen(apiPort, "127.0.0.1", ok));
    const rpcCall = (method, params = []) => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json()).then((j) => j.result);
    const mine = () => rpcCall("evm_mine").catch(() => {});
    const miner = setInterval(() => mine(), 500);
    stops.push(() => clearInterval(miner));
    for (let i = 0; i < 4; i++) await mine();
    const pins = { version: 1, chainId: 8453, contracts: { registry: registry.toLowerCase(), deployments: ledger.toLowerCase(), appCatalog: catalog.toLowerCase(),
      proofOfTime: ledger.toLowerCase(), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20), sessionVaultFactory: factory.toLowerCase(),
      secretVaultV2: "0x" + "00".repeat(20) } };
    return { stop, stops, closeServer, rpc, pc, wc, write, deploy, mine, rpcCall, A, rpcs, rpcModes, rpcLog, apiHits, apiOrigin: `http://127.0.0.1:${apiPort}`, apiPort,
      addresses: { usdc, registry, ledger, catalog, router, factory, book, reviews, bw, feed, svlib }, owner, operator, other, endpoint, runner, appId, appRef, thirdId,
      publisher: pub.account.address, create, createdId, pins };
  } catch (e) { await stop(); throw e; }
}

/** A minimal MCP client over the stdio transport of a child process: request(method, params) -> result | error. */
export function stdioClient(child) {
  let buf = "", seq = 0;
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); }
    }
  });
  const request = (method, params = {}, timeoutMs = 150000) => new Promise((ok, no) => {
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); no(new Error(`MCP ${method} timed out`)); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); ok(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  /** tools/call -> { ok, value (structured or text), text, isError } */
  const call = async (name, args = {}) => {
    const m = await request("tools/call", { name, arguments: args });
    if (m.error) return { ok: false, rpcError: m.error, text: m.error.message };
    const r = m.result, text = r.content?.[0]?.text ?? "";
    return { ok: !r.isError, isError: !!r.isError, value: r.structuredContent ?? text, text };
  };
  return { request, notify, call };
}

// ---- custody v2 on the ORIGINAL vault ----------------------------------------------------------------------------------
// contracts/EnclaveSecretVaultV2.sol (the production source, test/helpers/original-vault-rig.mjs's cached solc build) on the
// rig's chain, bound to the rig's admin AddressBook (it reads deployments, registry and sessionVaultFactory from it at every
// call). Its genesis committee is what production starts with: ONE Enclave-founded seat (the host's payout wallet is the
// vault's enclaveOwner), t = 1. That seat's custodian is the REAL createCustodianV2 behind the REAL router, over HTTPS. Its
// on-chain endpoint is a public literal address that only the process under test maps to the loopback server
// (cli-network-guard ENCLAVE_TEST_ROUTE), as the management plane does. Synthetic: no SEV-SNP hardware.
export const PUBLIC_CUSTODIAN = Object.freeze({ address: "8.8.4.6", port: 9443 });
export async function startCustody(r, { dir }) {
  const { originalVaultRig } = await import("./original-vault-rig.mjs");
  const { secp256k1 } = await import("@noble/curves/secp256k1");
  const hpke = await import("../../custody/hpke.mjs");
  const D = await import("../../custody/v2/digests.mjs");
  const { VAULT_V2_ABI, createChainReaderV2 } = await import("../../custody/v2/chain.mjs");
  const { createCustodianV2 } = await import("../../custody/v2/custodian.mjs");
  const { createCustodyRouter } = await import("../../custody/v2/http.mjs");
  const { buildBundleV2, makeUpdateV2, UPDATE_V2_ABI } = await import("../../custody/v2/owner.mjs");
  const https = await import("node:https");
  const { randomBytes } = await import("node:crypto");
  const { execFileSync } = await import("node:child_process");
  const { generatePrivateKey } = await import("viem/accounts");
  const C = originalVaultRig();
  const fund = (a) => r.rpcCall("anvil_setBalance", [a.address, "0x" + (10n ** 20n).toString(16)]);
  const acct = async () => { const a = privateKeyToAccount(generatePrivateKey()); await fund(a); return a; };
  const enclaveOwner = await acct(), operator = await acct(), identity = privateKeyToAccount(generatePrivateKey());
  const vault = (await r.deploy({ abi: C.vault.abi, bytecode: C.vault.bytecode, linkReferences: {} }, [r.addresses.book, enclaveOwner.address])).toLowerCase();
  const dep = r.wc(KEYS.deployer);
  await r.write(dep, r.addresses.book, r.A.book.abi, "set", [toHex("registry", { size: 32 }), r.addresses.registry]);
  // the custody seat's host: registered on the schema-4 registry; its payout declaration names the Enclave wallet
  const hostEndpoint = "https://custody-host.independent.test", registryId = keccak256(toBytes(hostEndpoint));
  const walletOf = (account) => createWalletClient({ chain, account, transport: viemHttp(r.rpc) });
  await r.write(walletOf(operator), r.addresses.registry, r.A.registry4.abi, "register", [hostEndpoint, "custody/host", "0x" + "00".repeat(32), 5000n, 0n, "0x0000000000000000000000000000000000000000"]);   // the registry requires a price; dearer than the compute host
  await r.write(walletOf(enclaveOwner), r.addresses.registry, r.A.registry4.abi, "setPayoutWallet", [registryId]);
  const N = secp256k1.CURVE.n, a0 = secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey()) % N;
  const Y = secp256k1.ProjectivePoint.BASE.multiply(a0).toRawBytes(true), kp = hpke.generateKeyPair();
  const codeSet = ["0x" + "6d".repeat(32)], salt = "0x" + randomBytes(32).toString("hex");
  const endpoint = `https://${PUBLIC_CUSTODIAN.address}:${PUBLIC_CUSTODIAN.port}`;
  const m = { identity: identity.address, encKey: "0x" + Buffer.from(kp.publicKey).toString("hex"), endpoint, chipId: "0x" + randomBytes(32).toString("hex"), registryId, measurement: codeSet[0] };
  const Yhex = "0x" + Buffer.from(Y).toString("hex");
  const committeeId = D.committeeIdOf({ chainId: 8453, vault, salt, Y }).toLowerCase();
  await r.write(dep, vault, VAULT_V2_ABI, "createCommittee", [salt, m, Yhex, codeSet,
    await D.signDigest(identity, D.genesisDigest({ chainId: 8453, vault, committeeId, Y, machine: m, codeSet })),
    await D.signDigest(operator, D.hostDigest({ chainId: 8453, vault, machine: m }))]);
  // the seat's custodian, reading the chain itself (book-bound, as the production vault is)
  const reader = createChainReaderV2({ clients: [r.pc], vault, vaultKind: "book", book: r.addresses.book.toLowerCase(), chainId: 8453, minAgree: 1, maxAgeSec: 3600 });
  const custodian = createCustodianV2({ chainId: 8453, vault, encPrivateKey: kp.privateKey, chain: reader, verifiers: {}, log: () => {},
    shares: { get: (cid, epoch) => (cid === committeeId && epoch === 1 ? [{ k: 1, x: a0 }] : null) } });
  const router = createCustodyRouter({ custodian, member: { info: (c) => ({ v: 2, committeeId: c }) }, runIndependent: async () => ({}), servedCommittee: () => committeeId,
    chainId: 8453, vault, trustedProxies: [] });
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-keyout", path.join(dir, "ck.pem"),
    "-out", path.join(dir, "cc.pem"), "-subj", "/CN=custodian", "-addext", `subjectAltName=IP:127.0.0.1,IP:${PUBLIC_CUSTODIAN.address}`], { stdio: "ignore" });
  const hits = [];
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, "ck.pem")), cert: fs.readFileSync(path.join(dir, "cc.pem")) }, (req, res) => { hits.push(`${req.method} ${req.url}`); router(req, res); });
  r.stops.push(r.closeServer(srv));
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const SNP = { v: 1, appId: "a7".repeat(32), images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "cd".repeat(32) }],
    minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
  const state = async (id) => {
    const [owner, policyRev, secretRev, cid, paused, rules] = await r.pc.readContract({ address: vault, abi: VAULT_V2_ABI, functionName: "policyOf", args: [id] });
    const [, , data] = await r.pc.readContract({ address: vault, abi: VAULT_V2_ABI, functionName: "bundleOf", args: [id] });
    return { owner: owner.toLowerCase(), policyRev, secretRev, committeeId: cid, paused, rules, data };
  };
  // the OWNER's own first write (what `custody set … --owner-read on` sends): a policy on this committee and a bundle
  const ownerUpdate = async (key, id, update) => r.write(r.wc(key), vault, UPDATE_V2_ABI, "update", [id, update]);
  const createPolicy = async (key, id, { env, ownerRead = true, paused = false }) => {
    const s = await state(id);
    const bundle = buildBundleV2({ chainId: 8453, vault, id, secretRev: s.secretRev + 1n, committeeId, Y, env, configText: "" });
    return ownerUpdate(key, id, makeUpdateV2({ expectPolicyRev: s.policyRev, policy: { committeeId, paused, rules: ownerRead ? { ...SNP, ownerRead: true } : SNP }, bundle }));
  };
  const setPaused = async (key, id, paused) => {
    const s = await state(id);
    const { parseRules } = await import("../../custody/rules.mjs");
    return ownerUpdate(key, id, makeUpdateV2({ expectPolicyRev: s.policyRev, policy: { committeeId, paused, rules: parseRules(Buffer.from(s.rules.slice(2), "hex")) } }));
  };
  /** what the owner's own machine does to seal values for a remote adapter (the remote never sees them) */
  const seal = async (id, env) => { const s = await state(id);
    return "0x" + Buffer.from(buildBundleV2({ chainId: 8453, vault, id, secretRev: s.secretRev + 1n, committeeId, Y, env, configText: "" })).toString("hex"); };
  return { vault, committeeId, Y: Yhex, endpoint, hits, caFile: path.join(dir, "cc.pem"), route: `${PUBLIC_CUSTODIAN.address}:${PUBLIC_CUSTODIAN.port}=127.0.0.1:${srv.address().port}`,
    state, createPolicy, setPaused, seal, ownerUpdate, enclaveOwner, host: { registryId, endpoint: hostEndpoint, operator: operator.address.toLowerCase() } };
}
