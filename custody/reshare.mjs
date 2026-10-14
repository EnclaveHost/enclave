// Resharing a bundle's key from its current committee epoch to a newer one (membership change, member key rotation, a new
// threshold), without anyone reconstructing the key. custody/threshold.mjs has the mathematics; this is the wire form.
//
//   deal (old member i, posted on chain with postDeal) = subCommitments (tNew x 33) ‖ sealed sub-share for each new member j
//       sealed_j = HPKE(newMember_j.encKey, info DEAL, aad = dealAad(... dealer i, member j, subCommitments), g_i(j+1))
//   new member j: takes the LOWEST-indexed old members whose deals pass every check for it (its sub-share opens and matches
//       the dealer's sub-commitments; the dealer's g_i(0) is the dealer's real share, against the old public commitments),
//       exactly the old threshold of them; combines; seals its new share to its OWN key; posts it with the derived new
//       commitments (postReshare). The contract moves the bundle when the new threshold of members agree on one source.
//
// PROACTIVE SECURITY NEEDS ERASURE. Old shares stay on chain sealed to the old keys. A reshare only stops an old member's
// share from counting if that member's old PRIVATE key is destroyed afterwards, so a membership change that is meant to
// exclude a suspected member, or to refresh after a compromise, must ALSO rotate every remaining member's key (a new epoch
// with new encKeys) and destroy the old private keys. docs/security/secret-custody.md states the procedure.
import { concatBytes } from "@noble/hashes/utils";
import * as P from "./protocol.mjs";
import * as th from "./threshold.mjs";
import * as hpke from "./hpke.mjs";

export function makeDeal({ chainId, vault, id, secretRev, committeeId, fromEpoch, toEpoch, dealer, y, newMembers, tNew }) {
  const v = String(vault).toLowerCase();
  const { shares, commitments } = th.reshareFrom(y, tNew, newMembers.length);
  const sealed = shares.map((sh, j) => hpke.seal(P.fixed(newMembers[j].encKey, 32, "member encKey"), P.INFO.DEAL,
    P.dealAad({ chainId, vault: v, id, secretRev, committeeId, fromEpoch, toEpoch, dealer, member: j, subCommitments: commitments }), th.scalarToBytes(sh.y)));
  return concatBytes(...commitments, ...sealed);
}

export function parseDeal(bytes, tNew, nNew) {
  const want = tNew * P.POINT_BYTES + nNew * P.SEALED_SHARE_BYTES;
  if (!(bytes instanceof Uint8Array) || bytes.length !== want) throw new Error(`a deal for t=${tNew}, n=${nNew} is ${want} bytes`);
  const subCommitments = P.splitCommitments(bytes.subarray(0, tNew * P.POINT_BYTES));
  const sealed = [];
  for (let j = 0; j < nNew; j++) { const o = tNew * P.POINT_BYTES + j * P.SEALED_SHARE_BYTES; sealed.push(bytes.subarray(o, o + P.SEALED_SHARE_BYTES)); }
  return { subCommitments, sealed };
}

// new member `member` (index in the new epoch): -> { bitmap, y, commitments } or throws naming why no source is possible
export function receiveDeals({ chainId, vault, id, secretRev, committeeId, fromEpoch, toEpoch, member, encPrivate, deals, oldCommitments, tOld, tNew, nNew }) {
  const v = String(vault).toLowerCase();
  const usable = [], rejected = [];
  for (let i = 0; i < deals.length && usable.length < tOld; i++) {
    const d = deals[i];
    if (!d || !d.length) continue;
    try {
      const { subCommitments, sealed } = parseDeal(d, tNew, nNew);
      const sub = th.bytesToScalar(hpke.open(encPrivate, P.INFO.DEAL,
        P.dealAad({ chainId, vault: v, id, secretRev, committeeId, fromEpoch, toEpoch, dealer: i, member, subCommitments }), sealed[member]));
      // the same two checks receiveReshare makes, per dealer, so one bad dealer is skipped rather than failing the whole set
      if (!th.verifyShare(member + 1, sub, subCommitments)) throw new Error("sub-share does not match its commitments");
      if (!th.secretPoint(subCommitments).equals(th.publicShare(i + 1, oldCommitments))) throw new Error("dealer re-shared a value that is not its share");
      usable.push({ xOld: i + 1, sub, subCommitments, dealer: i });
    } catch (e) { rejected.push({ dealer: i, reason: e.message }); }
  }
  if (usable.length < tOld) throw Object.assign(new Error(`only ${usable.length} usable deals (need ${tOld})`), { rejected });
  const r = th.receiveReshare({ xNew: member + 1, from: usable, oldCommitments, tOld });
  const bitmap = usable.reduce((b, u) => b | (1 << u.dealer), 0) >>> 0;
  return { bitmap, y: r.y, commitments: r.commitments, rejected };
}
