// ROOT-LEDGER-REVIEW: the CLI contract-pins file must name the book's CURRENT ledger (rev16d 0xB1783B61…) and the ORIGINAL
// vault, with reviewed code, before any CLI step; and every CLI transaction must target its step's contract. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evalCliPins, checkCliTargets, parsePins, REVIEWED, BOOK, RETIRED_LEDGER, MODIFIED_VAULT_V2, LEASE_RESERVE } from "../driver/clipins.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANARY = fs.readFileSync(path.join(ROOT, "cli-pins/canary-contract-pins.json"), "utf8");
const example = JSON.parse(fs.readFileSync(path.join(ROOT, "pins.base.json"), "utf8"));
const ZERO = "0x0000000000000000000000000000000000000000";
const goodFacts = () => ({
  codeHashes: Object.fromEntries(Object.values(REVIEWED).map((r) => [r.address, r.codeHash])),
  book: { deployments: REVIEWED.deployments.address, registry: REVIEWED.registry.address, appCatalog: REVIEWED.appCatalog.address, sessionVaultFactory: ZERO },
  vaultBook: BOOK,
});
const doc = (contracts) => JSON.stringify({ version: 1, chainId: 8453, contracts });
// the two files the CLI could be handed instead (values copied from work/enclave contracts/deployments at e762a9c5)
const TRACKED_BASE = { ...parsePins(CANARY), sessionVaultFactory: "0xec9277a32f98ad3108747fe3da78c35e1bee097b", secretVaultV2: MODIFIED_VAULT_V2 };   // gitleaks:allow (public contract address, not a secret)
const UNTRACKED_PRODUCTION = { ...parsePins(CANARY), sessionVaultFactory: "0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c" };

test("the canary pins file is the pinned bytes and reconciles with the book, the original vault and the reviewed code", () => {
  assert.equal(createHash("sha256").update(CANARY).digest("hex"), example.cli.pinsSha256);
  const r = evalCliPins({ pinsText: CANARY, facts: goodFacts() });
  assert.deepEqual(r.reasons, []); assert.equal(r.ok, true);
  assert.equal(r.pins.deployments, "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b");
  assert.equal(r.pins.secretVaultV2, "0xe48699b8401564aace7a814ae4569b67a3f7eef5");   // gitleaks:allow (public contract address, not a secret)
});

test("refused: the CLI's retired baked ledger, the modified vault, other pin files, book or code mismatches", () => {
  const P = parsePins(CANARY);
  const cases = [
    [doc({ ...P, deployments: RETIRED_LEDGER }), goodFacts(), /RETIRED ledger/],
    [doc(TRACKED_BASE), goodFacts(), /MODIFIED vault/],
    [doc(TRACKED_BASE), goodFacts(), /sessionVaultFactory/],
    [doc(UNTRACKED_PRODUCTION), goodFacts(), /sessionVaultFactory 0x1f5c/],
    [CANARY, { ...goodFacts(), book: { ...goodFacts().book, deployments: RETIRED_LEDGER } }, /book deployments/],
    [CANARY, { ...goodFacts(), vaultBook: "0xf76a138ceb162aa4bab47d4787793c569759cac8" }, /original vault's book/],
    [CANARY, { ...goodFacts(), codeHashes: { ...goodFacts().codeHashes, [REVIEWED.deployments.address]: "0x" + "00".repeat(32) } }, /deployments runtime code hash/],
    [CANARY, { ...goodFacts(), codeHashes: { ...goodFacts().codeHashes, [REVIEWED.usdc.address]: undefined } }, /USDC/],
    [CANARY, { ...goodFacts(), book: { ...goodFacts().book, sessionVaultFactory: undefined } }, /sessionVaultFactory unread/],
    [CANARY, { ...goodFacts(), book: { ...goodFacts().book, appCatalog: "0x" + "12".repeat(20) } }, /appCatalog/],
    [doc({ ...P, unknown: ZERO }), goodFacts(), /unknown contract pin/],
    [JSON.stringify({ version: 1, chainId: 1, contracts: P }), goodFacts(), /invalid contract pin document/],
  ];
  for (const [text, facts, re] of cases) {
    const r = evalCliPins({ pinsText: text, facts });
    assert.equal(r.ok, false, String(re)); assert.match(r.reasons.join("; "), re);
  }
});

test("every CLI transaction must target its step's contract: the pinned ledger, or the lease-gas reserve for lease steps", () => {
  const pins = parsePins(CANARY);
  assert.deepEqual(checkCliTargets({ stepId: "D1.create", txs: [{ to: REVIEWED.deployments.address }, { to: REVIEWED.deployments.address }], pins }), []);
  assert.deepEqual(checkCliTargets({ stepId: "D1.leasegas", txs: [{ to: LEASE_RESERVE }, { to: LEASE_RESERVE.toUpperCase().replace("0X", "0x") }], pins }), []);
  assert.match(checkCliTargets({ stepId: "D1.create", txs: [{ to: RETIRED_LEDGER }], pins }).join(), /only 0xb1783b61/);
  assert.match(checkCliTargets({ stepId: "D1.stop", txs: [{ to: LEASE_RESERVE }], pins }).join(), /not|only/);
  assert.match(checkCliTargets({ stepId: "D2.leasegas", txs: [{ to: REVIEWED.deployments.address }], pins }).join(), /only 0x12a3/);
});

test("proposal patch (not applied to work/enclave): applies cleanly to the reviewed cli/enclave.mjs bytes and parses", { timeout: 30000 }, () => {
  const src = "/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/cli/enclave.mjs";
  const bytes = fs.readFileSync(src);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "f83cab274f9cd0fcac16182363ed4927c2495f5b82bafacbed70e896b8f0ca8e",
    "work/enclave cli/enclave.mjs moved since the review: re-derive the proposal");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-patch-"));
  try {
    fs.mkdirSync(path.join(dir, "a/cli"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a/cli/enclave.mjs"), bytes);
    const r = spawnSync("patch", ["-p1", "-d", path.join(dir, "a"), "-i", path.join(ROOT, "proposals/cli-ledger-write-guard.patch")], { encoding: "utf8", timeout: 20000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const patched = fs.readFileSync(path.join(dir, "a/cli/enclave.mjs"), "utf8");
    assert.equal((patched.match(/ledgerWriteAllowed\(/g) || []).length, 2);
    assert.match(patched, /RETIRED_LEDGERS = \["0xf9e71385c5cb49844f2457ba6567de0742f8b89a"\]/);
    const c = spawnSync(process.execPath, ["--check", path.join(dir, "a/cli/enclave.mjs")], { encoding: "utf8", timeout: 20000 });
    assert.equal(c.status, 0, c.stderr);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
