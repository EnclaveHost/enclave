#!/usr/bin/env node
// The custodian daemon an independent custody operator runs (docs/security/secret-custody.md, "Running a custodian").
//
//   custodian-daemon.mjs keygen  --out custodian.key        new share + operator keys, passphrase-encrypted (the backup)
//   custodian-daemon.mjs show                               the public share key and operator address to register
//   custodian-daemon.mjs serve                              the release service (put TLS on :443 in front of it)
//   custodian-daemon.mjs approve-epoch --committee 0x… --threshold t --members members.json
//   custodian-daemon.mjs deal    --id 0x… --to <epoch>      as an OLD member: re-share this deployment's share
//   custodian-daemon.mjs receive --id 0x… --to <epoch>      as a NEW member: combine the deals, post the new share
//
// Configuration (environment):
//   CUSTODY_KEYFILE            the passphrase-encrypted key file (mode 0600)            REQUIRED
//   CUSTODY_PASSPHRASE_FILE    a file holding its passphrase (mode 0600)                REQUIRED
//   CUSTODY_VAULT              the EnclaveSecretVault address                           REQUIRED
//   CUSTODY_CHAIN_ID           8453 (Base) unless stated
//   CUSTODY_RPCS               comma-separated Base RPC URLs, independent providers
//   CUSTODY_MIN_AGREE          how many must agree (default 2; 1 only for a custodian running its own node)
//   CUSTODY_MAX_AGE_SEC        refuse chain state older than this (default 120; "off" only for a local test chain)
//   CUSTODY_LISTEN             host:port for serve (default 127.0.0.1:8787)
//   CUSTODY_CLIENT_HEADER      behind a reverse proxy: the header carrying the client address (rate limits are per client)
//   CUSTODY_STATE_DIR          high-water marks and the AMD collateral cache (default ./custodian-state)
//
// There is deliberately NO option for synthetic attestation roots, a test verifier, or skipping any check: the verifier
// table is custody/verifiers.mjs productionVerifiers, AMD's pinned roots, the CRL required.
import fs from "node:fs";
import path from "node:path";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { openKeyFile, sealKeyFile, generateKeys, readKeyFile, writeKeyFile } from "./keystore.mjs";
import { createChainReader, VAULT_ABI } from "./chain.mjs";
import { custodyChainSource } from "./chain-source.mjs";
import { custodianConfigFromEnv } from "./custodian-config.mjs";
import { createCustodian, serveCustodian } from "./custodian.mjs";
import { productionVerifiers } from "./verifiers.mjs";
import { makeDeal, receiveDeals } from "./reshare.mjs";
import { UPDATE_ABI } from "./owner.mjs";
import * as P from "./protocol.mjs";
import { cachedCollateral, httpCollateral } from "../verifier/consumer.mjs";

const env = process.env;
const die = (m) => { console.error(`custodian: ${m}`); process.exit(1); };
process.on("uncaughtException", (e) => die(e && e.message ? e.message : String(e)));
process.on("unhandledRejection", (e) => die(e && e.message ? e.message : String(e)));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

function passphrase() {
  const f = env.CUSTODY_PASSPHRASE_FILE || die("CUSTODY_PASSPHRASE_FILE is required");
  return readKeyFile(f).replace(/\r?\n$/, "");   // the same owner-only rule as the key file
}
function keys() {
  return openKeyFile(readKeyFile(env.CUSTODY_KEYFILE || die("CUSTODY_KEYFILE is required")), passphrase());
}
function config() {
  try { return custodianConfigFromEnv(env); } catch (e) { die(e.message); }
}

// high-water marks survive a restart: an RPC that serves an older state after the restart is still refused
function fileHighWater(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, "highwater.json");
  let m = {};
  try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  return {
    get: (id) => m[id] || null,
    set: (id, v) => { m[id] = v; const tmp = f + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 }); fs.renameSync(tmp, f); },
  };
}

// the chain reader for this configuration: the legacy RPC quorum (default, unchanged) or the explicit local verifier
function readerFor(c, extra = {}) {
  const src = custodyChainSource(c);
  return { src, reader: createChainReader({ rpcs: src.rpcs, clients: src.clients, minAgree: src.minAgree, vault: c.vault, ...extra }) };
}

const cmd = process.argv[2];
if (cmd === "keygen") {
  const out = arg("--out") || die("keygen --out <file>");
  const k = generateKeys();
  writeKeyFile(out, sealKeyFile({ ...k, passphrase: passphrase() }));
  const o = openKeyFile(fs.readFileSync(out, "utf8"), passphrase());
  console.log(JSON.stringify({ keyfile: out, encKey: "0x" + o.encKey, operator: o.operator,
    next: "copy the key file to two offline places; fund the operator with a little Base ETH; give encKey, operator and your https endpoint to the committee" }, null, 2));
} else if (cmd === "show") {
  const k = keys();
  console.log(JSON.stringify({ encKey: "0x" + k.encKey, operator: k.operator }, null, 2));
} else if (cmd === "serve") {
  const c = config(), k = keys();
  const collateral = cachedCollateral({ dir: path.join(c.stateDir, "amd"), upstream: httpCollateral({ timeoutMs: 8000 }) });
  const { src, reader: chainReader } = readerFor(c, { maxAgeSec: c.maxAgeSec });
  const custodian = createCustodian({ chainId: c.chainId, vault: c.vault, encPrivateKey: k.encPrivateKey,
    chain: chainReader,
    verifiers: productionVerifiers({ collateral }), highWater: fileHighWater(c.stateDir) });
  const [host, port] = String(env.CUSTODY_LISTEN || "127.0.0.1:8787").split(":");
  // behind the TLS proxy every request comes from the proxy: CUSTODY_CLIENT_HEADER names the header it sets (x-forwarded-for)
  const hdr = String(env.CUSTODY_CLIENT_HEADER || "").toLowerCase();
  const clientOf = hdr ? (req) => String(req.headers[hdr] || "").split(",")[0].trim() || req.socket.remoteAddress : undefined;
  const srv = await serveCustodian(custodian, { host, port: Number(port), clientOf, info: { vault: c.vault, chainId: c.chainId, operator: k.operator } });
  console.log(`custodian: share key 0x${k.encKey.slice(0, 16)}…, operator ${k.operator}, vault ${c.vault}, ${src.mode === "verifier" ? "the local verifier (one authority, unsafe tier, no L1 finality)" : `${c.rpcs.length} RPCs (${c.minAgree} must agree)`}, listening on ${host}:${srv.address().port}`);
} else if (["approve-epoch", "deal", "receive"].includes(cmd)) {
  const c = config(), k = keys();
  const account = privateKeyToAccount(k.operatorPrivateKey);
  const { src, reader } = readerFor(c);
  // verifier: prepared through the verifier, sent ONLY to the bound own backend (refused without one); quorum: unchanged
  const wallet = createWalletClient({ account, chain: { ...base, id: c.chainId }, transport: src.mode === "verifier" ? src.authority.transport : http(c.rpcs[0]) });
  const send = async (abi, functionName, args) => {
    const hash = await wallet.writeContract({ address: c.vault, abi, functionName, args });
    console.log(`custodian: ${functionName} sent ${hash}`);
  };
  if (cmd === "approve-epoch") {
    const members = JSON.parse(fs.readFileSync(arg("--members") || die("--members members.json"), "utf8"));
    await send(UPDATE_ABI, "approveEpoch", [arg("--committee"), Number(arg("--threshold")), members]);
  } else {
    const id = String(arg("--id") || "").toLowerCase(), to = Number(arg("--to"));
    if (!/^0x[0-9a-f]{64}$/.test(id) || !Number.isInteger(to)) die(`${cmd} --id 0x<deployment> --to <epoch>`);
    const st = await reader.readState({ id });
    const pol = st.policy, from = st.bundle.epoch;
    const fields = { chainId: c.chainId, vault: c.vault, id, secretRev: pol.secretRev, committeeId: pol.committeeId };
    const oldCom = P.splitCommitments(st.shares.commitments);
    const newEp = await reader.readEpoch({ committeeId: pol.committeeId, epoch: to });
    const mine = (members) => members.findIndex((m) => Buffer.from(m.encKey).toString("hex") === k.encKey);
    if (cmd === "deal") {
      const i = mine(st.committee.members);
      if (i < 0) die("this custodian is not a member of the bundle's current epoch");
      const y = P.openShareAtRest(k.encPrivateKey, { ...fields, epoch: from, index: i, commitments: oldCom }, st.shares.sealedShares[i]);
      const deal = makeDeal({ ...fields, fromEpoch: from, toEpoch: to, dealer: i, y, newMembers: newEp.members, tNew: newEp.threshold });
      await send(VAULT_ABI, "postDeal", [id, to, "0x" + Buffer.from(deal).toString("hex")]);
    } else {
      const j = mine(newEp.members);
      if (j < 0) die("this custodian is not a member of the target epoch");
      const { deals } = await reader.readDeals({ id, secretRev: pol.secretRev, fromEpoch: from, toEpoch: to });
      const r = receiveDeals({ ...fields, fromEpoch: from, toEpoch: to, member: j, encPrivate: k.encPrivateKey, deals, oldCommitments: oldCom,
                               tOld: st.committee.threshold, tNew: newEp.threshold, nNew: newEp.members.length });
      for (const x of r.rejected) console.log(`custodian: dealer ${x.dealer} not used: ${x.reason}`);
      const sealed = P.sealShareAtRest(Buffer.from(k.encKey, "hex"), { ...fields, epoch: to, index: j, commitments: r.commitments }, r.y);
      const source = (BigInt(from) << 32n) | BigInt(r.bitmap);
      await send(VAULT_ABI, "postReshare", [id, to, source, "0x" + Buffer.concat(r.commitments.map((x) => Buffer.from(x))).toString("hex"), "0x" + Buffer.from(sealed).toString("hex")]);
    }
  }
} else {
  die("usage: custodian-daemon.mjs keygen --out <file> | show | serve | approve-epoch … | deal --id --to | receive --id --to");
}
