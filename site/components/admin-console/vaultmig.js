/* ============================================================
   Credit-vault factory migration for the admin console.

   Why this exists: EnclaveCreditVault.deployAndFund pins an
   allowlist of EnclaveDeployments.create() SIGNATURES, and the
   implementation behind the live factory is immutable - so a
   ledger revision that reshapes create() (rev 8 grew maxRate6)
   strands every existing vault: the relay encodes the live shape,
   the baked allowlist rejects it, and every credit deploy reverts
   "not create()" (production, 2026-08-03). Recovery is NOT a data
   migration: deploy a current factory, repoint the book, and
   re-mint each customer's vault from the SAME passkey (the P-256
   pubkey is replayed from the old factory's createVault calldata -
   same key, same owner, new CREATE2 address).

   Moving the BALANCE across depends on what minted the old vault.
   Vaults from a factory carrying migrateToSuccessor forward their
   own credit to the successor - no company money, no customer tap.
   Older ones cannot: their only outflow is passkey-signed, so the
   plan fronts the balance from the operator wallet and the
   stranded original is settled out of band.

   The skew probe doubles as a standing alarm: DEP_SEL.create is
   viem-derived from the ledger source at site build time, so the
   moment create() is reshaped again, every console load flags the
   factory whose implementation bytecode no longer contains the
   selector it must allowlist.

   No DOM in this module: it scans, probes and returns ready-to-
   send tx plans; the component drives the wallet and paints
   progress (the migrate.js division of labor).
   ============================================================ */
import { baseRpc, encCall, encUint, pad32, hexBig, DEP_SEL } from "../../js/core/chain.js";
import { USDC_BASE } from "../../js/core/config.js";
import { CONTRACTS } from "../../js/gen/contract-artifacts.js";

const FAC = CONTRACTS.EnclaveCreditVaultFactory;
// USDC + vault-impl selectors, hand-pinned like chain.js's DEP_SEL (the
// implementation and USDC are outside the artifact build; pinned against viem
// in test/admin-console.test.mjs)
export const ERC20_SEL = { balanceOf: "70a08231", transfer: "a9059cbb" };
export const IMPL_SEL = { treasury: "61d027b3" };

const call = (to, data) => baseRpc("eth_call", [{ to, data }, "latest"]);
const asAddr = (word) => "0x" + (word || "").replace(/^0x/, "").slice(-40).padStart(40, "0");
const isZero = (a) => !a || /^0x0{40}$/i.test(a);
const hex = (n) => "0x" + n.toString(16);

export const balanceOf6 = async (holder) =>
  hexBig(await call(USDC_BASE, "0x" + ERC20_SEL.balanceOf + pad32(holder.replace(/^0x/, ""))));

/* Does this factory's implementation speak the LIVE ledger's create()? The
   allowlisted signatures sit in the runtime bytecode as compile-time selector
   constants, so the current create selector appearing in the code is exactly
   the property the wedge broke. (A chance 4-byte collision in 7KB of code is
   ~1e-6, and it errs toward "current" - acceptable for an alarm whose action
   path re-verifies by deploying from the checked-in artifact.) */
export async function vaultImplCurrent(factory) {
  const impl = asAddr(await call(factory, "0x" + FAC.sel.implementation));
  if (isZero(impl)) throw new Error("no implementation() - not a vault factory");
  const code = ((await baseRpc("eth_getCode", [impl, "latest"])) || "0x").toLowerCase();
  return {
    impl,
    current: code.includes(DEP_SEL.create),
    // does this build carry the no-passkey escape hatch? (same
    // selector-as-constant reasoning as the create() probe)
    recovery: code.includes(VAULT_SEL.migrateToSuccessor),
  };
}

/* Every vault the factory ever minted, each with its passkey recovered from
   the createVault(x, y) calldata that made it, plus its live USDC balance.
   The deploy block is found by bisecting eth_getCode so the log scan (public
   RPCs cap eth_getLogs at 10k blocks) covers exactly the factory's lifetime. */
export async function scanVaults(factory, onProgress) {
  const say = onProgress || (() => {});
  const latest = Number(hexBig(await baseRpc("eth_blockNumber", [])));
  say(`bisecting for the factory's deploy block (latest ${latest.toLocaleString()})…`);
  let lo = 0, hi = latest;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const code = await baseRpc("eth_getCode", [factory, hex(mid)]).catch(() => null);
    // a pruned/erroring node reads as "no code yet": the window only ever
    // widens toward genesis, so the scan stays correct, just longer
    if (code && code !== "0x") hi = mid; else lo = mid;
  }
  say(`factory deployed at block ${hi.toLocaleString()} - scanning VaultCreated logs…`);

  const SPAN = 9999, spans = [];
  for (let b = hi; b <= latest; b += SPAN + 1) spans.push([b, Math.min(b + SPAN, latest)]);
  const logs = [];
  for (let i = 0; i < spans.length; i += 5) {
    const batch = spans.slice(i, i + 5);
    const got = await Promise.all(batch.map(([from, to]) =>
      baseRpc("eth_getLogs", [{ address: factory, topics: [FAC.evt.VaultCreated], fromBlock: hex(from), toBlock: hex(to) }])));
    for (const g of got) logs.push(...(g || []));
    say(`  scanned ${Math.min(i + 5, spans.length)}/${spans.length} spans · ${logs.length} vault${logs.length === 1 ? "" : "s"}`);
  }

  const vaults = [];
  for (const l of logs) {
    const vault = asAddr((l.data || "").slice(-64));
    const v = { vault, block: Number(hexBig(l.blockNumber)), txHash: l.transactionHash, x: null, y: null, keyLost: false };
    // the pubkey is the createVault calldata itself: selector + two words.
    // Anything else (a wrapper contract's internal call) can't be replayed -
    // reported, never guessed.
    const tx = await baseRpc("eth_getTransactionByHash", [l.transactionHash]).catch(() => null);
    const input = ((tx && tx.input) || "").toLowerCase();
    if (input.startsWith("0x" + FAC.sel.createVault) && input.length >= 2 + 8 + 128) {
      v.x = "0x" + input.slice(10, 74);
      v.y = "0x" + input.slice(74, 138);
    } else v.keyLost = true;
    v.balance6 = await balanceOf6(vault);
    vaults.push(v);
  }
  return { deployBlock: hi, latest, vaults };
}

/* Can this vault forward its own balance to the successor, no passkey needed?
   True only for vaults minted by a factory built after the 2026-08-03 wedge,
   and only when the operator wallet IS its recoveryAdmin. */
export async function canSelfMigrate(vault, operator) {
  try {
    const admin = asAddr(await call(vault, "0x" + VAULT_SEL.recoveryAdmin));
    return !isZero(admin) && admin.toLowerCase() === String(operator || "").toLowerCase();
  } catch { return false; }   // pre-recovery implementation: no such getter
}

/* The per-vault tx plan against a CURRENT factory. Each funded vault is
   re-minted from its recovered passkey, then its balance is moved across -
   by the vault ITSELF where migrateToSuccessor exists (no company money, no
   customer tap), and otherwise by fronting USDC from the operator wallet, the
   only option for vaults minted before that function did. Derived from live
   chain state on every call, so an interrupted run re-plans as a delta. */
export async function planVaultMigration(vaults, newFactory, operator) {
  const steps = [], skipped = [];
  let front6 = 0n, self6 = 0n;
  for (const v of vaults) {
    if (!(v.balance6 > 0n)) { skipped.push({ ...v, why: "empty - the relay re-mints it free on the customer's next op" }); continue; }
    if (v.keyLost) { skipped.push({ ...v, why: "passkey not recoverable from the creation tx - migrate manually" }); continue; }
    const predicted = asAddr(await call(newFactory, encCall(FAC.sel.vaultFor, [{ t: "uint", v: v.x }, { t: "uint", v: v.y }])));
    const code = (await baseRpc("eth_getCode", [predicted, "latest"])) || "0x";
    if (code === "0x")
      steps.push({ to: newFactory, data: encCall(FAC.sel.createVault, [{ t: "uint", v: v.x }, { t: "uint", v: v.y }]),
        label: `re-mint ${predicted.slice(0, 10)}… (same passkey as ${v.vault.slice(0, 10)}…)` });
    const usd = "$" + (Number(v.balance6) / 1e6).toFixed(2);
    if (await canSelfMigrate(v.vault, operator)) {
      // the successor must exist first - migrateToSuccessor refuses to send
      // credit to an address with no code, so this step follows the re-mint
      steps.push({ to: v.vault, data: encCall(VAULT_SEL.migrateToSuccessor, [{ t: "uint", v: v.x }, { t: "uint", v: v.y }]),
        label: `${v.vault.slice(0, 10)}… forwards its own ${usd} → ${predicted.slice(0, 10)}… (no company funds, no passkey)` });
      self6 += v.balance6;
      continue;
    }
    const have6 = await balanceOf6(predicted);
    const need6 = v.balance6 > have6 ? v.balance6 - have6 : 0n;
    if (need6 > 0n) {
      steps.push({ to: USDC_BASE, data: "0x" + ERC20_SEL.transfer + pad32(predicted.replace(/^0x/, "")) + encUint(need6),
        label: `front $${(Number(need6) / 1e6).toFixed(2)} → ${predicted.slice(0, 10)}… (old vault ${v.vault.slice(0, 10)}… held ${usd}; it predates migrateToSuccessor)` });
      front6 += need6;
    }
    if (code !== "0x" && need6 === 0n) skipped.push({ ...v, why: "already re-minted and fronted - nothing left to do" });
  }
  return { steps, front6, self6, skipped };
}

/* Selectors the console calls straight on a vault clone: the vault is minted
   by its factory, never deployed from here, so there is no deploy artifact to
   read them off. Pinned against the checked-in ABI in
   test/admin-console.test.mjs. */
export const VAULT_SEL = { migrateToSuccessor: "17857979", recoveryAdmin: "5f6529a3", rootKeyHash: "1d3ca5b9" };

/* The old implementation's treasury, carried into the new factory so the
   refund destination never silently moves with a recovery. */
export async function oldTreasury(oldFactory) {
  try {
    const impl = asAddr(await call(oldFactory, "0x" + FAC.sel.implementation));
    if (isZero(impl)) return null;
    const t = asAddr(await call(impl, "0x" + IMPL_SEL.treasury));
    return isZero(t) ? null : t;
  } catch { return null; }
}
