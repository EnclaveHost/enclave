// TEST SUPPORT: custody v2 for the independent dashboard's Secrets tab (test/site-independent-secrets.test.mjs), on top of
// test/helpers/independent-browser-rig.mjs (anvil 8453 with the REAL ledger, registry and session factory):
//   - the REAL EnclaveSecretVaultV2 and EnclaveHostOwnership (the independent rig's cached compile), its book naming the
//     rig's ledger, registry and session factory;
//   - three custodian HOSTS registered in the real registry by their own operators, each accepted by a distinct owner
//     (none is the vault's enclaveOwner), and an INDEPENDENT committee over them whose key the test knows (f(x) = a0 + a1 x);
//   - three REAL createCustodianV2 instances (share f(k)) behind the REAL router (custody/v2/http.mjs, with the owner-read
//     CORS), each behind the REAL Caddy site that directCustodyIngress generates, over TLS from a throwaway CA. The page
//     reaches them at https://custody-N.test:<port> (Chromium host-resolver-rules; the CA is trusted through a throwaway
//     NSS store, never by turning validation off);
//   - per custodian, an in-path control between Caddy and the router: up/down, and misbehaviour modes that act like a
//     malicious custodian or ingress (a wrong share with a valid proof, partials sealed to another recipient or bound to
//     another purpose, a request rewritten to another recipient or purpose).
// Synthetic: the custodians run in-process with no SEV-SNP or Shield hardware, and no guest attestation is involved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createWalletClient, http as viemHttp, keccak256, toBytes, stringToHex, parseEther, bytesToHex, hexToBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as hpke from "../../custody/hpke.mjs";
import * as v2 from "../../custody/v2/protocol.mjs";
import * as D from "../../custody/v2/digests.mjs";
import { VAULT_V2_ABI, createChainReaderV2 } from "../../custody/v2/chain.mjs";
import { createCustodianV2 } from "../../custody/v2/custodian.mjs";
import { createCustodyRouter } from "../../custody/v2/http.mjs";
import { directCustodyIngress } from "../../custody/v2/ingress.mjs";
import { chain } from "./independent-browser-rig.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const require = createRequire(import.meta.url);
const N = secp256k1.CURVE.n, mod = (x) => ((x % N) + N) % N;
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

/* the same compile (and cache key) as test/helpers/owner-read-rig.mjs and independent-custody-rig.mjs */
function compiled() {
  const rig = fs.readFileSync(path.join(ROOT, "test/helpers/independent-custody-rig.mjs"), "utf8");
  const MOCKS = /const MOCKS = `([\s\S]*?)`;/.exec(rig)[1];
  const src = fs.readFileSync(path.join(ROOT, "contracts/EnclaveSecretVaultV2.sol"), "utf8"), own = fs.readFileSync(path.join(ROOT, "contracts/EnclaveHostOwnership.sol"), "utf8");
  const key = createHash("sha256").update(src).update(own).update(MOCKS).digest("hex").slice(0, 16);
  const cache = path.join(process.env.TMPDIR || "/tmp", `enclave-custody-v2-independent-rig-${key}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const out = JSON.parse(require("solc").compile(JSON.stringify({ language: "Solidity", sources: { "V.sol": { content: src }, "Rig.sol": { content: MOCKS }, "Ownership.sol": { content: own } },
    settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  const pick = (f, n) => ({ abi: out.contracts[f][n].abi, bytecode: "0x" + out.contracts[f][n].evm.bytecode.object });
  const r = { ownership: pick("Ownership.sol", "EnclaveHostOwnership"), vault: pick("V.sol", "EnclaveSecretVaultV2"), book: pick("Rig.sol", "RigBook"),
              ledger: pick("Rig.sol", "RigLedger"), registry: pick("Rig.sol", "RigRegistry") };
  fs.writeFileSync(cache, JSON.stringify(r));
  return r;
}

/* a throwaway CA and ONE leaf for the custodian names (openssl), plus an NSS store trusting only that CA */
function pki(dir, hosts) {
  const o = (args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  o(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=custody secrets test CA", "-days", "2",
     "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  o(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=" + hosts[0],
     "-addext", "subjectAltName=" + hosts.map((h) => "DNS:" + h).join(","), "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=serverAuth"]);
  o(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-copy_extensions", "copy", "-out", "leaf.pem"]);
  const home = path.join(dir, "home"), nss = path.join(home, ".pki", "nssdb");
  fs.mkdirSync(nss, { recursive: true });
  execFileSync("certutil", ["-N", "-d", "sql:" + nss, "--empty-password"], { stdio: "ignore" });
  execFileSync("certutil", ["-A", "-d", "sql:" + nss, "-n", "custody-secrets-test-ca", "-t", "C,,", "-i", path.join(dir, "ca.pem")], { stdio: "ignore" });
  return { home, caPem: fs.readFileSync(path.join(dir, "ca.pem"), "utf8"), leaf: path.join(dir, "leaf.pem"), key: path.join(dir, "leaf.key") };
}

/**
 * custodyWorld(rig) -> { vault, indCid, a0, f, custodians: [{ endpoint, host, ctl }], hostRules, home, onOwnerRead(fn), ownerSend, stop }
 *   ctl.up = false            the custodian is unreachable (its forwarder drops the connection; Caddy answers 502)
 *   ctl.mode = "ok"           honest
 *            | "lie-share"    answers a WRONG partial (f(k)+1) with a valid-looking proof, validly sealed to the recipient
 *            | "lie-recipient" seals its (correct) partial to ANOTHER recipient key
 *            | "lie-purpose"  answers partials bound to a guest-release binding (another purpose) instead of the owner read
 *            | "req-recipient" the request is rewritten in flight to another recipient key before the custodian sees it
 *            | "req-purpose"  the request is rewritten in flight to the guest release's purpose
 *   ctl.seen                  every request that reached the forwarder: "METHOD path"
 */
export async function custodyWorld(rig, { caddyBin = process.env.CADDY_BIN } = {}) {
  if (!caddyBin) throw new Error("custodyWorld needs CADDY_BIN (the real Caddy the ingress is generated for)");
  const stops = [];
  const stop = async () => { for (const f of stops.reverse()) { try { await f(); } catch {} } };
  try {
    const C = compiled(), pub = rig.pc;
    const wallet = (a) => createWalletClient({ account: a, chain, transport: viemHttp(rig.rpc) });
    const send = async (a, address, abi, functionName, args) => {
      const r = await pub.waitForTransactionReceipt({ hash: await wallet(a).writeContract({ address, abi, functionName, args }) });
      if (r.status !== "success") throw new Error(`${functionName} reverted`); return r;
    };
    const deploy = async (a, c, args = []) => (await pub.waitForTransactionReceipt({ hash: await wallet(a).deployContract({ abi: c.abi, bytecode: c.bytecode, args }) })).contractAddress.toLowerCase();
    const acct = async () => { const a = privateKeyToAccount(generatePrivateKey()); await pub.request({ method: "anvil_setBalance", params: [a.address, "0x" + parseEther("10").toString(16)] }); return a; };
    const deployer = await acct(), enclaveWallet = await acct();
    const { ledger, registry, factory } = rig.addresses;
    const book = await deploy(deployer, C.book);
    for (const [k, v] of [["deployments", ledger], ["registry", registry], ["sessionVaultFactory", factory]]) await send(deployer, book, C.book.abi, "set", [stringToHex(k, { size: 32 }), v]);
    const ownership = await deploy(deployer, C.ownership, [registry]);
    const vault = await deploy(deployer, C.vault, [book, enclaveWallet.address, ownership]);

    // three custodian hosts in the REAL registry, each with its own operator and a distinct accepted (non-Enclave) owner
    const a0 = mod(BigInt("0x" + randomBytes(32).toString("hex"))), a1 = mod(BigInt("0x" + randomBytes(32).toString("hex")));
    const f = (k) => mod(a0 + a1 * BigInt(k));
    const commitments = Buffer.concat([secp256k1.ProjectivePoint.BASE.multiply(a0).toRawBytes(true), secp256k1.ProjectivePoint.BASE.multiply(a1).toRawBytes(true)]);
    const codeSet = ["0x" + "6d".repeat(32)], salt = bytesToHex(randomBytes(32));
    const ports = [await freePort(), await freePort(), await freePort()];
    const hosts = [0, 1, 2].map((i) => `custody-${i}.test`);
    const members = [];
    for (let i = 0; i < 3; i++) {
      const op = await acct(), owner = await acct(), hostEndpoint = `https://custodian-host-${i}.independent.test`, registryId = keccak256(toBytes(hostEndpoint));
      await send(op, registry, rig.abi.registry, "register", [hostEndpoint, "independent/custodian", "0x" + "00".repeat(32), 1000n, 0n, "0x0000000000000000000000000000000000000000"]);
      await send(op, ownership, C.ownership.abi, "proposeOwner", [registryId, owner.address]);
      await send(owner, ownership, C.ownership.abi, "acceptOwner", [registryId]);
      const identity = privateKeyToAccount(generatePrivateKey()), kp = hpke.generateKeyPair();
      members.push({ op, identity, kp, m: { identity: identity.address, encKey: bytesToHex(kp.publicKey), endpoint: `https://${hosts[i]}:${ports[i]}`,
                                            chipId: bytesToHex(randomBytes(32)), registryId, measurement: codeSet[0] } });
    }
    const indCid = D.committeeIdOf({ chainId: 8453, vault, salt, Y: commitments.subarray(0, 33) }).toLowerCase();
    const gd = D.independentGenesisDigest({ chainId: 8453, vault, committeeId: indCid, commitments, machines: members.map((x) => x.m), codeSet });
    await send(deployer, vault, VAULT_V2_ABI, "createIndependentCommittee", [salt, members.map((x) => x.m), bytesToHex(commitments), codeSet,
      await Promise.all(members.map((x) => D.signDigest(x.identity, gd))), await Promise.all(members.map((x) => D.signDigest(x.op, D.hostDigest({ chainId: 8453, vault, machine: x.m }))))]);

    // the custodians: real createCustodianV2 behind the real router, each behind an in-path control
    const hooks = [];
    const custodians = [];
    for (const [i, x] of members.entries()) {
      const k = i + 1, ctl = { up: true, mode: "ok", seen: [] };
      const reader = createChainReaderV2({ clients: [pub], vault, chainId: 8453, minAgree: 1, maxAgeSec: 3600 });
      const real = createCustodianV2({ chainId: 8453, vault, encPrivateKey: x.kp.privateKey, chain: reader, verifiers: {}, log: () => {},
        shares: { get: (cid, epoch) => (cid === indCid && epoch === 1 ? [{ k, x: f(k) }] : null) } });
      const other = hpke.generateKeyPair().publicKey;
      const fieldsOf = (b) => ({ chainId: 8453, vault, id: b.id, policyRev: BigInt(b.policyRev), secretRev: BigInt(b.secretRev), committeeId: b.committeeId, epoch: b.epoch,
        challenges: b.challenges.map((c) => ({ encKey: hexToBytes("0x" + c.encKey), nonce: hexToBytes("0x" + c.nonce) })), recipientKey: hexToBytes("0x" + b.recipientKey), expiry: b.expiry });
      const forged = async (b, { share, recipientKey, binding }) => {
        const [, , data] = await pub.readContract({ address: vault, abi: VAULT_V2_ABI, functionName: "bundleOf", args: [b.id] });
        const R = v2.parseBundle(hexToBytes(data)).R, cm = [commitments.subarray(0, 33), commitments.subarray(33, 66)];
        const record = v2.partial({ k, x: share, R, binding, commitments: cm });
        return { v: 2, encKey: real.encKeyHex, count: 1, sealed: Buffer.from(v2.sealPartials({ recipientKey, binding, encKey: x.kp.publicKey, records: [record] })).toString("base64") };
      };
      const custodian = {
        ...real,
        ownerRead: async (body) => {
          let b = body;
          if (ctl.mode === "req-recipient") b = { ...body, recipientKey: bytesToHex(other).slice(2) };
          if (ctl.mode === "req-purpose") b = { ...body, purpose: "enclave-custody-release/1" };
          let r = await real.ownerRead(b);
          if (ctl.mode === "lie-share") r = await forged(body, { share: mod(f(k) + 1n), recipientKey: hexToBytes("0x" + body.recipientKey), binding: v2.ownerReadBinding(fieldsOf(body)) });
          if (ctl.mode === "lie-recipient") r = await forged(body, { share: f(k), recipientKey: other, binding: v2.ownerReadBinding(fieldsOf(body)) });
          if (ctl.mode === "lie-purpose") r = await forged(body, { share: f(k), recipientKey: hexToBytes("0x" + body.recipientKey),
            binding: v2.releaseBinding({ ...fieldsOf(body), runtimeId: new Uint8Array(32), transportSpki: new Uint8Array(40) }) });
          for (const h of hooks) await h(i, body);
          return r;
        },
      };
      const route = createCustodyRouter({ custodian, member: { info: (c) => ({ v: 2, committeeId: c }) }, runIndependent: async () => ({}), servedCommittee: () => indCid,
                                          chainId: 8453, vault, trustedProxies: ["127.0.0.1"] });
      const srv = http.createServer((req, res) => {
        ctl.seen.push(req.method + " " + req.url);
        if (!ctl.up) { req.socket.destroy(); return; }
        return route(req, res);
      });
      await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
      stops.push(() => new Promise((ok) => { srv.closeAllConnections(); srv.close(ok); }));
      custodians.push({ endpoint: x.m.endpoint, host: hosts[i], port: ports[i], backend: srv.address().port, ctl, encKey: real.encKeyHex });
    }

    // ONE real Caddy serving the three generated sites over TLS (the deployed ingress, with a test certificate and port)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custody-secrets-"));
    stops.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const certs = pki(dir, hosts);
    const sites = custodians.map((c) => directCustodyIngress({ endpoint: `https://${c.host}`, mgmtPort: c.backend })
      .replace(`https://${c.host} {`, `https://${c.host}:${c.port} {\n  bind 127.0.0.1\n  tls ${certs.leaf} ${certs.key}`));
    const caddyfile = path.join(dir, "Caddyfile");
    fs.writeFileSync(caddyfile, "{\n  admin off\n  auto_https off\n}\n" + sites.join("\n"), { mode: 0o600 });
    execFileSync(caddyBin, ["adapt", "--config", caddyfile, "--adapter", "caddyfile"], { stdio: "pipe" });
    let diagnostics = "";
    const caddy = spawn(caddyBin, ["run", "--config", caddyfile, "--adapter", "caddyfile"], { env: { ...process.env, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir }, stdio: ["ignore", "ignore", "pipe"] });
    caddy.stderr.on("data", (c) => { diagnostics = (diagnostics + c).slice(-4000); });
    stops.push(async () => { if (caddy.exitCode === null) { caddy.kill("SIGTERM"); await Promise.race([once(caddy, "exit"), new Promise((r) => setTimeout(r, 3000))]); } });
    for (let i = 0; i < 100; i++) {
      if (caddy.exitCode !== null) throw new Error("Caddy exited: " + diagnostics);
      const ok = await Promise.all(custodians.map((c) => new Promise((r) => { const s = net.connect(c.port, "127.0.0.1", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); })));
      if (ok.every(Boolean)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Chromium: only the custodian names resolve (to loopback); every other name is NOT FOUND, so nothing reaches real DNS
    const hostRules = hosts.map((h) => `MAP ${h} 127.0.0.1`).join(", ") + ", MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE 127.0.0.2";
    const onOwnerRead = (fn) => { hooks.push(fn); return () => hooks.splice(hooks.indexOf(fn), 1); };
    return { vault, book, ownership, indCid, a0, f, custodians, hostRules, home: certs.home, onOwnerRead, send, acct, deploy, diagnostics: () => diagnostics, stop };
  } catch (e) { await stop(); throw e; }
}
