#!/usr/bin/env node
// migrate-contract.mjs — move a contract's whole state into a fresh revision
// with ONE governance signature, as a repeatable operation.
//
// Contract migrations are routine here (the catalog and the ledger have both
// been through several revisions), and the browser console makes them cost one
// hardware-wallet confirmation per transaction. A full catalog is ~356M gas of
// SSTOREs and Base mines nothing over ~15M, so that is dozens of approvals. No
// batching fixes it: the cost is the storage, not the overhead.
//
// What fixes it is WHO sends. Every import gates on msg.sender == owner and
// nothing else, so a MIGRATOR identity can own the new contract from birth, do
// all the work unattended, and hand the finished article to governance:
//
//     migrator   deploy -> import -> VERIFY -> seal -> transferOwnership(gov)
//     YOU SIGN   acceptOwnership()      <- the only approval, and the only
//                                          moment governance takes on anything
//
// The migrator never touches a live contract. It owns an unreferenced deploy
// that nothing resolves to until governance accepts it AND the address book is
// pointed at it — both governance-only acts. So the blast radius of the key is
// "a contract nobody uses yet", and the gate is a full field-by-field diff
// against the source that must pass before it will seal.
//
// THE MIGRATOR KEY IS NOT GENERATED AND NOT STORED BY THIS SCRIPT. It is one
// durable identity you fund once and reuse for every migration, supplied as:
//   ENCLAVE_MIGRATOR_KEY=0x…      env var (CI, or a shell you control)
//   --key-file PATH               an existing file (never created here)
//   --derive                      derived from a Trezor signature over a fixed
//                                 string: same address every time, no secret at
//                                 rest, only the device can reproduce it
//
// Reuses the admin console's own read/plan/verify so the two paths cannot drift.
//
// Usage:
//   node scripts/migrate-contract.mjs --kind catalog --source 0x… --governance 0x… --deploy
//   node scripts/migrate-contract.mjs --kind catalog --source 0x… --target 0x… --governance 0x…
//   … --dry-run    plan and print, send nothing (no key needed)
//   … --no-seal    import + verify, leave imports open

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createPublicClient, createWalletClient, http, encodeFunctionData, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
// Base mines nothing above ~15M (measured: 3,569 txs / 30 blocks, largest
// included limit 15.0M). Over that an RPC may accept and the chain never mine.
const MAX_TX_GAS = 15_000_000n;
// Canonical and VERSIONED: the derived migrator address is a function of this
// string, so changing it changes the identity (and orphans its funding).
const DERIVE_MSG = "enclave-migrator:v1";
const TREZOR = path.join(process.env.HOME || "", ".local/share/trezorctl/bin/trezorctl");

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const die = (m) => { console.error("error: " + m); process.exit(1); };
const say = (m) => console.log(m);
const eq = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");

const KIND = flag("--kind", "catalog");
const SOURCE = flag("--source");
const TARGET = flag("--target");
const GOVERNANCE = flag("--governance");
const RPC = flag("--rpc", "https://mainnet.base.org");
const DEPLOY = has("--deploy");
const SEAL = !has("--no-seal");
const DRY = has("--dry-run");

const MIG = await import(path.join(REPO, "site/components/admin-console/migrate.js"));
const { CONTRACTS } = await import(path.join(REPO, "site/js/gen/contract-artifacts.js"));
const kind = MIG.MIG_KINDS[KIND];
if (!kind) die(`--kind must be one of: ${Object.keys(MIG.MIG_KINDS).join(", ")}`);
if (!isAddr(SOURCE)) die("--source must be the OLD contract address");
if (!DEPLOY && !isAddr(TARGET)) die("give --target 0x… or --deploy to create one");
if (DEPLOY && TARGET) die("--deploy and --target are mutually exclusive");
if (GOVERNANCE && !isAddr(GOVERNANCE)) die("--governance must be an address");
if (!DRY && !GOVERNANCE) die("--governance is required: the migrator must hand the result somewhere");

const ART = CONTRACTS[kind.contractName];
const ABI = JSON.parse(fs.readFileSync(path.join(REPO, `contracts/${kind.contractName}.abi.json`), "utf8"));
say(`kind       ${KIND} (${kind.contractName})`);
say(`source     ${SOURCE}`);

/* ---- the migrator identity: supplied, never invented ---------------------- */
function loadMigratorKey() {
  const env = (process.env.ENCLAVE_MIGRATOR_KEY || "").trim();
  if (env) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(env)) die("ENCLAVE_MIGRATOR_KEY is not a 0x + 64 hex private key");
    return env;
  }
  const f = flag("--key-file");
  if (f) {
    if (!fs.existsSync(f)) die(`--key-file ${f} does not exist (this script never creates keys)`);
    const k = fs.readFileSync(f, "utf8").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) die(`${f} does not contain a 0x + 64 hex private key`);
    return k;
  }
  if (has("--derive")) {
    // Deterministic from the device: RFC6979 makes the signature stable, so the
    // same message always yields the same key. Nothing is written to disk, and
    // only the Trezor holder can reproduce it. Same idea the encrypted-volume
    // keys use.
    if (!fs.existsSync(TREZOR)) die(`--derive needs trezorctl at ${TREZOR}`);
    say(`deriving the migrator identity from your Trezor (confirm "${DERIVE_MSG}" on the device)…`);
    let out;
    try {
      out = execFileSync(TREZOR, ["ethereum", "sign-message", "-n", "m/44'/60'/0'/0/0", DERIVE_MSG],
                         { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    } catch (e) { die("trezorctl could not sign (is the device connected and unlocked?)"); }
    const sig = (/signature:?\s*(0x[0-9a-fA-F]{130})/i.exec(out) || [])[1];
    if (!sig) die("could not read a signature out of trezorctl's output");
    return keccak256(sig);
  }
  die("no migrator key. Set ENCLAVE_MIGRATOR_KEY, or pass --key-file PATH, or --derive (Trezor).\n"
    + "  This is ONE durable identity you fund once and reuse for every migration -\n"
    + "  it is deliberately not generated per run.");
}

const pub = createPublicClient({ chain: base, transport: http(RPC, { retryCount: 6 }) });
let hot = null, wallet = null;
if (!DRY) {
  hot = privateKeyToAccount(loadMigratorKey());      // the key itself is never printed or logged
  wallet = createWalletClient({ account: hot, chain: base, transport: http(RPC, { retryCount: 6 }) });
  say(`migrator   ${hot.address}`);
  const bal = await pub.getBalance({ address: hot.address });
  say(`  balance  ${(Number(bal) / 1e18).toFixed(5)} ETH`);
  if (bal === 0n) die(`fund the migrator with a little Base ETH (~$5 covers a full catalog) and re-run`);
}

/* ---- target: adopt, or deploy so the migrator owns it from birth ---------- */
let target = TARGET;
let nonce = DRY ? 0 : await pub.getTransactionCount({ address: hot.address });

if (DEPLOY && !DRY) {
  if (ART.ctor && ART.ctor.length)
    die(`${kind.contractName} takes constructor args ${JSON.stringify(ART.ctor)} - deploy it with its own script and pass --target`);
  say(`deploying a fresh ${kind.contractName}…`);
  const h = await wallet.deployContract({ abi: ABI, bytecode: ART.bytecode, gas: 6_000_000n, nonce: nonce++ });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== "success") die(`deploy reverted: ${h}`);
  target = rc.contractAddress;
  say(`  ✓ ${target}`);
} else if (DEPLOY && DRY) {
  say("[dry-run] would deploy a fresh target");
}
if (target) say(`target     ${target}`);

const read = (fn, args = []) => pub.readContract({ address: target, abi: ABI, functionName: fn, args });

if (target && !DRY) {
  if (await read("importsSealed")) die("target's imports are SEALED - nothing can be imported into it");
  const owner = await read("owner");
  if (!eq(owner, hot.address)) {
    const pending = await read("pendingOwner").catch(() => null);
    if (eq(pending, hot.address)) {
      say("accepting ownership…");
      const h = await wallet.writeContract({ address: target, abi: ABI, functionName: "acceptOwnership", nonce: nonce++ });
      await pub.waitForTransactionReceipt({ hash: h });
      say(`  ✓ ${h}`);
    } else {
      die(`target is owned by ${owner}, not the migrator.\n`
        + `  Either use --deploy (the migrator owns it from birth, and you sign only once),\n`
        + `  or hand this one over first from governance:\n`
        + `    to ${target}\n    calldata ${encodeFunctionData({ abi: ABI, functionName: "transferOwnership", args: [hot.address] })}`);
    }
  }
}

/* ---- plan ----------------------------------------------------------------- */
say("reading source…");
const data = await kind.read(SOURCE);
say(`  ${kind.counts(data)}`);
const have = target ? await kind.read(target) : [];
const txs = kind.plan(data, have, {});
say(`${txs.length} transaction${txs.length === 1 ? "" : "s"} to send`);
if (DRY) {
  for (const [i, t] of txs.entries())
    say(`  [${i + 1}] ${t.label}  est ${(t.gas / 1e6).toFixed(1)}M  ${(t.dataHex.length - 2) / 2}B`);
  say("[dry-run] nothing sent");
  process.exit(0);
}

/* ---- send: one sender, local nonce, measured gas -------------------------- */
for (const [i, t] of txs.entries()) {
  let gas;
  try {
    gas = await pub.estimateGas({ account: hot.address, to: target, data: t.dataHex });
    gas = gas + gas / 4n;
  } catch (_) { gas = BigInt(Math.round(t.gas * 1.25)); }   // estimator over its cap: trust the model
  if (gas > MAX_TX_GAS) gas = MAX_TX_GAS;
  process.stdout.write(`[${i + 1}/${txs.length}] ${t.label} … `);
  const hash = await wallet.sendTransaction({ to: target, data: t.dataHex, gas, nonce: nonce++ });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success") die(`\n  reverted: ${hash}`);
  console.log(`✓ ${(Number(rc.gasUsed) / 1e6).toFixed(1)}M`);
}

/* ---- verify BEFORE sealing ------------------------------------------------ */
// The seal is irreversible and governance is not watching it happen, so it sits
// behind a full diff of the target against the source. Anything less than
// perfect leaves imports OPEN and exits non-zero.
say("verifying the target against the source, field by field…");
const v = await kind.verify(data, target);
say(`  ${v.ok}/${v.total} records verified`);
if (v.bad.length) {
  say(`  MISMATCHED: ${v.bad.join(", ")}`);
  die("verification FAILED - not sealing, imports left open. Re-run to fill gaps, or investigate.");
}

if (SEAL) {
  say("sealing imports (irreversible)…");
  const h = await wallet.writeContract({ address: target, abi: ABI, functionName: "sealImports", nonce: nonce++ });
  await pub.waitForTransactionReceipt({ hash: h });
  say(`  ✓ ${h}`);
} else say("imports left OPEN (--no-seal)");

/* ---- hand it to governance ------------------------------------------------ */
say(`offering ownership to ${GOVERNANCE}…`);
const h = await wallet.writeContract({ address: target, abi: ABI, functionName: "transferOwnership",
                                       args: [GOVERNANCE], nonce: nonce++ });
await pub.waitForTransactionReceipt({ hash: h });
say(`  ✓ ${h}`);
say("");
say("THE ONE SIGNATURE — from the governance wallet:");
say(`  to        ${target}`);
say(`  calldata  ${encodeFunctionData({ abi: ABI, functionName: "acceptOwnership" })}`);
say("");
say("Until it accepts, the migrator still owns the target and nothing references it.");
say(`Then point the address book at ${target} (key: ${ART.bookKey}).`);
