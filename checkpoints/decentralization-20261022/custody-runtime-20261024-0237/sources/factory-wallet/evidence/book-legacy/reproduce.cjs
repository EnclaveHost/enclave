// Reproduce the DEPLOYED original EnclaveAddressBook runtime (0xab214342…, keccak 0xe4f570e9…, 1809 bytes) from its
// source as committed at /home/steven/Projects/enclave 6c1135b0f (2026-07-07), with that commit's deploy settings
// (scripts/deploy-address-book.mjs: solc 0.8.35, optimizer enabled, runs 200, no viaIR), and compare.
//   node evidence/book-legacy/reproduce.cjs <path to solc 0.8.35 package dir>
const fs = require("fs"), path = require("path");
const solc = require(path.resolve(process.argv[2]));
const { keccak256 } = require(path.join(__dirname, "../../node_modules/viem/_cjs/index.js"));
const src = fs.readFileSync(path.join(__dirname, "EnclaveAddressBook.sol"), "utf8");
const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "EnclaveAddressBook.sol": { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.deployedBytecode.object"] } } } })));
const c = out.contracts["EnclaveAddressBook.sol"].EnclaveAddressBook, rt = "0x" + c.evm.deployedBytecode.object;
const want = fs.readFileSync(path.join(__dirname, "runtime.hex"), "utf8").trim();
const ok = solc.version().startsWith("0.8.35") && rt === want && keccak256(rt) === "0xe4f570e99f2ac708b35539fe5906889d8cb99189e6c9075f5e46d3b6921ac152"
  && JSON.stringify(c.abi) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, "EnclaveAddressBook.abi.json"), "utf8")));
console.log(JSON.stringify({ solc: solc.version(), bytes: (rt.length - 2) / 2, keccak: keccak256(rt), matchesDeployed: ok }));
process.exit(ok ? 0 : 1);
