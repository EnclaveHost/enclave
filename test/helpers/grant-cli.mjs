#!/usr/bin/env node
// The command-line side of a /grant request, for browser tests (a short-lived process: the sessions SDK and viem never load
// into the browser driver). It plays `enclave --independent … login`: it makes the session key (kept in a private temp
// FileStore) and the request link, and later - as a SEPARATE gas payer that is not the account - checks the owner's signature
// by simulating the exact openFor, submits it, and checks the opened session against the grant with the CLI login helper's
// own exact-match rule (cli/independent-login.mjs policyMismatch; read only).
//   node test/helpers/grant-cli.mjs request <rpc> <chainId> <frontendOrigin> <owner>     -> {link, grant, checkCode, keyHash, dir}
//   node test/helpers/grant-cli.mjs submit <rpc> <factory> <grantSer> <sig> <owner> <payerKey> -> {txHash, from, vault, sid, vaultOwner, live, mismatch}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as viem from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as S from "../../sdk/sessions/dist/node.mjs";
import { policyMismatch } from "../../cli/independent-login.mjs";

const [mode, rpc, ...a] = process.argv.slice(2);
const chain = (id) => ({ id, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const out = (o) => process.stdout.write(S.serialize(o) + "\n");

if (mode === "request"){
  const [chainId, origin, owner] = a;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grant-cli-"));
  fs.chmodSync(dir, 0o700);
  const store = new S.FileStore(dir);
  const { signer, record } = await S.newSessionKey(store, { relay: "", chainId: Number(chainId), label: "cli login", extractable: true });
  const grant = S.buildGrant({ sessionKey: signer.keyHash, label: "cli login", preset: "browser", policy: { budget: 0n, expiresIn: 3600 }, signWithin: 900 });
  const link = S.grantLink(origin, { v: 1, chainId: Number(chainId), relay: "", x: record.x, y: record.y, grant, owner });
  if (link.includes(String(record.pkcs8 || "").slice(0, 32))) throw new Error("the private key would appear in the link");
  out({ link, grant: S.serialize(grant), checkCode: S.checkCode(signer.keyHash), keyHash: signer.keyHash, dir });
} else if (mode === "submit"){
  const [factory, grantSer, sig, owner, payerKey] = a;
  const grant = S.deserialize(grantSer);
  const pc = viem.createPublicClient({ chain: chain(8453), transport: viem.http(rpc) });
  const payer = privateKeyToAccount(payerKey);
  const wc = viem.createWalletClient({ chain: chain(8453), account: payer, transport: viem.http(rpc) });
  const prep = await S.prepareSessionOpen({ publicClient: pc, factory, chainId: 8453, grant, owner: { address: owner, signTypedData: async () => sig } });
  await pc.call({ to: prep.to, data: prep.data, account: payer });               // the exact openFor, simulated first
  const hash = await wc.sendTransaction({ to: prep.to, data: prep.data, gas: 3_000_000n });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error("openFor reverted");
  const st = await S.readSession(pc, prep.vault, prep.sid);
  const vaultOwner = await pc.readContract({ address: prep.vault, abi: viem.parseAbi(["function owner() view returns (address)"]), functionName: "owner" });
  const mismatch = policyMismatch(S, grant, { exists: true, session: st, apps: st.apps });
  out({ txHash: hash, from: rc.from, vault: prep.vault, sid: prep.sid, vaultOwner, live: st.live, mismatch });
} else throw new Error("usage: grant-cli.mjs request|submit …");
