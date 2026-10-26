// Etch the PINNED Safe v1.4.1 / passkey signer v0.2.1 / 4337 module / MultiSend code onto a local test chain from the
// recorded snapshot test/fixtures/base-code/safe-passkey-code-base.json (scripts/test-fixtures/snapshot-safe-passkey-code.mjs;
// PROVENANCE.txt). No network: the test never reads Base. Each pinned contract's stored code must hash to the pin the page
// itself names (and to the snapshot's own record); the passkey signer singleton must be the address embedded in the pinned
// factory's code. A plain anvil verifies P-256 at 0x100 natively, so the passkey signers work there unchanged.
//   const rows = await copySafePasskeyCode(pins, rigRpc)     pins: [{name, address, codeHash}] (account-providers.js)
import fs from "node:fs";
import { keccak256 } from "viem";

export const SAFE_PASSKEY_FIXTURE = new URL("../fixtures/base-code/safe-passkey-code-base.json", import.meta.url);

export async function copySafePasskeyCode(pins, setCodeRpc, { fixture = SAFE_PASSKEY_FIXTURE } = {}){
  const snap = JSON.parse(fs.readFileSync(fixture, "utf8"));
  if (snap.chainId !== 8453) throw new Error("the Safe passkey fixture is not a Base snapshot");
  const rows = [];
  for (const p of pins){
    const e = snap.contracts[p.name];
    if (!e) throw new Error(p.name + " is not in the Safe passkey fixture");
    if (e.address.toLowerCase() !== p.address.toLowerCase()) throw new Error(p.name + ": the fixture records another address");
    const h = keccak256(e.code);
    rows.push({ name: p.name, ok: h === e.keccak256 && (!p.codeHash || h === p.codeHash) });
    await setCodeRpc("anvil_setCode", [p.address, e.code]);
  }
  const s = snap.signerSingleton, factory = snap.contracts.webauthnSignerFactory;
  rows.push({ name: "signerSingleton", ok: keccak256(s.code) === s.keccak256 && factory.code.toLowerCase().includes(s.address.slice(2).toLowerCase()) });
  await setCodeRpc("anvil_setCode", [s.address, s.code]);
  return rows;
}
