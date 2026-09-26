#!/usr/bin/env node
// delegation-sign.mjs - TEST 2's delegation (TEST2.md): OUR agent wallet consents, as a deployment OWNER, to the NucBox's
// operator serving its hyperv-partition-per-app deployments. It is enclave-e3's enclave-host-delegation-v1 text, built and
// checked by the SAME module the relay and the node use (windows/node/host-delegation.mjs = relay/host-delegation.mjs, byte
// for byte), signed with personal_sign (EIP-191) by the agent key.
//   bash -ic 'node <this file> --operator 0x389C… --box nucbox-k11 (--days <n> | --minutes <n>) \
//       --expect-owner 0x29479bf0… --out <file.json> [--registry 0x…] [--chain 8453]'
//   (ETH_AGENT_WALLET comes from the interactive profile, into this one process only; VIEM_DIR = a checkout with viem)
// It prints the exact message, its expiry, the owner's levers and the verdict of verifyDelegation over the written file;
// it never prints or writes the key. --minutes is for the SHORT-expiry negative (b); the relay refuses more than 180 days.
// A Steven delegation is NOT made here: his is signed in his own wallet (the Trezor) from `scripts/host-delegation.mjs text`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { delegationText, verifyDelegation, MAX_DELEGATION_SEC } from "../../../host-delegation.mjs";
// viem from a checkout that has it installed (VIEM_DIR, default ~/Projects/enclave, as test2-watch.sh reads the ledger):
// windows/node carries no node_modules in a checkout, so neither this file nor host-delegation.mjs's own default recover
// can resolve it from here. The module is the same; only where it is loaded from differs (enclave-d1's run of TEST2).
const VIEM_DIR = process.env.VIEM_DIR || path.join(os.homedir(), "Projects", "enclave");
const req = createRequire(path.join(VIEM_DIR, "package.json"));
const { privateKeyToAccount } = await import(pathToFileURL(req.resolve("viem/accounts")).href);
const { recoverMessageAddress } = await import(pathToFileURL(req.resolve("viem")).href);
const recover = (message, signature) => recoverMessageAddress({ message, signature });

const REGISTRY = "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac";   // EnclaveRegistry on Base (relay REGISTRY_ADDRESS; e3's script default)
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const die = (m) => { console.error(`REFUSED: ${m}`); process.exit(2); };
const low = (a) => String(a || "").toLowerCase();

const operator = low(opt("--operator")), box = opt("--box"), out = opt("--out"), expect = low(opt("--expect-owner"));
const chain = Number(opt("--chain", "8453")), registry = low(opt("--registry", REGISTRY));
const secs = opt("--minutes") !== undefined ? Math.round(Number(opt("--minutes")) * 60) : Math.round(Number(opt("--days", "0")) * 86400);
if (!/^0x[0-9a-f]{40}$/.test(operator) || !box || !out || !/^0x[0-9a-f]{40}$/.test(expect)) die("usage: see the header");
if (!(secs >= 60 && secs <= MAX_DELEGATION_SEC)) die(`the expiry must be 1 minute .. ${MAX_DELEGATION_SEC / 86400} days`);
if (fs.existsSync(out)) die(`${out} exists (a delegation file is never overwritten)`);
let key = String(process.env.ETH_AGENT_WALLET || "").trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) die("ETH_AGENT_WALLET is not set to a 32-byte hex key");
const acct = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`); key = null;
const owner = acct.address.toLowerCase();
if (owner !== expect) die(`the agent key is ${owner}, not the expected owner ${expect}`);

const expires = Math.floor(Date.now() / 1000) + secs;
const message = delegationText({ owner, operator, box, chain, registry, expires });
const signature = await acct.signMessage({ message });
fs.writeFileSync(out, JSON.stringify({ message, signature }, null, 2) + "\n", { mode: 0o644, flag: "wx" });
const v = await verifyDelegation(JSON.parse(fs.readFileSync(out, "utf8")), { operator, box, chain, registry, recover });
// a consent that does not verify is never left under its own name, where it could be copied to the box (enclave-d1's S3)
let kept = out;
if (!v.ok) { kept = `${out}.INVALID`; fs.renameSync(out, kept); }

console.log(`The message the OWNER ${owner} signed (personal_sign, EIP-191):\n\n${message}\n`);
console.log(`expires ${new Date(expires * 1000).toISOString()} (${secs >= 86400 ? `${(secs / 86400).toFixed(2)} days` : `${Math.round(secs / 60)} minutes`})`);
console.log(`file: ${kept}  sha256 ${(await import("node:crypto")).createHash("sha256").update(fs.readFileSync(kept)).digest("hex")}`);
console.log(`verifyDelegation (the relay's and the node's module): ${v.ok ? `VALID, owner ${v.owner}` : `NOT VALID: ${v.reason} (kept as ${kept}: never copy it to the box)`}\n`);
console.log(`What this consent allows, and how to take it back (enclave-e3's scripts/host-delegation.mjs, verbatim in substance):
  - The host may serve ONLY this owner's deployments whose on-chain options envelope requires
    {"isolation":{"require":"hyperv-partition-per-app"}}, while that host holds the deployment's live lease, and only as
    the raw splice of the app's own TLS (TLS ends in the partition). A deployment that requires snp-guest-per-app, or
    requires nothing, is NEVER served by this host, whatever this delegation says.
  - The host is NOT excluded from the partition (a host-attested boot state, not a TEE); it never receives the
    deployment's secrets, and it is never offered to other tenants.
  - There is no revocation list. The owner's levers: (1) per app, at once: change its isolation.require (setConfig);
    (2) the expiry above; (3) transfer or cancel the deployment. On the host's side, removing the file stops the node
    serving that owner at its next tick (held, not renewed, stopped at lapse) and the relay at the node's next attach.`);
process.exit(v.ok ? 0 : 1);
