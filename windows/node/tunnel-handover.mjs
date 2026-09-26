// tunnel-handover.mjs - which relay tunnel serves this node, across a RE-ATTACH that must not take the node off the relay.
//
// The relay learns whom an hv-node serves only at attach, so an owners change (a delegation added, removed or expired)
// reaches it only through a new attach (hvnode-attach.mjs shouldReattach). The node used to END its live tunnel and dial
// again: from the close to the new attach's acceptance - the 5 s redial pause, then a full TPM attach - the relay held NO
// tunnel for the name, so every app on the box answered 404 and its row left /enclaves (enclave-5d, TEST2: absent in the
// 04:23:15Z sample; bf's outside acceptance: 404 at 04:23:12Z).
//
// The relay binds the NEWEST attested socket for a name and terminates the one before it, and only once the new one's
// attestation is accepted (relay/tunnel.js bind, "newest wins"; a different transport key is refused: "that name is held
// by another enclave"). So a re-attach can be make-before-break: dial a STANDBY tunnel while the current one serves, and
// let it take over when the relay accepts it. Nothing is lost in between; only requests in flight on the old tunnel end.
//
// This is the bookkeeping for that, kept apart from agent.mjs so it can be tested:
//   opened(s, { standby })  a dial started; a non-standby dial is the serving tunnel from the start
//   accepted(s)             the relay accepted s's attach -> the session s replaces (the caller drops what it carried
//                           and closes it), or null
//   closed(s)               s closed -> { lost, redial }: lost = the serving tunnel is gone (the node is off the relay
//                           until a new attach is accepted); redial = nothing else is in flight to replace it
//   canReattach()           a standby may be dialled: one serves, and none is in flight
export function tunnelHandover() {
  let current = null, standby = null;
  return {
    opened(s, { standby: sb = false } = {}) {
      if (sb) standby = s;
      else current = s;
    },
    accepted(s) {
      if (s !== standby) return null;                // the serving tunnel's own (first) attach
      const old = current;
      current = s; standby = null;
      if (old) old.superseded = true;
      return old;
    },
    closed(s) {
      if (s === standby) {                           // a replacement that never took over
        standby = null;
        return { lost: false, redial: !current };    // ...the old one still serves, unless it was lost meanwhile
      }
      if (s !== current) return { lost: false, redial: false };   // superseded: the relay serves its replacement
      current = null;
      return { lost: true, redial: !standby };       // a standby in flight IS the redial
    },
    canReattach: () => !!current && !standby,
    get current() { return current; },
    get standby() { return standby; },
  };
}
