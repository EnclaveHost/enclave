// The recipient's side, as a JS REFERENCE: what the measured guest front does at app start (the production implementation is
// Go, isolation/m2/custody, and follows this step for step). It needs:
//   - `state`: the deployment's custody state (custody/chain.mjs readState). It may come from an UNTRUSTED source (the
//     host, the relay): every field that matters is bound into the evidence and re-checked by each custodian against the
//     chain, and the bundle opens only under the key the custodians' shares reconstruct.
//   - `attester`: the trusted front: { runtime, transportSpki, evidence(binding) } — evidence() returns a document whose
//     report carries report_data = binding ‖ AppID, the AppID written by the front from the code it loaded, never by the app.
//   - `authorize({ binding, messageFor })`: the host's registered operator picks an expiry (<= 600 s ahead) and signs
//     messageFor(expiry) with personal_sign -> { sig, expiry }. The binding is all it needs to see.
//   - `post(url, body)`: transport (the guest's egress; tests pass an in-process one).
// The recipient X25519 key is generated HERE, inside the trusted code, and never leaves it.
import * as P from "./protocol.mjs";
import * as th from "./threshold.mjs";
import * as hpke from "./hpke.mjs";
import { runtimeId as runtimeIdOf } from "../isolation/contract/runtime.mjs";

export async function obtainSecrets({ chainId, vault, id, endpoint, state, attester, authorize, post, configText = undefined, minCustodians = null, log = () => {} }) {
  const v = String(vault).toLowerCase();
  const pol = state.policy, committee = state.committee;
  if (!pol || pol.policyRev === 0n) throw new Error("no custody policy for this deployment");
  if (!committee || !state.shares || !state.shares.complete || !state.bundle.ciphertext.length) throw new Error("no complete bundle for this deployment");
  const t = committee.threshold;
  const commitments = P.splitCommitments(state.shares.commitments);
  if (commitments.length !== t) throw new Error("the commitments do not match the committee's threshold");
  const ask = minCustodians ?? committee.members.length;   // ask everyone by default: t answers are enough, more tolerate refusals
  // 1. challenges from the custodians (their keys as the chain states them)
  const got = await Promise.allSettled(committee.members.slice(0, ask).map(async (m, index) => {
    const r = await post(`${m.endpoint}/v1/custody/challenge`, {});
    if (!r || r.encKey !== P.hex(m.encKey) || !/^[0-9a-f]{64}$/.test(String(r.nonce))) throw new Error(`member ${index} answered a challenge under another key`);
    return { index, member: m, nonce: Buffer.from(r.nonce, "hex") };
  }));
  const ch = got.filter((g) => g.status === "fulfilled").map((g) => g.value);
  if (ch.length < t) throw Object.assign(new Error(`only ${ch.length} of ${committee.members.length} custodians issued a challenge (need ${t})`), { code: "insufficient_quorum" });
  const challenges = ch.map((c) => ({ encKey: c.member.encKey, nonce: new Uint8Array(c.nonce) }));
  // 2. the recipient key and the binding
  const recipient = hpke.generateKeyPair();
  const runtimeId = new Uint8Array(runtimeIdOf(attester.runtime));
  const binding = P.releaseBinding({ chainId, vault: v, id, policyRev: pol.policyRev, secretRev: pol.secretRev, epoch: state.bundle.epoch,
                                     challenges, runtimeId, transportSpki: attester.transportSpki, recipientKey: recipient.publicKey });
  // 3. evidence over the binding, and the operator's authorization of exactly this release
  const evidence = await attester.evidence(binding);
  const auth = await authorize({ binding, messageFor: (expiry) => P.operatorMessage({ chainId, vault: v, id, endpoint, binding, expiry }) });
  // 4. ask each challenged custodian for its share
  const body = { v: 1, id, endpoint, policyRev: String(pol.policyRev), secretRev: String(pol.secretRev), epoch: state.bundle.epoch,
                 challenges: challenges.map((c) => ({ encKey: P.hex(c.encKey), nonce: P.hex(c.nonce) })),
                 recipientKey: P.hex(recipient.publicKey), evidence, operator: auth };
  const answers = await Promise.allSettled(ch.map(async (c) => {
    const r = await post(`${c.member.endpoint}/v1/custody/release`, body);
    if (!r || r.encKey !== P.hex(c.member.encKey) || r.index !== c.index) throw new Error(`member ${c.index} answered for another key or index`);
    const y = P.openResponse({ recipientPrivate: recipient.privateKey, binding, encKey: c.member.encKey, index: c.index, sealed: new Uint8Array(Buffer.from(r.sealed, "base64")) });
    // a share that does not match the on-chain commitments is a lying custodian: named, never mixed in
    if (!th.verifyShare(c.index + 1, y, commitments)) throw new Error(`member ${c.index} returned a share that does not match the commitments`);
    return { x: c.index + 1, y };
  }));
  const shares = answers.filter((a) => a.status === "fulfilled").map((a) => a.value);
  const refusals = answers.map((a, i) => (a.status === "rejected" ? { index: ch[i].index, reason: a.reason && a.reason.message } : null)).filter(Boolean);
  for (const r of refusals) log(`custodian ${r.index} gave no share: ${r.reason}`);
  if (shares.length < t) throw Object.assign(new Error(`only ${shares.length} custodians released a share (need ${t})`), { code: "insufficient_quorum", refusals });
  // 5. the data key and the bundle
  const s = th.combine(shares, t);
  const dek = P.deriveDek(s, { chainId, vault: v, id, secretRev: pol.secretRev });
  const { env, configSha256 } = P.decryptBundle(dek, P.bundleAad({ chainId, vault: v, id, secretRev: pol.secretRev, c0: commitments[0] }), state.bundle.ciphertext);
  dek.fill(0); recipient.privateKey.fill(0);
  // the values go only into the config the owner committed (the guest front makes the same check before substituting)
  if (configText !== undefined && P.configSha256(configText) !== configSha256)
    throw Object.assign(new Error("the delivered config is not the one the owner committed in the bundle: refusing to substitute"), { code: "config_mismatch" });
  return { env, configSha256, released: shares.map((x) => x.x - 1), refusals };
}
