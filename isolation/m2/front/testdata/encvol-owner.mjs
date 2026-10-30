// encvol E2E (front/encvol_e2e_test.go): the owner's BROWSER side, run from the page the deployed app itself serves.
// The test fetches GET / from the running encrypted-volumes app and runs its own wallet section (volMessage,
// walletDerive, openCredsEnvelope, sealCredsEnvelope) under Node's WebCrypto; the wallet is a stub that returns a
// signature the test made with a FIXTURE key (`cast wallet sign`), exactly what personal_sign would return.
//
//   node encvol-owner.mjs <appURL> derive <keyId> <sig>      -> {"message","password","salt"}
//   node encvol-owner.mjs <appURL> open <sig> <envelope>     -> {"creds"} | {"error"}
import vm from "node:vm";

const [, , appURL, op, ...args] = process.argv;
const page = await (await fetch(appURL + "/")).text();
const script = (page.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || "";
const from = script.indexOf("// ---- wallet key derivation"), to = script.indexOf("// ---- api");
if (from < 0 || to < 0) throw new Error("the app's page has no wallet section");
const wallet = { sig: "", async request({ method, params }) {
  if (method === "eth_requestAccounts") return ["0x0000000000000000000000000000000000000001"];
  if (method === "personal_sign") { this.signed = params[0]; return wallet.sig; }
  throw new Error("unexpected wallet call " + method);
} };
const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, btoa, Uint8Array, Array, String,
  JSON, Error, window: { ethereum: wallet } });
const fns = vm.runInContext(script.slice(from, to) + "\n;({ volMessage, walletDerive, openCredsEnvelope, sealCredsEnvelope })", ctx);

if (op === "derive") {
  const [keyId, sig] = args;
  wallet.sig = sig;
  const d = await fns.walletDerive(keyId);
  const msg = Buffer.from(wallet.signed.slice(2), "hex").toString("utf8");
  console.log(JSON.stringify({ message: msg, password: d.password, salt: d.salt }));
} else if (op === "open") {
  const [sig, envelope] = args;
  try { console.log(JSON.stringify({ creds: await fns.openCredsEnvelope(sig, envelope) })); }
  catch (e) { console.log(JSON.stringify({ error: e.message })); }
} else {
  throw new Error("op: derive | open");
}
