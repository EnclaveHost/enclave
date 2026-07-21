/* ============================================================
   Credit vault - the passkey signs on-chain credit operations.

   Flow: relay /billing/vault/prepare returns the op digest for
   the CURRENT vault nonce; the passkey signs it as a WebAuthn
   challenge (one Face ID tap); relay /vault/exec submits it and
   the CONTRACT verifies everything - a tampered digest, amount,
   or destination simply reverts on-chain. The vault's complete
   outflow list is the platform's own contracts, so the blast
   radius of trusting the relay-computed digest is bounded to
   "credit spent on the platform"; client-side digest recompute
   (needs a keccak lib the site doesn't carry yet) is tracked
   hardening, not a launch gate.

   No token names anywhere: the user sees dollars.
   ============================================================ */
import { Enclave, EnclaveError } from "./api.js";

const b64u = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const hexToBytes = (hex) => {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export async function getVault(){
  try { return await Enclave.billingVault(); } catch(e){ return null; }
}

export async function addCredit(amountUsd){
  const r = await Enclave.billingTopup(amountUsd);
  location.assign(r.url);                     // Stripe's hosted page; returns to /checkout?order=
}

/* one passkey tap = one signed vault operation.
   op: "deploy" { spec, fundUsd|hours } · "fund" { id, amountUsd } ·
       "refund" { amountUsd } */
export async function vaultOp(op, params){
  const prep = await Enclave.vaultPrepare({ op, ...params });
  const { startAuthentication } = await import("/vendor/webauthn.js");
  let asr;
  try {
    asr = await startAuthentication({ optionsJSON: {
      challenge: b64u(hexToBytes(prep.digest)),
      allowCredentials: [{ id: prep.credId, type: "public-key" }],
      userVerification: "preferred",
      timeout: 120000,
    }});
  } catch(e){
    throw new EnclaveError(e && e.name === "NotAllowedError"
      ? "That was cancelled or timed out. Try again." : "Passkey signing failed: " + (e.message || e), 0);
  }
  const args = op === "deploy" ? { createCall: prep.createCall, fund6: prep.fund6 }
             : op === "fund"   ? { id: prep.id, fund6: prep.fund6 }
             : op === "refund" ? { amount6: prep.amount6 }
             : { callData: prep.callData };
  return Enclave.vaultExec({ op, deadline: prep.deadline, args, assertion: {
    credId: asr.id,
    authenticatorData: asr.response.authenticatorData,
    clientDataJSON: asr.response.clientDataJSON,
    signature: asr.response.signature,
  }});
}
