// Copy the PINNED Safe v1.4.1 / passkey signer v0.2.1 / 4337 module / MultiSend code byte for byte from Base (a read-only
// upstream read) onto a local test chain, checking each code hash against its pin; plus the passkey signer singleton the
// factory names. A plain anvil verifies P-256 at 0x100 natively, so the passkey signers work there unchanged.
//   const rows = await copySafePasskeyCode(pins, rigRpc)     pins: [{name, address, codeHash}] (account-providers.js)
import { keccak256, toBytes } from "viem";

export async function copySafePasskeyCode(pins, setCodeRpc, { upstream = process.env.BASE_FORK_RPC || "https://mainnet.base.org" } = {}){
  const read = async (method, params) => { const r = await (await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) throw new Error("Base read: " + r.error.message); return r.result; };
  const factory = pins.find((c) => c.name === "webauthnSignerFactory").address;
  const singleton = "0x" + (await read("eth_call", [{ to: factory, data: keccak256(toBytes("SINGLETON()")).slice(0, 10) }, "latest"])).slice(26);
  const rows = [];
  for (const c of [...pins, { name: "signerSingleton", address: singleton, codeHash: null }]){
    const code = await read("eth_getCode", [c.address, "latest"]);
    if (!code || code === "0x") throw new Error(c.name + " has no code on Base");
    rows.push({ name: c.name, ok: !c.codeHash || keccak256(code) === c.codeHash });
    await setCodeRpc("anvil_setCode", [c.address, code]);
  }
  return rows;
}
