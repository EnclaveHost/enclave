// The contract-pins file root passes to the EXISTING CLI (`enclave --independent --contract-pins FILE …`) for the canary's
// CLI steps, reconciled against the chain before any of them may run (ROOT-LEDGER-REVIEW). Pure: the caller reads the
// facts at one agreed block.
//
// Why: the CLI's baked default ledger is the RETIRED 0xF9e71385… (cli/enclave.mjs DEFAULTS). The original vault 0xE486
// reads deployments through its book 0xab21…, whose "deployments" entry is ledger rev16d 0xB1783B61… (live-custody.json
// block 52849851; known-state.json block 52994819). A deployment created on any other ledger can never get a custody
// release. The CLI falls back to the baked addresses with only a warning when its book read fails, and in independent
// mode it uses whatever pins file it is given without comparing it to the book. The tracked contracts/deployments/
// contract-pins-base.json and the reviewed network profile also name secretVaultV2 = 0x56b81b39… (the MODIFIED vault),
// not the original 0xE486.
import { createHash } from "node:crypto";

export const BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907";
export const RETIRED_LEDGER = "0xf9e71385c5cb49844f2457ba6567de0742f8b89a";
export const MODIFIED_VAULT_V2 = "0x56b81b3970a8ac2c52f9874bd2758ede30758228";
// runtime code hashes from work/enclave contracts/deployments/network-profile-base.json (sha256 ee957827…; clean at
// e762a9c5) and source-verification-base.json (deployments = ledger-rev16d, full match with 4b7419bb0)
export const REVIEWED = Object.freeze({
  deployments: { address: "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b", codeHash: "0x71d50076336283e774ba2ef8d5cbf7602e9cdc5dd918a7e7390c743367766682" },
  registry: { address: "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac", codeHash: "0x39911d6f53959c610b9108bb906fc36ea8f57016c4b2571b5cd52c9c32a6f518" },
  appCatalog: { address: "0x18419ca2b502d423a8de6269aeee171a378626e3", codeHash: "0x3f3c4cc028abd3e117465362e196243cafaaffa7508dc6297d78a6b709dcc79f" },
  proofOfTime: { address: "0x6f462d77727f10f05a3e660650e7dcc9cc60e6b2", codeHash: "0x6b2eff59ba3f32f2d56515ec1b625dfabea05d2dbe8c7edd63a72e4bb20b0f72" },
  enclavePay: { address: "0x580270e88e5df35dad59e7fe3d907ebea96673a6", codeHash: "0xf902e3481a78768e93e7f1c0eacdc730ba110581f39c540fa6f50291d714f025" },
  verificationFees: { address: "0x87c7266543ff5839b2c20226bd9b3cd511a23641", codeHash: "0xf649e393d201db4cd3a0377384381a95bf32e33d53bab290a6824067d7f66ab9" },
  usdc: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", codeHash: "0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab" },
  secretVaultV2: { address: "0xe48699b8401564aace7a814ae4569b67a3f7eef5", codeHash: "0x4b949b378382d7fa862e7bc1552b58547ce811527c9746f4d9a0d39a8b4f716b" },
});
// the lease-gas reserve the canary's lease-gas steps may target (work/lease-enrollment-signing/trust.mjs)
export const LEASE_RESERVE = "0x12a3f873041dec436daa0085b766a399a6fa3639";
const KEYS = ["registry", "deployments", "appCatalog", "proofOfTime", "enclavePay", "verificationFees", "sessionVaultFactory", "secretVaultV2"];
const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a) => String(a ?? "").toLowerCase();

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// the same document rules as work/enclave network/contract-pins.mjs validateContractPins
export function parsePins(text) {
  const v = JSON.parse(text);
  if (!v || v.version !== 1 || v.chainId !== 8453 || !v.contracts || Object.keys(v).some((k) => !["version", "chainId", "contracts"].includes(k)))
    throw new Error("invalid contract pin document");
  if (Object.keys(v.contracts).some((k) => !KEYS.includes(k))) throw new Error("unknown contract pin");
  for (const k of KEYS) if (!/^0x[0-9a-fA-F]{40}$/.test(String(v.contracts[k]))) throw new Error(`missing or invalid contract pin: ${k}`);
  return Object.fromEntries(KEYS.map((k) => [k, lc(v.contracts[k])]));
}

// facts (one agreed block, every RPC agreeing): { block, codeHashes: {address: keccak}, book: {registry, deployments,
//   appCatalog, sessionVaultFactory}, vaultBook }
export function evalCliPins({ pinsText, facts }) {
  const reasons = [];
  let pins = null;
  try { pins = parsePins(pinsText); } catch (e) { return { ok: false, reasons: [e.message], pinsSha256: sha256(pinsText) }; }
  if (Object.values(pins).includes(RETIRED_LEDGER)) reasons.push("the pins name the RETIRED ledger 0xF9e71385… (the CLI's baked default)");
  if (pins.secretVaultV2 === MODIFIED_VAULT_V2) reasons.push("secretVaultV2 is the MODIFIED vault 0x56b81b39…, not the original 0xE486");
  for (const k of ["deployments", "registry", "appCatalog", "proofOfTime", "enclavePay", "verificationFees", "secretVaultV2"]) {
    if (pins[k] !== REVIEWED[k].address) reasons.push(`${k} ${pins[k]} is not the reviewed ${REVIEWED[k].address}`);
    else if (lc(facts.codeHashes?.[pins[k]]) !== REVIEWED[k].codeHash) reasons.push(`${k} runtime code hash ${facts.codeHashes?.[pins[k]] ?? "unread"} is not the reviewed ${REVIEWED[k].codeHash}`);
  }
  if (lc(facts.codeHashes?.[REVIEWED.usdc.address]) !== REVIEWED.usdc.codeHash) reasons.push("USDC runtime code hash is not the reviewed one");
  // the book the original vault reads through must name exactly these
  if (lc(facts.vaultBook) !== BOOK) reasons.push(`the original vault's book is ${facts.vaultBook}, not ${BOOK}`);
  for (const k of ["deployments", "registry"]) if (lc(facts.book?.[k]) !== pins[k]) reasons.push(`book ${k} is ${facts.book?.[k] ?? "unread"}, pins say ${pins[k]}`);
  if (facts.book?.appCatalog !== undefined && lc(facts.book.appCatalog) !== ZERO && lc(facts.book.appCatalog) !== pins.appCatalog) reasons.push("book appCatalog differs from the pins");
  const bookFactory = lc(facts.book?.sessionVaultFactory ?? "unread");
  if (bookFactory === "unread") reasons.push("book sessionVaultFactory unread");
  else if (pins.sessionVaultFactory !== bookFactory) reasons.push(`sessionVaultFactory ${pins.sessionVaultFactory} differs from the book's ${bookFactory} (zero disables every session path)`);
  return { ok: reasons.length === 0, reasons, pinsSha256: sha256(pinsText), pins };
}

// After root ran the CLI: every transaction must target the contract its step allows, never the retired ledger.
export function checkCliTargets({ stepId, txs, pins }) {
  const allowed = /leasegas$/.test(stepId) ? [LEASE_RESERVE] : [pins.deployments];
  const bad = txs.filter((t) => !allowed.includes(lc(t.to)));
  return bad.length ? [`${stepId}: transaction(s) to ${bad.map((t) => t.to).join(", ")}; only ${allowed.join(", ")} is allowed`] : [];
}
