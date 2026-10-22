// UNSIGNED enrollment / funding plan for the existing self-hosted apps (design B). Reads only local files:
//   - outputs/storage-adapter-incident/self-hosted-inventory.json (root's read-only quorum inventory),
//   - fixtures/base-fee-snapshot.json (read-only Base fees, ledger leaseSec, ETH/USD at one block),
//   - fixtures/representative-txs.json (receipt-measured gas of the design-B operations).
// Writes plans/ten-app-enrollment.json. Nothing is signed or sent; it contacts no network.
// usage: node scripts/enrollment-plan.mjs   (cwd work/app-lease-gas)
import fs from "node:fs";
import crypto from "node:crypto";
import { encodeFunctionData, encodeDeployData, keccak256 } from "viem";

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const INV = "../../outputs/storage-adapter-incident/self-hosted-inventory.json";
const SNAP = "fixtures/base-fee-snapshot.json", TXS = "fixtures/representative-txs.json";
const inv = JSON.parse(fs.readFileSync(INV, "utf8")), snap = JSON.parse(fs.readFileSync(SNAP, "utf8")), txs = JSON.parse(fs.readFileSync(TXS, "utf8"));
const art = (file, name) => JSON.parse(fs.readFileSync(`forge/out/${file}/${name}.json`, "utf8"));
const reserveArt = art("EnclaveLeaseGasReserve.sol", "EnclaveLeaseGasReserve"), execArt = art("EnclaveLeaseExecutor.sol", "EnclaveLeaseExecutor");

// ---- the cost basis (ILLUSTRATIVE: one block's fees and price; not a forecast) ---------------------------------------
const gasOf = (label) => BigInt(txs.economics.find((e) => e.label === label).gasUsed);
const l1Of = (label) => BigInt(snap.l1[`B:${label}`].l1FeeWei);
const fee = BigInt(snap.baseFeePerGas) + BigInt(Object.values(snap.maxPriorityFeePerGasByRpc)[0]);
const leaseSec = Number(snap.ledger.leaseSec);
const ethUsd8 = BigInt(snap.ethUsd.answer);
const RENEW_WINDOW = 300, MARGIN = 15;
const renewPeriod = leaseSec - (RENEW_WINDOW - MARGIN);                   // rate 0: each renew sets leaseUntil = now + leaseSec
const renewsPerDay = 86400 / renewPeriod;
const renewWei = gasOf("renew(rate0)") * fee + l1Of("renew(rate0)");
const claimAuthWei = gasOf("claim(rate0)+auth") * fee + l1Of("claim(rate0)+auth");
const releaseWei = gasOf("release") * fee + l1Of("release");
const perDayWei = BigInt(Math.round(renewsPerDay * Number(renewWei)));
const usd = (wei) => Number(wei * ethUsd8 / 10n ** 18n) / 1e8;

// ---- the owner's per-app configuration ---------------------------------------------------------------------------------
const MAX_GAS_PRICE = 50_000_000n;                                       // 0.05 gwei: ~8x the snapshot's effective fee
const WORST_OP_GAS = 340_000n;                                           // claim + 7702 authorization, measured 290-327k
const L1_UPPER = BigInt(snap.l1["B:claim+auth"].upperBoundWei);
const maxPerOpWei = WORST_OP_GAS * MAX_GAS_PRICE + L1_UPPER;
const policy = { enabled: true, claimPolicy: 1 /* the owner's own boxes: registry payoutWallet == owner */, sponsorRelease: true,
  maxClaimsPerEpoch: 4, maxPerOpWei, epochCapWei: maxPerOpWei * 10n, epochSec: 3600, renewWindow: RENEW_WINDOW, minExtension: 600,
  claimCooldown: leaseSec, maxGasPrice: MAX_GAS_PRICE };
const DEPOSIT_WEI = 3_000_000_000_000_000n;                              // 0.003 ETH per app
const L1_BPS = 6500;                                                     // measured actual/upper-bound L1 ratio 0.61-0.72

const limits = { maxGasPriceCeiling: 1_000_000_000n, overheadClaimGas: 29_500, overheadRenewGas: 24_000, overheadReleaseGas: 7_000,
  minClaimInterval: 60, l1Bps: L1_BPS };
const LEDGER = inv.ledger, REGISTRY = inv.registry, L1ORACLE = "0x420000000000000000000000000000000000000F";
const reserveCreate = encodeDeployData({ abi: reserveArt.abi, bytecode: reserveArt.bytecode.object, args: [LEDGER, REGISTRY, L1ORACLE, limits] });

const apps = inv.selfHostedDeployments.map((d) => ({
  id: d.id, appRef: d.appRef, ownerAtInventory: d.owner, runner: d.runner, operator: d.operator, leaseUntil: d.leaseUntil, liveLeaseAtInventory: d.liveLease,
  rate6: d.rate6, balance6_notFunding: d.balance6, ownerEscrow6: d.ownerEscrow6, ownerMatchesHostPayout: d.ownerMatchesHostPayout,
  unsignedOwnerTxs: [
    { step: "deposit the gas reserve (the owner's own ETH; nothing moves out of the ledger)", from: d.owner, to: "<EnclaveLeaseGasReserve>",
      value: DEPOSIT_WEI.toString(), data: encodeFunctionData({ abi: reserveArt.abi, functionName: "deposit", args: [d.id] }) },
    { step: "enable sponsorship with the owner's policy (self-hosted claimants only; release sponsored)", from: d.owner, to: "<EnclaveLeaseGasReserve>",
      value: "0", data: encodeFunctionData({ abi: reserveArt.abi, functionName: "configure", args: [d.id, policy] }) },
  ],
}));

const plan = {
  title: "Design B (EnclaveLeaseGasReserve + EnclaveLeaseExecutor): unsigned enrollment and funding plan for the existing self-hosted apps",
  status: "PLAN ONLY - nothing deployed, signed or sent. Re-read every owner, lease and fee at signing time.",
  inputs: { inventory: { file: "outputs/storage-adapter-incident/self-hosted-inventory.json", sha256: sha(INV), block: inv.block, agreeingRpcs: inv.agreeing },
            feeSnapshot: { file: "work/app-lease-gas/fixtures/base-fee-snapshot.json", sha256: sha(SNAP), block: snap.block, at: snap.at },
            measuredGas: { file: "work/app-lease-gas/fixtures/representative-txs.json", sha256: sha(TXS) } },
  admin: {
    signer: "the platform admin / governance wallet (deployer of record); NOT a host, NOT an app",
    steps: [
      { step: "deploy EnclaveLeaseGasReserve(ledger, registry, Base GasPriceOracle, limits)", constructorArgs: { ledger: LEDGER, registry: REGISTRY, l1Oracle: L1ORACLE,
        limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v.toString()])) }, creationDataKeccak: keccak256(reserveCreate), creationBytes: (reserveCreate.length - 2) / 2 },
      { step: "deploy EnclaveLeaseExecutor(<EnclaveLeaseGasReserve>)", creationCodeKeccak: keccak256(execArt.bytecode.object) },
      { step: "bindExecutor(<EnclaveLeaseExecutor>) on the reserve (one time; no later change possible)", calldataTemplate: "bindExecutor(address)" },
      { step: "optional: publish both addresses in the address book / pins after review (an admin binding change; not part of this plan)" },
    ],
    adminCanNot: "withdraw or redirect any reserve; it can pause, block a deployment or operator, set bounded limits",
  },
  owner: {
    signer: apps[0].ownerAtInventory, note: "all 10 records are EOA-owned by this address at the inventory block; 2 transactions per app (20 total)",
    depositPerAppWei: DEPOSIT_WEI.toString(), policy: Object.fromEntries(Object.entries(policy).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
    totalDepositWei: (DEPOSIT_WEI * BigInt(apps.length)).toString(),
  },
  hosts: [...new Set(apps.map((a) => a.operator))].map((op) => ({
    operator: op, apps: apps.filter((a) => a.operator === op).map((a) => ({ id: a.id, liveLeaseAtInventory: a.liveLeaseAtInventory })),
    linux: { env: { LEASE_GAS_RESERVE: "<EnclaveLeaseGasReserve>", LEASE_GAS_RELAYS: "<relay URL 1>,<relay URL 2>" }, patch: "patches/design-b-supervisor.hunk.patch" },
    windows: { env: { ENCLAVE_LEASE_GAS_RESERVE: "<EnclaveLeaseGasReserve>", ENCLAVE_LEASE_GAS_RELAYS: "<relay URL 1>,<relay URL 2>" },
               patches: ["patches/design-b-windows-chain.hunk.patch", "patches/design-b-windows-host.hunk.patch (heartbeat worker's file)"] },
    signs: "only locally: each Lease, and once its EIP-7702 authorization to the executor (carried in a relay's transaction); no ETH, no transaction of its own",
    rollout: apps.some((a) => a.operator === op && a.liveLeaseAtInventory) ? "has live leases: switch at its own pace; the next renewal after the switch is the first sponsored one; no force-claim of another host's lease"
      : "all its leases expired: after enrollment, the patched host re-claims them (policy 1: only boxes whose payoutWallet is the owner may)",
  })),
  relays: { minimum: 2, who: "any party with a funded key (Enclave may run one; a third party another); each needs a float of about maxPerOpWei x a few in flight",
            software: "network/lease-executor-client.mjs startLeaseRelay (or anyone's equivalent: a plain transaction to the operator's address)" },
  costModelIllustrative: {
    label: `ILLUSTRATIVE: Base block ${snap.block} (${snap.at}); effective fee ${fee} wei/gas (base ${snap.baseFeePerGas} + priority); ETH/USD ${Number(ethUsd8) / 1e8} from the ledger's own feed at that block; gas from local receipts. NOT a forecast.`,
    leaseSec, renewWindowSec: RENEW_WINDOW, renewPeriodSec: renewPeriod, renewsPerDay: Number(renewsPerDay.toFixed(1)),
    perOperationWei: { renewRate0: renewWei.toString(), claimWithAuth: claimAuthWei.toString(), release: releaseWei.toString() },
    perOperationUsd: { renewRate0: usd(renewWei), claimWithAuth: usd(claimAuthWei), release: usd(releaseWei) },
    perAppPerDay: { wei: perDayWei.toString(), usd: usd(perDayWei) },
    tenAppsPerDay: { wei: (perDayWei * 10n).toString(), usd: usd(perDayWei * 10n) },
    depositLastsDaysAtThisFee: Number(DEPOSIT_WEI / perDayWei),
    worstCaseDrainPerAppPerDayAtCaps: { wei: (policy.epochCapWei * 24n).toString(), note: "if every epoch hit its cap at the owner's maxGasPrice (policy 1 limits claimants to the owner's own boxes)" },
  },
  stillUnfunded: [
    "proof-of-time checkpoints and setProofKey (operator transactions; rate-0 apps skip checkpoints, paid apps need them)",
    "claim bonds (claimBond6 is 0 on the live ledger today)",
    "registry registration (one-time; the existing host paymaster sponsors a box's first one) and heartbeats (moving off-chain, another worker's task)",
    "withdrawEarnings (the host's own revenue; rate-0 apps earn nothing)",
  ],
};
fs.mkdirSync("plans", { recursive: true });
fs.writeFileSync("plans/ten-app-enrollment.json", JSON.stringify(plan, null, 1) + "\n");
console.log(JSON.stringify({ apps: apps.length, hosts: plan.hosts.map((h) => [h.operator, h.apps.length]), cost: plan.costModelIllustrative, owner: plan.owner.totalDepositWei }, null, 1));
