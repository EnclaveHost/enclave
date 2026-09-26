S5: guestd's -isolation tree switch to the FIXED release 52156652 (image 4cdd5169: the front console guard; enclave-53's
build, bf GO), so the canaries (then Steven's apps) launch on a release whose front keeps the app's bytes off the host
console (enclave-d1's finding on 79c5ecf2). enclave-63's scripts, derived from the reviewed s4 set (diff-from-*.diff).
DONE, inert: s5-install.sh (00:50Z: the tree clean at 4cdd5169, the release copy verified as 52156652, the tree
reproduces it on warden-host; guestd and the canaries unchanged); s5-adoption-preflight.sh (00:52Z, read-only: the 3
canaries, RELEASE guests on 79c5ecf2, verify with the NEW tree's judge; runtime identity and fwd byte-equal).
REVIEWED: bf GO on v3 (bf's catch: lib-e4.sh sourced last clobbered REL to 79c5ecf2, which would have made the relay
guard vacuous; fixed by sourcing lib5.sh last plus a re-pin and an assertion); v4 changes only the rollback's comment
(after any e5 acceptance its gate needs OVERRIDE). enclave-87 GO, conditional on e3's admission of 52156652. NOT RUN yet.
RUN: s5t-apply-20260926T010828Z, rc 0 (01:08:58Z), after e3's rs-5 (52156652 admitted, 01:07:47Z). The in-run adoption
preflight 3/3; guestd restart 01:08:37Z, -isolation iso-aa6c985c -> iso-4cdd5169; "adopted 3 guest(s) ... each verified
again as the same guest"; the gate passed 6 rounds over 616 s (5t-observe.txt, 4e keys).
