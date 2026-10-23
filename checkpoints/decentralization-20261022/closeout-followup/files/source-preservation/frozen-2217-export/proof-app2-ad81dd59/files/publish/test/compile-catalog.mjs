// Offline reproduction of the DEPLOYED contracts the publish touches, for the local-chain tests. No network.
//   catalog 0x18419…: source blob 018e4bff (Projects/enclave f2e9a71d0), soljson 0.8.35 (sha256 fa4345d6…), runs 200,
//     viaIR. Its runtime keccak must equal the deployed codeHash in source-verification-base.json (no immutables: exact).
//   book 0xab21…: EnclaveAddressBook at 6c1135b0f (the deployed original, no pendingOwner), runs 200; its runtime keccak
//     must equal the code hash both RPCs reported in custody-v2-live-20261023/evidence/book-abi-readcheck.json.
//   a MOCK GasPriceOracle (test only; the real predeploy is not reproduced): mode 0 normal, 1 not Isthmus, 2 the operator
//     fee reverts.
// Writes fixtures/catalog-build.json, fixtures/book-build.json, fixtures/oracle-mock.json.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { keccak256 } from "viem";

const REPO = "/home/steven/Projects/enclave", BLOB = "018e4bffc6ac99f87b7b6087a6c4628a53e7a1e9";
const SRC_SHA = "b31744361efbb43fcf60152a5eaaa185d1af07bdc27f077af0a2b48e7de3b191";
const SOLJSON_SHA = "fa4345d648d9a09c6601ffc978e78e9f5267b54e6d91e8f8c473f44c0c16323b";
const BOOK_REV = "6c1135b0f", BOOK_SRC_SHA = "124aa407863e2213d8ef700e6e9492e9112b7a8e1ce50fc10f324b781173ac9a";
const BOOK_CODEHASH = "0xe4f570e99f2ac708b35539fe5906889d8cb99189e6c9075f5e46d3b6921ac152";
const DEPLOYED_CODEHASH = "0x3f3c4cc028abd3e117465362e196243cafaaffa7508dc6297d78a6b709dcc79f";
const require = createRequire(import.meta.url);
const sha = (b) => createHash("sha256").update(b).digest("hex");

const src = execFileSync("git", ["-C", REPO, "cat-file", "-p", BLOB]);
if (sha(src) !== SRC_SHA) throw new Error("catalog source blob sha256 differs");
const soljsonPath = require.resolve("solc/soljson.js");
if (sha(fs.readFileSync(soljsonPath)) !== SOLJSON_SHA) throw new Error("soljson differs from the pinned 0.8.35 build");
const solc = require("solc");
function build(file, content, name, viaIR) {
  const input = { language: "Solidity", sources: { [file]: { content } },
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts[file][name];
  const runtime = "0x" + c.evm.deployedBytecode.object;
  return { abi: c.abi, creation: "0x" + c.evm.bytecode.object, runtime, codeHash: keccak256(runtime), runtimeBytes: (runtime.length - 2) / 2 };
}
const fx = (f) => new URL("../fixtures/" + f, import.meta.url);
fs.mkdirSync(new URL("../fixtures/", import.meta.url), { recursive: true });

const cat = build("EnclaveAppCatalog.sol", src.toString("utf8"), "EnclaveAppCatalog", true);
const bookSrc = execFileSync("git", ["-C", REPO, "show", `${BOOK_REV}:contracts/EnclaveAddressBook.sol`]);
if (sha(bookSrc) !== BOOK_SRC_SHA) throw new Error("book source differs");
const book = build("EnclaveAddressBook.sol", bookSrc.toString("utf8"), "EnclaveAddressBook", false);
const oracleSrc = fs.readFileSync(new URL("./OracleMock.sol", import.meta.url), "utf8");
const oracle = build("OracleMock.sol", oracleSrc, "OracleMock", false);
const result = { solc: solc.version(),
  catalog: { runtimeBytes: cat.runtimeBytes, codeHash: cat.codeHash, matchesDeployed: cat.codeHash === DEPLOYED_CODEHASH },
  book: { runtimeBytes: book.runtimeBytes, codeHash: book.codeHash, matchesDeployed: book.codeHash === BOOK_CODEHASH } };
console.log(JSON.stringify(result));
if (!result.catalog.matchesDeployed || !result.book.matchesDeployed) process.exit(1);
fs.writeFileSync(fx("catalog-build.json"), JSON.stringify({ sourceBlob: BLOB, sourceSha256: SRC_SHA, solc: solc.version(), codeHash: cat.codeHash, abi: cat.abi, creation: cat.creation }) + "\n");
fs.writeFileSync(fx("book-build.json"), JSON.stringify({ sourceRev: BOOK_REV, sourceSha256: BOOK_SRC_SHA, solc: solc.version(), codeHash: book.codeHash, abi: book.abi, runtime: book.runtime }) + "\n");
fs.writeFileSync(fx("oracle-mock.json"), JSON.stringify({ test: "mock, not the predeploy", abi: oracle.abi, runtime: oracle.runtime }) + "\n");
