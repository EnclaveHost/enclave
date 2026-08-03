// Mint a SIWE session on a specific enclave supervisor with the throwaway key
// and print the bearer. usage: node session.mjs <supervisor-base>
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const base = process.argv[2];
const pk = readFileSync("/home/steven/.config/enclave/key", "utf8").trim();
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);

const nonce = await fetch(`${base}/v1/auth/nonce?address=${account.address}`).then(r => r.json());
if (!nonce.message) throw new Error("nonce failed: " + JSON.stringify(nonce));
const signature = await account.signMessage({ message: nonce.message });
const login = await fetch(`${base}/v1/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: nonce.message, signature }),
}).then(r => r.json());
if (!login.token) throw new Error("login failed: " + JSON.stringify(login));
console.log(login.token);
