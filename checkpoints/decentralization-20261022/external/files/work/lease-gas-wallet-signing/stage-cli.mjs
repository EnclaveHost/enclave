import {clientsFor} from './rpc-clients.mjs';
// Read-only CLI for stages 2 and 3 (no wallet, no key, no broadcast). Outputs are new files only (never overwritten).
//   node stage-cli.mjs check-artifacts
//   node stage-cli.mjs prepare-executor --reserve-request F --reserve-hash 0x… --out NEW.json
//   node stage-cli.mjs verify-executor  --request F --hash 0x… --out NEW.json
//   node stage-cli.mjs prepare-bind     --reserve-request F --reserve-hash 0x… --executor-request F --executor-hash 0x… --out NEW.json
//   node stage-cli.mjs verify-bind      --request F --hash 0x… --out NEW.json
// --reserve-request is the request root's step-1 handoff journaled (its "request" field); --reserve-hash the hash the
// wallet returned for it. Both are verified on chain again here; no "verified" file is accepted as evidence.
import fs from "node:fs";
import { createPublicClient, http } from "../enclave/node_modules/viem/_esm/index.js";
import { verifiedArtifacts } from "./artifacts.mjs";
import { PRODUCTION } from "./trust.mjs";
import { prepareExecutorRequest, verifyExecutor, prepareBindRequest, verifyBinding } from "./stages.mjs";

const [cmd, ...rest] = process.argv.slice(2), o = {};
for (let i = 0; i < rest.length; i += 2) { if (!rest[i].startsWith("--") || rest[i + 1] === undefined) throw Error(`bad argument ${rest[i]}`); o[rest[i].slice(2)] = rest[i + 1]; }
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const unwrap = (x) => (x && x.request && x.status ? x.request : x);           // a journal file or the bare request
const write = (v) => { if (!o.out) throw Error("--out NEW.json is required"); fs.writeFileSync(o.out, JSON.stringify(v, (_k, x) => typeof x === "bigint" ? String(x) : x, 2) + "\n", { flag: "wx", mode: 0o600 }); };
const trust = PRODUCTION, artifacts = verifiedArtifacts({ trust });
const clients = clientsFor(trust.rpcs);
const receiptClients = clientsFor(['https://base-mainnet.public.blastapi.io','https://mainnet.base.org']);
let r;
if (cmd === "check-artifacts") r = Object.fromEntries(Object.entries(artifacts).map(([k, v]) => [k, v.provenance]));
else if (cmd === "prepare-executor") write(r = await prepareExecutorRequest({ trust, artifacts, reserveRequest: unwrap(json(o["reserve-request"])), reserveHash: o["reserve-hash"], clients, receiptClients }));
else if (cmd === "verify-executor") write(r = await verifyExecutor({ trust, request: unwrap(json(o.request)), hash: o.hash, clients, receiptClients }));
else if (cmd === "prepare-bind") write(r = await prepareBindRequest({ trust, artifacts, reserveRequest: unwrap(json(o["reserve-request"])), reserveHash: o["reserve-hash"],
  executorRequest: unwrap(json(o["executor-request"])), executorHash: o["executor-hash"], clients, receiptClients }));
else if (cmd === "verify-bind") write(r = await verifyBinding({ trust, request: unwrap(json(o.request)), hash: o.hash, clients, receiptClients }));
else throw Error("usage: see the header of stage-cli.mjs");
console.log(JSON.stringify(cmd === "check-artifacts" ? r : { status: r.status, file: o.out, expiresAt: r.expiresAt, nonce: r.transaction?.nonce, value: "0 ETH" }));
