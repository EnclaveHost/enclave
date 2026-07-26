// Mint a Enclave session token via the SIWE handshake, for testing.
//
// Interactive: run it bare and it prompts for the enclave URL and an optional
// wallet key (hidden input; blank = throwaway wallet).
// Non-interactive (env vars always win; pipes/CI never prompt):
//   ENCLAVE_BASE=https://enclave1.nan.containers.tinfoil.dev PK=0x... node scripts/login.mjs
//
// NOTE: deployment records are owner-gated. To READ an existing deployment,
// log in with the wallet that created it — a throwaway wallet only sees its
// own. (Browser sessions: the site keeps its token in localStorage
// "enclave_session"; no need for this script or your key.)
import readline from "node:readline/promises";
import rlSync from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

function promptSecret(query) {
  return new Promise((resolve) => {
    const rl = rlSync.createInterface({ input, output, terminal: true });
    rl._writeToOutput = (s) => { if (!rl._muted) output.write(s); };
    rl.question(query, (ans) => { rl.close(); output.write("\n"); resolve(ans.trim()); });
    rl.on("close", () => resolve(""));            // EOF (ctrl-d) = blank answer, not a hang
    rl._muted = true;
  });
}
async function promptText(query) {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(query)).trim(); }
  catch { return ""; }                            // EOF (ctrl-d) = blank answer
  finally { rl.close(); }
}

const tty = input.isTTY && output.isTTY;

let base = (process.env.ENCLAVE_BASE || "").trim();
if (!base && tty) base = await promptText("Enclave URL [http://localhost:8080]: ");
base = (base || "http://localhost:8080").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) base = "https://" + base;

let pk = (process.env.PK || "").trim();
if (!pk && tty) pk = await promptSecret("Wallet private key (hidden; blank = new throwaway wallet): ");
if (pk && !pk.startsWith("0x")) pk = "0x" + pk;
if (pk && !/^0x[0-9a-fA-F]{64}$/.test(pk))
  { console.error("ERROR: that doesn't look like a 32-byte hex private key."); process.exit(1); }
const throwaway = !pk;
const acct = privateKeyToAccount(pk || (pk = generatePrivateKey()));

let nonce;
try {
  nonce = await fetch(`${base}/v1/auth/nonce?address=${acct.address}`).then((r) => r.json());
} catch (e) {
  console.error(`ERROR: cannot reach ${base} (${e.cause?.code || e.message}).`);
  console.error(`Is that the right URL? For the live enclave use e.g.`);
  console.error(`  ENCLAVE_BASE=https://enclave1.nan.containers.tinfoil.dev node scripts/login.mjs`);
  process.exit(1);
}
if (!nonce.message) { console.error("nonce failed:", nonce); process.exit(1); }
// The endpoint hands us a string and we sign it with a REAL wallet key, with no
// prompt. That is blind signing unless it is checked: the same key authorizes
// `enclave-upload:…`, `enclave-secrets:put:…` (a secrets WRITE) and the
// encrypted-volume message whose signature IS the volume key, so an endpoint
// that returned one of those would get it signed and handed straight back.
// Same gate as cli/enclave.mjs assertSiweLogin and site/js/core/wallet.js —
// every line must belong to the SIWE grammar, which is what stops a second
// directive riding along as an extra line. Inline because this script is
// standalone by design (no repo imports).
{
  const FIELD = /^(URI|Version|Chain ID|Nonce|Issued At|Expiration Time|Not Before|Request ID|Resources): ?(.*)$/;
  const bad = (why) => {
    console.error(`REFUSING TO SIGN: ${base} did not return a SIWE login for this wallet (${why}).`);
    console.error("Nothing was signed. Check ENCLAVE_BASE points where you think it does.");
    process.exit(1);
  };
  const L = String(nonce.message).split("\n");
  if (String(nonce.message).length > 4096) bad("absurdly long");
  if (!/^\S+ wants you to sign in with your Ethereum account:$/.test(L[0] || "")) bad("first line is not the SIWE preamble");
  if ((L[1] || "").toLowerCase() !== acct.address.toLowerCase()) bad("it asks a different address to sign");
  if (L[2] !== "") bad("malformed header");
  let i = 3;                                    // the statement is optional (EIP-4361), and so is its blank line
  if (L[i] !== undefined && L[i] !== "" && !FIELD.test(L[i])) { i++; if (L[i] !== "") bad("statement is not a single line"); i++; }
  const seen = {};
  for (; i < L.length; i++) {
    if (L[i] === "" && i === L.length - 1) continue;
    if (/^- \S+$/.test(L[i]) && seen["Resources"]) continue;
    const f = FIELD.exec(L[i]);
    if (!f) bad(`line ${i + 1} is not a SIWE field`);
    seen[f[1]] = f[2];
  }
  if (!seen["Nonce"]) bad("no Nonce");
  if (seen["Version"] !== "1") bad("not SIWE version 1");
  if (seen["Expiration Time"] && Date.parse(seen["Expiration Time"]) <= Date.now()) bad("already expired");
}
const signature = await acct.signMessage({ message: nonce.message });
const login = await fetch(`${base}/v1/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: nonce.message, signature }),
}).then((r) => r.json());
if (!login.token) { console.error("login failed:", login); process.exit(1); }

console.log("BASE:   ", base);
console.log("ADDRESS:", acct.address);
if (throwaway) console.log("PK:     ", pk);   // only echo keys WE generated; never echo a provided one
console.log("TOKEN:  ", login.token);
if (throwaway) console.log("\n(throwaway wallet — it cannot read deployments owned by other addresses)");
console.log(`\nexport ENCLAVE_TOKEN="${login.token}"`);
