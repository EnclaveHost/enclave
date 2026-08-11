#!/usr/bin/env node
// migrate-catalog.mjs — finish an EnclaveAppCatalog migration from a DELEGATED
// key, so the governance wallet signs twice instead of forty times.
//
// Why this exists: a full catalog migration is ~356M gas of storage writes, and
// Base will not mine a transaction over ~15M (measured: 3,569 txs across 30
// blocks, largest included limit 15.0M). There is no batching trick that makes
// it one transaction — the cost is SSTOREs, not overhead. What CAN be reduced
// is the number of times a human touches a hardware wallet, because the import
// functions only require msg.sender == owner. So: lend ownership to a
// throwaway key, let this script grind, take ownership back.
//
//   YOU SIGN (1)   transferOwnership(hotKey)      from the governance wallet
//   this script    acceptOwnership → imports → VERIFY → seal → transferOwnership(gov)
//   YOU SIGN (2)   acceptOwnership()              from the governance wallet
//
// Two signatures, not one: the handoff is deliberately two-step, so taking the
// catalog back is always an explicit act by the receiving wallet. That is a
// safety property, not an oversight.
//
// The risk window is small and bounded: the throwaway key owns an EMPTY,
// UNREFERENCED catalog. It is not in the address book, nothing resolves to it,
// and it holds no funds. The worst a leaked key could do is set approval flags
// or take ownership — and this script re-reads and diffs the ENTIRE target
// against the source before it will seal, so tampering fails the run rather
// than shipping. If verification is not perfect, it does not seal. Ever.
//
// Reuses the admin console's own read/plan/verify (site/components/admin-console/
// migrate.js) so this path and the browser path cannot drift apart.
//
// Usage:
//   node scripts/migrate-catalog.mjs --source 0x… --target 0x… --key-file hot.key \
//        [--governance 0x…] [--rpc URL] [--no-seal] [--dry-run]
//
//   --key-file    holds the throwaway private key; CREATED (0600) if absent
//   --no-seal     import + verify, but leave imports open
//   --dry-run     plan and print, send nothing

import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const ABI = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/EnclaveAppCatalog.abi.json"), "utf8"));

// Base mines nothing above ~15M; asking for more is accepted by some RPCs and
// then silently never included. Keep every send inside it.
const MAX_TX_GAS = 15_000_000n;

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const SOURCE = flag("--source");
const TARGET = flag("--target");
const KEYFILE = flag("--key-file", path.join(REPO, "migrate-hot.key"));
const GOVERNANCE = flag("--governance");
const RPC = flag("--rpc", "https://mainnet.base.org");
const SEAL = !has("--no-seal");
const DRY = has("--dry-run");

const die = (m) => { console.error("error: " + m); process.exit(1); };
const say = (m) => console.log(m);
if (!/^0x[0-9a-fA-F]{40}$/.test(SOURCE || "")) die("--source must be the OLD catalog address");
if (!/^0x[0-9a-fA-F]{40}$/.test(TARGET || "")) die("--target must be the NEW catalog address");
if (GOVERNANCE && !/^0x[0-9a-fA-F]{40}$/.test(GOVERNANCE)) die("--governance must be an address");

/* ---- the throwaway key ---------------------------------------------------- */
let pk;
if (fs.existsSync(KEYFILE)) {
  pk = fs.readFileSync(KEYFILE, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) die(`${KEYFILE} does not contain a 0x private key`);
} else {
  pk = generatePrivateKey();
  fs.writeFileSync(KEYFILE, pk + "\n", { mode: 0o600 });
  say(`generated a throwaway key -> ${KEYFILE} (0600)`);
}
const hot = privateKeyToAccount(pk);
// never print pk; the address is the only part that should ever be quotable
say(`hot key    ${hot.address}`);
say(`source     ${SOURCE}`);
say(`target     ${TARGET}`);

const pub = createPublicClient({ chain: base, transport: http(RPC, { retryCount: 6 }) });
const wallet = createWalletClient({ account: hot, chain: base, transport: http(RPC, { retryCount: 6 }) });

const read = (fn, args = []) => pub.readContract({ address: TARGET, abi: ABI, functionName: fn, args });

/* ---- preconditions -------------------------------------------------------- */
const [srcRev, tgtRev] = await Promise.all([
  pub.readContract({ address: SOURCE, abi: ABI, functionName: "catalogSchema" }).catch(() => 0n),
  read("catalogSchema").catch(() => 0n),
]);
say(`schema     source rev ${srcRev} -> target rev ${tgtRev}`);
if (tgtRev < 4n) die("target is not a config-carrying catalog");
if (await read("importsSealed")) die("target's imports are already SEALED - nothing can be imported into it");

const owner = await read("owner");
const pending = await read("pendingOwner").catch(() => "0x0000000000000000000000000000000000000000");
const eq = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();

if (!eq(owner, hot.address)) {
  if (eq(pending, hot.address)) {
    say(`accepting ownership (governance handed it over)…`);
    if (DRY) say("  [dry-run] would call acceptOwnership()");
    else {
      const h = await wallet.writeContract({ address: TARGET, abi: ABI, functionName: "acceptOwnership" });
      await pub.waitForTransactionReceipt({ hash: h });
      say(`  ✓ ${h}`);
    }
  } else if (DRY) {
    say(`note: the target is owned by ${owner}; a real run needs ownership handed over first`);
  } else {
    die(`the target is owned by ${owner} and this key is not pendingOwner.\n`
      + `  Sign this from the governance wallet first:\n`
      + `    transferOwnership(${hot.address})  on  ${TARGET}\n`
      + `  calldata: ${encodeFunctionData({ abi: ABI, functionName: "transferOwnership", args: [hot.address] })}`);
  }
}

const bal = await pub.getBalance({ address: hot.address });
say(`hot balance ${(Number(bal) / 1e18).toFixed(5)} ETH`);
if (bal === 0n && !DRY) die(`fund ${hot.address} with a little Base ETH (~$5 covers a full catalog) and re-run`);

/* ---- plan, using the console's own engine so the two cannot drift ---------- */
const MIG = await import(path.join(REPO, "site/components/admin-console/migrate.js"));
say("reading source…");
const data = await MIG.MIG_KINDS.catalog.read(SOURCE);
const srcVersions = data.reduce((n, a) => n + a.versions.length, 0);
say(`  ${data.length} apps / ${srcVersions} versions`);
say("reading target to plan the delta…");
const have = await MIG.MIG_KINDS.catalog.read(TARGET);
const txs = MIG.MIG_KINDS.catalog.plan(data, have, {});
say(`${txs.length} transaction${txs.length === 1 ? "" : "s"} to send`);

if (DRY) {
  for (const [i, t] of txs.entries())
    say(`  [${i + 1}] ${t.label}  est ${(t.gas / 1e6).toFixed(1)}M  ${(t.dataHex.length - 2) / 2}B`);
  say("[dry-run] nothing sent");
  process.exit(0);
}

/* ---- send, sequentially, with our own nonce ------------------------------- */
// One sender, one script, no wallet in the loop: track the nonce locally rather
// than re-asking (the races that plagued the browser path come from two parties
// disagreeing about it).
let nonce = await pub.getTransactionCount({ address: hot.address });
for (const [i, t] of txs.entries()) {
  let gas;
  try {
    gas = await pub.estimateGas({ account: hot.address, to: TARGET, data: t.dataHex });
    gas = gas + gas / 4n;
  } catch (_) {
    gas = BigInt(Math.round(t.gas * 1.25));      // estimator refused (over its cap): trust the model
  }
  if (gas > MAX_TX_GAS) gas = MAX_TX_GAS;
  process.stdout.write(`[${i + 1}/${txs.length}] ${t.label} … `);
  const hash = await wallet.sendTransaction({ to: TARGET, data: t.dataHex, gas, nonce: nonce++ });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success") die(`\n  reverted: ${hash}`);
  console.log(`✓ ${(Number(rc.gasUsed) / 1e6).toFixed(1)}M gas`);
}

/* ---- verify EVERYTHING before sealing ------------------------------------- */
// This is the whole safety argument for delegating: the seal is irreversible,
// so it happens only behind a field-by-field diff of the entire target against
// the source. Anything short of perfect aborts with the imports still open.
say("verifying the target field-by-field against the source…");
const v = await MIG.MIG_KINDS.catalog.verify(data, TARGET);
say(`  ${v.ok}/${v.total} apps verified`);
if (v.bad.length) {
  say(`  MISMATCHED: ${v.bad.join(", ")}`);
  die("verification FAILED - not sealing. Imports stay open; re-run to fill gaps, or investigate.");
}
const after = await MIG.MIG_KINDS.catalog.read(TARGET);
const tgtVersions = after.reduce((n, a) => n + a.versions.length, 0);
if (after.length !== data.length || tgtVersions !== srcVersions)
  die(`count mismatch: target holds ${after.length} apps / ${tgtVersions} versions, source has ${data.length} / ${srcVersions} - not sealing`);
say(`  ✓ ${after.length} apps / ${tgtVersions} versions match the source exactly`);

if (SEAL) {
  say("sealing imports (irreversible)…");
  const h = await wallet.writeContract({ address: TARGET, abi: ABI, functionName: "sealImports", nonce: nonce++ });
  await pub.waitForTransactionReceipt({ hash: h });
  say(`  ✓ ${h}`);
} else {
  say("imports left OPEN (--no-seal)");
}

/* ---- hand it back --------------------------------------------------------- */
if (GOVERNANCE) {
  say(`handing ownership to ${GOVERNANCE}…`);
  const h = await wallet.writeContract({ address: TARGET, abi: ABI, functionName: "transferOwnership",
                                         args: [GOVERNANCE], nonce: nonce++ });
  await pub.waitForTransactionReceipt({ hash: h });
  say(`  ✓ ${h}`);
  say("");
  say("LAST STEP — sign this from the governance wallet to take the catalog back:");
  say(`  to:       ${TARGET}`);
  say(`  calldata: ${encodeFunctionData({ abi: ABI, functionName: "acceptOwnership" })}`);
  say("");
  say("until it accepts, the throwaway key is still owner - do not discard the key file yet.");
} else {
  say("no --governance given: ownership stays with the throwaway key (pass it to hand back)");
}

const left = await pub.getBalance({ address: hot.address });
say(`hot key balance left: ${(Number(left) / 1e18).toFixed(5)} ETH  (sweep it back once ownership is accepted)`);
