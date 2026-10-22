#!/usr/bin/env node
// The CID-only delegate's release step (unattended: CI runs it after mirroring a release). It can do one thing:
// ReleaseAnchor.publish(cid, expectedSeq). It has no access to the publisher's config, secrets or key.
//
//   node scripts/anchor-release.mjs state   --rpc URL --contract 0x…
//   node scripts/anchor-release.mjs publish --rpc URL --contract 0x… --cid bafy… \
//        --keystore PATH --password-file PATH [--gateway URL]... [--min-gateways N] [--max-car-bytes N]
//
// Before publishing, the COMPLETE content of the CID must be retrievable from at least --min-gateways of the
// --gateway URLs (default: all of them): each gateway's `?format=car` export is read with site-release's verifier
// (scripts/site-release/car.mjs readCar: every block hashes to its CID, every block is reachable from the root, every
// file of the UnixFS tree reassembles from blocks present in the CAR), bounded by --max-car-bytes. A gateway that
// serves the root but misses any child counts as unavailable. This is an availability check on replicated storage,
// not an authority.
// The one --rpc here is not trusted either: the contract's compare-and-swap makes a stale view fail, never move
// the anchor backwards. The key never appears on a command line (cast reads the keystore and password file).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// site-release's CAR verifier: <repo>/scripts/site-release (repository layout: tools/ipns-release-anchor/scripts),
// or the workspace's sibling checkout (work/ipns-release-anchor/scripts -> work/enclave)
const HERE = dirname(fileURLToPath(import.meta.url));
const CAR_MODULE = [join(HERE, "../../../scripts/site-release/car.mjs"), join(HERE, "../../enclave/scripts/site-release/car.mjs")].find((f) => existsSync(f));
const DEFAULT_MAX_CAR_BYTES = 512 * 1024 * 1024;

const STATE_SIG = "state()(bytes32,bytes32,uint64,string,address,address,uint64,bool,address)";

function args(argv) {
  const out = { gateway: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) { (out._ ??= []).push(k); continue; }
    const name = k.slice(2);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${k} needs a value`);
    if (name === "gateway") out.gateway.push(v); else out[name] = v;
  }
  return out;
}

function base32decode(s) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, acc = 0;
  const out = [];
  for (const c of s) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error("cid: not base32-lower");
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return Buffer.from(out);
}

function varint(buf, i) {
  let v = 0, shift = 0;
  for (;;) {
    const b = buf[i++];
    if (b === undefined) throw new Error("cid: truncated varint");
    v += (b & 0x7f) * 2 ** shift; shift += 7;
    if (!(b & 0x80)) return [v, i];
  }
}

/** The CIDv1's sha2-256 digest (the only hash the site release produces). */
export function cidDigest(cid) {
  if (!/^b[a-z2-7]{7,127}$/.test(cid)) throw new Error("cid must be a base32 CIDv1 (b…)");
  const bytes = base32decode(cid.slice(1));
  let [version, i] = varint(bytes, 0);
  if (version !== 1) throw new Error("cid: not CIDv1");
  [, i] = varint(bytes, i); // codec
  let code, len;
  [code, i] = varint(bytes, i);
  [len, i] = varint(bytes, i);
  if (code !== 0x12 || len !== 32 || bytes.length !== i + 32) throw new Error("cid: not a sha2-256 multihash");
  return bytes.subarray(i);
}

/** "ok" only when the gateway's CAR export holds the whole DAG under `cid`, verified; else the reason. */
export async function completeAt(gateway, cid, { maxBytes = DEFAULT_MAX_CAR_BYTES, timeoutMs = 300_000 } = {}) {
  if (!CAR_MODULE) return "site-release's CAR verifier (scripts/site-release/car.mjs) is not available";
  const { readCar } = await import(pathToFileURL(CAR_MODULE).href);
  try {
    const r = await fetch(`${gateway.replace(/\/$/, "")}/ipfs/${cid}?format=car`, {
      headers: { accept: "application/vnd.ipld.car" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status !== 200) return `HTTP ${r.status}`;
    const chunks = [];
    let n = 0;
    for await (const c of r.body) { n += c.length; if (n > maxBytes) return `CAR over ${maxBytes} bytes`; chunks.push(c); }
    const car = readCar(Buffer.concat(chunks), { expectRoot: cid });
    return car.files.length ? "ok" : "the DAG holds no files";
  } catch (e) {
    return String(e?.message ?? e).slice(0, 120);
  }
}

export function readState(rpc, contract) {
  const out = execFileSync("cast", ["call", "--rpc-url", rpc, contract, STATE_SIG], { encoding: "utf8" }).trim().split("\n");
  const [schema, nameHash, seq, cid, owner, delegate, delegateUntil, retired, successor] = out.map((l) => l.trim());
  return {
    schema, nameHash, seq: Number(seq.split(" ")[0]), cid: JSON.parse(cid), owner, delegate,
    delegateUntil: Number(delegateUntil.split(" ")[0]), retired: retired === "true", successor,
  };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (!a.rpc || !a.contract) throw new Error("--rpc and --contract are required");
  const before = readState(a.rpc, a.contract);
  if (cmd === "state") return console.log(JSON.stringify(before, null, 2));
  if (cmd !== "publish") throw new Error("usage: state | publish");
  if (!a.cid || !a.keystore || !a["password-file"]) throw new Error("publish needs --cid, --keystore and --password-file");
  cidDigest(a.cid); // shape check: a base32 CIDv1 with a sha2-256 multihash
  const need = Number(a["min-gateways"] ?? a.gateway.length);
  if (!(need >= 1)) throw new Error("--min-gateways must be at least 1");
  const maxBytes = Number(a["max-car-bytes"] ?? DEFAULT_MAX_CAR_BYTES);
  const checks = await Promise.all(a.gateway.map(async (g) => [new URL(g).host, await completeAt(g, a.cid, { maxBytes })]));
  const ok = checks.filter(([, r]) => r === "ok").length;
  if (ok < need) {
    console.log(JSON.stringify({ published: false, reason: `available at ${ok} of the required ${need} gateways`, checks }));
    process.exit(3);
  }
  if (before.retired) throw new Error("the anchor is retired");
  if (before.cid === a.cid) return console.log(JSON.stringify({ published: false, reason: "already current", seq: before.seq, checks }));
  const receipt = JSON.parse(execFileSync("cast", [
    "send", "--json", "--rpc-url", a.rpc, "--keystore", a.keystore, "--password-file", a["password-file"],
    a.contract, "publish(string,uint64)", a.cid, String(before.seq),
  ], { encoding: "utf8" }));
  if (receipt.status !== "0x1") throw new Error(`publish reverted (tx ${receipt.transactionHash})`);
  console.log(JSON.stringify({ published: true, seq: before.seq + 1, cid: a.cid, tx: receipt.transactionHash, block: Number(receipt.blockNumber), checks }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`anchor-release: ${e.message}`); process.exit(1); });
}
