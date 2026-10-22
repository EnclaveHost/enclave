/* ============================================================
   Passkey account recovery signer (EAB1, PROTOCOL-EAB1.md §3a) - a
   STATIC page for Enclave's site, served from the origin the original
   credit-vault factory pins (production: https://enclave.host, verified
   in passkey/production-factory.json). No server is involved: the person
   loads their own migration file here, pastes the sign-in or link message
   an app gave them, and their ORIGINAL enclave.host passkey signs it. The
   result is the ERC-1271 signature of the vault that passkey controls
   (EnclaveCreditVault.isValidSignature: an active key, user presence, this
   exact origin), wrapped as ERC-6492 so it also holds before that vault
   exists. The app checks it on chain through its owner's pinned readers.

   What this page will sign: only Sign-In-with-Ethereum text (EIP-191)
   naming THIS account's vault as the address, which it shows first. It
   never signs a raw 32-byte digest - so it cannot be used to authorize a
   vault operation (addKey, refunds, ...), whose digests are not EIP-191
   hashes of any text a person could be shown here.

   Reuses the site's vendored, reviewed primitives (/vendor/aa.js: viem's
   ABI/keccak and ox's WebAuthnP256 - the same passkey signer the
   dashboard's passkey account uses). Nothing here implements a curve.
   ============================================================ */
const cfg = await (await fetch(new URL("recover-config.json", import.meta.url), { cache: "no-store" })).json();
const L = await import("/vendor/aa.js");

const CLONE_HEAD = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73", CLONE_TAIL = "0x5af43d82803e903d91602b57fd5bf3";
const MAGIC_6492 = "0x" + "6492".repeat(16);
const SIG = { type: "tuple", components: [
  { name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" },
  { name: "r", type: "uint256" }, { name: "s", type: "uint256" }, { name: "x", type: "uint256" }, { name: "y", type: "uint256" }] };
const CREATE_VAULT = [{ type: "function", name: "createVault", stateMutability: "nonpayable",
  inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "address" }] }];

/** vaultFor(x, y) of the pinned original factory: CREATE2 of the EIP-1167 clone of its implementation. */
export function vaultFor(x, y, c = cfg) {
  const salt = L.keccak256(L.encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(x), BigInt(y)]));
  const code = L.concat([CLONE_HEAD, c.implementation, CLONE_TAIL]);
  return ("0x" + L.keccak256(L.concat(["0xff", c.factory, salt, L.keccak256(code)])).slice(-40)).toLowerCase();
}
/** The passkeys a migration file commits: [{ credId, x, y, vault }]. */
export function passkeysOf(bundle) {
  if (!bundle || bundle.kind !== "EAB1-bundle" || !Array.isArray(bundle.credentials)) throw new Error("that is not an Enclave account migration file");
  return bundle.credentials.filter((c) => c.kind === "passkey").map((c) => {
    const [, x, y, credId] = String(c.value).split(":");
    return { credId, x: "0x" + x, y: "0x" + y, vault: vaultFor("0x" + x, "0x" + y) };
  });
}
/** A Sign-In-with-Ethereum message, read for display; refuses anything else. */
export function readMessage(text) {
  const lines = String(text).split("\n");
  const m = /^(.+) wants you to sign in with your Ethereum account:$/.exec(lines[0] || "");
  if (!m || !/^0x[0-9a-fA-F]{40}$/.test(lines[1] || "") || !text.includes("\nResources:\n")) throw new Error("that is not a sign-in message from an app");
  const resources = text.split("\nResources:\n")[1].split("\n").map((r) => r.replace(/^- /, ""));
  if (!resources.some((r) => r.startsWith("urn:enclave:deployment:"))) throw new Error("that message names no Enclave deployment");
  return { site: m[1], address: lines[1].toLowerCase(), statement: lines[3] || "", resources,
           link: resources.some((r) => r.startsWith("urn:enclave:link:account:")) };
}
/** EIP-191 personal-message hash of the exact text. */
export function messageHash(text) {
  const b = new TextEncoder().encode(text);
  return L.keccak256(L.concat([L.toHex(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${b.length}`)), L.toHex(b)]));
}
/** The vault's signature over `text` by passkey {credId, x, y}: ERC-6492( factory, createVault(x, y), ERC-1271 sig ). */
export async function signAsVault(text, key, { getFn } = {}) {
  const msg = readMessage(text);
  if (msg.address !== vaultFor(key.x, key.y)) throw new Error("this message is for another address than this passkey's account address");
  const challenge = messageHash(text);
  const a = await L.WebAuthnP256.sign({ challenge, credentialId: key.credId, rpId: cfg.rpId, userVerification: "required", ...(getFn ? { getFn } : {}) });
  const inner = L.encodeAbiParameters([SIG], [{ authenticatorData: a.metadata.authenticatorData, clientDataJSON: a.metadata.clientDataJSON,
    r: a.signature.r, s: a.signature.s, x: BigInt(key.x), y: BigInt(key.y) }]);
  const deploy = L.encodeFunctionData({ abi: CREATE_VAULT, functionName: "createVault", args: [BigInt(key.x), BigInt(key.y)] });
  return L.concat([L.encodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "bytes" }], [cfg.factory, deploy, inner]), MAGIC_6492]);
}

// ---- the page ----
const $ = (id) => document.getElementById(id);
let keys = [];
function note(t, bad) { const n = $("note"); n.textContent = t || ""; n.className = bad ? "bad" : ""; }
if (location.origin !== cfg.origin) note(`This page only works at ${cfg.origin}: a passkey signature made anywhere else is refused by the account.`, true);
$("file").addEventListener("change", async () => {
  try {
    const f = $("file").files && $("file").files[0];
    if (!f) return;
    keys = passkeysOf(JSON.parse(await f.text()));
    if (!keys.length) throw new Error("this migration file commits no passkey: sign with a wallet the account had instead");
    $("key").innerHTML = keys.map((k, i) => `<option value="${i}">passkey ${k.credId.slice(0, 12)}… - account address ${k.vault}</option>`).join("");
    $("vault").textContent = keys[0].vault;
    $("step2").hidden = false;
    note("");
  } catch (e) { note(e.message, true); }
});
$("key").addEventListener("change", () => { $("vault").textContent = keys[Number($("key").value)].vault; });
$("message").addEventListener("input", () => {
  try { const m = readMessage($("message").value); $("what").textContent = `${m.link ? "Link your Enclave account at" : "Sign in to"} ${m.site} as ${m.address}: "${m.statement}"`; }
  catch (e) { $("what").textContent = ""; }
});
$("sign").addEventListener("click", async () => {
  $("signature").value = ""; note("");
  try {
    $("signature").value = await signAsVault($("message").value.trim(), keys[Number($("key").value)]);
    note("Signed. Paste the signature back into the app.");
  } catch (e) { note(e && e.name === "NotAllowedError" ? "The passkey prompt was cancelled." : e.message, true); }
});
