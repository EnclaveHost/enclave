/* ============================================================
   Credit vault - the passkey signs on-chain credit operations.

   Flow: relay /billing/vault/prepare returns the op digest for
   the CURRENT vault nonce; the passkey signs it as a WebAuthn
   challenge (one Face ID tap); relay /vault/exec submits it and
   the CONTRACT verifies everything - a tampered digest, amount,
   or destination simply reverts on-chain.

   WHY THE CLIENT RECOMPUTES. A WebAuthn assertion signs 32
   opaque bytes. The contract checks that those bytes are the
   digest of the operation it is executing - but it cannot check
   that they are the digest of the operation the CUSTOMER asked
   for, and the relay is what stands between the two. Signing the
   relay's digest unread hands it a blank cheque within the
   contract's allowlist, and that allowlist is not as narrow as
   it looks: create() takes feeRecipient + feePerSec6, and the
   publisher fee is folded into the rate and paid pro-rata out of
   every funding, so a lying relay could put its own wallet in
   there at the ledger's cap and divert most of a top-up on one
   tap. So: recompute the digest here from the fields, and check
   those fields against what the caller actually asked for,
   BEFORE the passkey is ever prompted. Nothing signs unless both
   agree. (site/js/core/keccak.js exists for exactly this.)

   The rule for amounts is "never more than I authorized" rather
   than exact equality: the relay converts dollars to seconds at
   the live chain rate, so the last unit is its rounding, not a
   number this side can reproduce.

   No token names anywhere: the user sees dollars.
   ============================================================ */
import { Enclave, EnclaveError } from "./api.js";
import { keccak256Hex, keccak256Utf8, hexToBytes } from "./keccak.js";
import { encCall, DEP_SEL } from "./chain.js";

const b64u = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/* ---- the digest, recomputed (mirrors EnclaveCreditVault's abi.encode) ---- */
const OP_TAG = {
  deploy:  () => keccak256Utf8("EnclaveVault.deployAndFund.v1"),
  fund:    () => keccak256Utf8("EnclaveVault.fundDeployment.v1"),
  control: () => keccak256Utf8("EnclaveVault.controlDeployment.v1"),
  refund:  () => keccak256Utf8("EnclaveVault.refundToTreasury.v1"),
};
// one abi word: 0x-hex is left-padded (address/bytes32), anything else is a uint
const word = (v) => typeof v === "string" && /^0x/i.test(v)
  ? v.slice(2).toLowerCase().padStart(64, "0")
  : BigInt(v).toString(16).padStart(64, "0");

export function opDigest(op, p) {
  const tag = OP_TAG[op];
  if (!tag) throw new Error("unknown vault op " + op);
  const w = [word(tag()), word(p.vault), word(p.chainId), word(p.nonce)];
  if (op === "deploy")       w.push(word(keccak256Hex(p.createCall)), word(p.fund6), word(p.deadline));
  else if (op === "fund")    w.push(word(p.id), word(p.fund6), word(p.deadline));
  else if (op === "control") w.push(word(keccak256Hex(p.callData)), word(p.deadline));
  else                       w.push(word(p.amount6), word(p.deadline));
  return keccak256Hex("0x" + w.join(""));
}

/* ---- reading back the create() calldata the digest commits to ----
   Every argument of whichever shape the ledger speaks (rev 8 = 10 with the
   rate cap, rev 4-7 = 9 with the fee snapshot, rev 2-3 = 7); the three strings
   are read from their offsets. Deliberately hand-rolled and strict: an
   encoding this side cannot fully account for is a refusal, not a shrug. */
const CREATE_SELECTORS = { [DEP_SEL.create]: 10, [DEP_SEL.createV4]: 9, [DEP_SEL.createV3]: 7 };
export function decodeCreateCall(hex) {
  const h = String(hex || "").replace(/^0x/, "").toLowerCase();
  const nArgs = CREATE_SELECTORS[h.slice(0, 8)];
  if (!nArgs) throw new Error("the relay's calldata is not a create() this page recognizes");
  const body = h.slice(8);
  const at = (i) => body.slice(i * 64, i * 64 + 64);
  const uint = (i) => BigInt("0x" + at(i));
  const str = (i) => {
    const off = Number(uint(i)) * 2;
    const len = Number(BigInt("0x" + body.slice(off, off + 64)));
    return new TextDecoder().decode(hexToBytes(body.slice(off + 64, off + 64 + len * 2)));
  };
  return {
    appRef: str(0), gpuMilli: Number(uint(1)), cpuMilli: Number(uint(2)), appPort: Number(uint(3)),
    ports: str(4), isPublic: uint(5) === 1n, configCid: str(6),
    feeRecipient: nArgs >= 9 ? "0x" + at(7).slice(24) : "0x" + "0".repeat(40),
    feePerSec6: nArgs >= 9 ? uint(8) : 0n,
    maxRate6: nArgs >= 10 ? uint(9) : 0n,
  };
}

const usd6 = (usd) => BigInt(Math.round(Number(usd) * 100)) * 10000n;
const ZERO_ADDR = "0x" + "0".repeat(40);

/* Does `prep` describe the operation the caller asked for? Throws the
   difference. Amounts are bounded ("never more than I authorized"), fields the
   caller named are compared exactly. */
export function assertIsWhatIAskedFor(op, prep, params) {
  const no = (what) => { throw new EnclaveError(
    `The server described a different operation than the one you asked for (${what}). Nothing was signed.`, 0); };

  if (op === "deploy") {
    const c = decodeCreateCall(prep.createCall);
    const s = params.spec || {};
    // mirror the relay's own coercions (validateDeploySpec) so a legitimate
    // rounding is never mistaken for tampering — the comparison has to be
    // exact about the VALUES, not about how they were spelled
    const milli = (share, m) => Math.round(Number(share != null ? Number(share) * 1000 : m) || 0);
    if (c.appRef !== String(s.appRef ?? "")) no("a different app");
    if (c.gpuMilli !== milli(s.gpuShare, s.gpuMilli) || c.cpuMilli !== milli(s.cpuShare, s.cpuMilli)) no("different shares");
    if (c.appPort !== (Math.round(Number(s.appPort)) || 8080)) no("a different port");
    if (c.ports !== String(s.ports || "")) no("different declared ports");
    if (c.isPublic !== !!s.isPublic) no("a different visibility");
    if (c.configCid !== String(s.configCid ?? "")) no("a different config");
    // the diversion vector: the honest path always encodes no publisher fee
    if (c.feePerSec6 !== 0n || c.feeRecipient.toLowerCase() !== ZERO_ADDR) no("a publisher fee to a third party");
    // the spend ceiling bounds the BURN RATE, not the amount at risk (fund6
    // below does that) - but when the caller named one, it must be theirs
    if (s.maxRate6 != null && c.maxRate6 !== BigInt(s.maxRate6)) no("a different rate cap");
    // ...and when it did NOT name one, the cap in the calldata is still a number
    // the SERVER chose, which is the shape this whole gate exists to refuse. The
    // credit path can't demand an exact match (the relay quotes from a cached
    // fleet price, this page from a live read, and an operator re-pricing between
    // the two is normal), so the caller passes the ceiling it is willing to sign:
    // its own quote with room for that drift. A relay multiplying the cap - the
    // only version of this that costs the buyer anything, by burning their credit
    // at a rate they were never shown - lands outside it.
    else if (params.maxRate6Max != null && c.maxRate6 > BigInt(params.maxRate6Max))
      no("a higher rate cap than this page quoted");
    if (params.fundUsd != null && BigInt(prep.fund6) > usd6(params.fundUsd)) no("a larger amount than you entered");
  } else if (op === "fund") {
    if (String(prep.id).toLowerCase() !== String(params.id).toLowerCase()) no("a different deployment");
    if (BigInt(prep.fund6) > usd6(params.amountUsd)) no("a larger amount than you entered");
  } else if (op === "refund") {
    if (BigInt(prep.amount6) > usd6(params.amountUsd)) no("a larger amount than you entered");
  } else if (op === "control") {
    if (String(prep.callData).toLowerCase() !== expectedControlCall(params).toLowerCase())
      no("a different change to your deployment");
  }
}

/* The whole gate, in the order it matters: is this the operation I asked for,
   and is the challenge really its digest? Exported so the test suite drives the
   exact function the page does, not a copy of it. */
export function verifyPrepare(op, prep, params) {
  assertIsWhatIAskedFor(op, prep, params);
  if (opDigest(op, prep).toLowerCase() !== String(prep.digest).toLowerCase())
    throw new EnclaveError("The signing challenge does not match the operation it describes. Nothing was signed.", 0);
}

/* The exact calldata a control action must carry. Rebuilt from the caller's
   own arguments, so the comparison never consults anything the relay said. */
export function expectedControlCall({ id, action, ref, gpuMilli, cpuMilli, envelope, maxRate6 }) {
  const b32 = { t: "bytes32", v: id };
  const setAppRef = () => encCall(DEP_SEL.setAppRef, [b32, { t: "str", v: String(ref) }]);
  if (action === "suspend" || action === "resume")
    return encCall(DEP_SEL.setActive, [b32, { t: "bool", v: action === "resume" }]);
  if (action === "version") return setAppRef();
  if (action === "options") return encCall(DEP_SEL.setConfig, [b32, { t: "str", v: String(envelope ?? "") }]);
  if (action === "maxrate") return encCall(DEP_SEL.setMaxRate, [b32, { t: "uint", v: BigInt(maxRate6) }]);
  if (action === "resize") {
    const shares = encCall(DEP_SEL.setShares, [b32, { t: "uint", v: Number(gpuMilli) }, { t: "uint", v: Number(cpuMilli) }]);
    if (ref === undefined || ref === null || ref === "") return shares;
    return encCall(DEP_SEL.multicall, [{ t: "bytes[]", v: [setAppRef(), shares] }]);
  }
  throw new EnclaveError("Unknown control action: " + action, 0);
}

export async function getVault(){
  try { return await Enclave.billingVault(); } catch(e){ return null; }
}

export async function addCredit(amountUsd){
  const r = await Enclave.billingTopup(amountUsd);
  location.assign(r.url);                     // Stripe's hosted page; returns to /checkout?order=
}

/* one passkey tap = one signed vault operation.
   op: "deploy" { spec, fundUsd|hours } · "fund" { id, amountUsd } ·
       "refund" { amountUsd } · "control" { id, action, … } */
export async function vaultOp(op, params){
  const prep = await Enclave.vaultPrepare({ op, ...params });

  // Before the passkey is prompted: is this the operation I asked for, and is
  // the digest really its digest? Either answer being no is a hard stop - a
  // signature is the only thing standing between the relay and the credit.
  verifyPrepare(op, prep, params);

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
