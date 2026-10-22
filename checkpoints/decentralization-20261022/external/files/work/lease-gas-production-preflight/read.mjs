// Read-only production preparation. No wallet client, signer, broadcast or funding destination.
import fs from "node:fs";
import crypto from "node:crypto";
import {
  createPublicClient, http, keccak256, encodeDeployData, formatEther, parseAbi,
} from "../enclave/node_modules/viem/_esm/index.js";

const root = "/home/steven/Documents/Codex/2026-10-18/wo";
const gas = `${root}/work/app-lease-gas`;
const owner = "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61";
const book = "0xab214342d5a490150a4a977063a2f88e21f80907";
const oracle = "0x420000000000000000000000000000000000000F";
const calibration = JSON.parse(fs.readFileSync(`${gas}/fixtures/base-fork-calibration-recalibrated.json`));
const { ledger, registry, limits } = calibration.deployment;
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const artifacts = {};
const provenance = {};
const reviewed = JSON.parse(fs.readFileSync(`${root}/outputs/storage-adapter-incident/lease-fee-calibration-review.json`));
for (const name of ["EnclaveLeaseGasReserve", "EnclaveLeaseExecutor"]) {
  const source = fs.readFileSync(`${gas}/contracts/${name}.sol`);
  if (reviewed.sourceHashes[`${name}.sol`] !== sha(source))
    throw Error(`${name}: source differs from accepted fork calibration`);
  const copied = fs.readFileSync(`${gas}/forge/src/${name}.sol`);
  if (!source.equals(copied)) throw Error(`${name}: source/copy mismatch`);
  const raw = fs.readFileSync(`${gas}/forge/out/${name}.sol/${name}.json`);
  const a = JSON.parse(raw);
  const metadata = typeof a.metadata === "string" ? JSON.parse(a.metadata) : a.metadata;
  if (metadata.sources[`src/${name}.sol`].keccak256 !== keccak256(source))
    throw Error(`${name}: compiled artifact source mismatch`);
  artifacts[name] = a;
  provenance[name] = {
    sourceSha256: sha(source), artifactSha256: sha(raw),
    creationCodeSha256: sha(Buffer.from(a.bytecode.object.slice(2), "hex")),
    compiler: metadata.compiler, settings: metadata.settings,
  };
}
const endpoints = ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];
const clients = endpoints.map(url => createPublicClient({ transport: http(url, { timeout: 15000, retryCount: 0 }) }));
const heads = await Promise.all(clients.map(c => c.getBlockNumber({ cacheTime: 0 })));
const blockNumber = heads.reduce((a,b) => a < b ? a : b) - 2n;
const expected = {
  ledger: "0x71d50076336283e774ba2ef8d5cbf7602e9cdc5dd918a7e7390c743367766682",
  registry: "0x39911d6f53959c610b9108bb906fc36ea8f57016c4b2571b5cd52c9c32a6f518",
};
const reserve = artifacts.EnclaveLeaseGasReserve;
const data = encodeDeployData({ abi: reserve.abi, bytecode: reserve.bytecode.object,
  args: [ledger, registry, oracle, { ...limits, maxGasPriceCeiling: BigInt(limits.maxGasPriceCeiling) }] });
const reads = await Promise.all(clients.map(async (c,i) => {
  const [chainId, block, balance, nonce, ledgerCode, registryCode, admin, estimatedGas, priority] = await Promise.all([
    c.getChainId(), c.getBlock({ blockNumber }), c.getBalance({ address: owner, blockNumber }),
    c.getTransactionCount({ address: owner, blockNumber }),
    c.getCode({ address: ledger, blockNumber }), c.getCode({ address: registry, blockNumber }),
    c.readContract({ address: book, abi: parseAbi(["function owner() view returns(address)"]), functionName: "owner", blockNumber }),
    c.estimateGas({ account: owner, data, value: 0n, blockNumber }),
    c.estimateMaxPriorityFeePerGas(),
  ]);
  const codeHashes = { ledger: keccak256(ledgerCode), registry: keccak256(registryCode) };
  if (chainId !== 8453 || admin.toLowerCase() !== owner.toLowerCase() ||
      codeHashes.ledger !== expected.ledger || codeHashes.registry !== expected.registry)
    throw Error(`Unexpected authority/code on ${endpoints[i]}`);
  return { rpc: endpoints[i], chainId, blockNumber, blockHash: block.hash, timestamp: block.timestamp,
    ownerBalanceWei: balance, ownerBalanceETH: formatEther(balance), nonce, admin, codeHashes,
    reserveCreationGasEstimate: estimatedGas, baseFeePerGas: block.baseFeePerGas, priorityFeePerGas: priority };
}));
for (const key of ["blockHash", "ownerBalanceWei", "nonce"])
  if (reads[0][key] !== reads[1][key]) throw Error(`RPC disagreement: ${key}`);
const result = {
  checkedAt: new Date().toISOString(), scope: "READ ONLY; no deployed reserve address and no signable funding request",
  owner, originalLedger: ledger, originalRegistry: registry, oracle, limits,
  provenance, reads, reserveCreationCalldataSha256: sha(Buffer.from(data.slice(2), "hex")),
  caveats: [
    "Reserve-only eth_estimateGas is not the complete deployment/relay/app funding cost.",
    "Executor deployment and binding require the actual verified reserve address.",
    "Fees, balance and nonce must be refreshed before wallet signing.",
    "Existing fork-local addresses are never funding destinations.",
    "Runtime recovery regression and final release integration remain pending.",
  ],
};
fs.writeFileSync(`${root}/outputs/app-lease-gas-review/production-funding-preflight.json`,
  JSON.stringify(result, (_,v) => typeof v === "bigint" ? String(v) : v, 2) + "\n");
// Keep this preparation in work/, outside wallet request queues and user-facing outputs.
// Deliberately omit nonce and fee fields: it cannot be treated as a ready-to-sign request.
fs.writeFileSync(`${root}/work/lease-gas-production-preflight/reserve-creation-draft.json`, JSON.stringify({
  status: "DRAFT — DO NOT SUBMIT; composed runtime validation and final activation review pending",
  chainId: 8453, from: owner, action: "contract creation", value: "0", creationData: data,
  dataSha256: result.reserveCreationCalldataSha256,
  reviewedSourceSha256: provenance.EnclaveLeaseGasReserve.sourceSha256,
  constructor: { ledger, registry, oracle, limits },
  nextSteps: [
    "Revalidate source/artifacts, original contract bindings, current nonce and live fees.",
    "Obtain owner wallet approval for the exact reserve creation request.",
    "Verify the receipt, runtime including immutable bindings and administrator.",
    "Prepare the executor creation against that verified reserve, then bind it once.",
    "Publish a reviewed production record only after all on-chain checks pass.",
    "Prepare app-specific deposits and enrollment; never send to fork-local addresses.",
  ],
}, null, 2) + "\n");
console.log(JSON.stringify({ checkedAt: result.checkedAt, block: String(blockNumber),
  balanceETH: reads[0].ownerBalanceETH, reserveGasEstimates: reads.map(r => String(r.reserveCreationGasEstimate)),
  noTransactionsSent: true }));
