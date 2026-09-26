e5: the 3 canaries relaunch one at a time from their 79c5ecf2 release guests onto 52156652, after the S5 switch (derived
from the 4e scripts; diff-from-e4-*.diff, diff-v2-*.diff). Proof 2 compares the guest's measurement to BOTH a pinned value
computed independently with the installed tree's expected-measurement.sh --pin 52156652 (the same command with 79c5ecf2
reproduces the live measurements exactly) AND the relay's prediction (enclave-bf, enclave-87: never only the relay's).
  0ddbd824 f4fb208aedddf04b...b91dc11f; 395bed3e / 4e62e60d 5f2f238c88e1ae55...8f5b5e8e
Proof 6 (hookbin, enclave-87): control = its 79c5ecf2 serial logs "Unsolicited response ..." for a HEAD with a body (seen
00:47Z); after the relaunch one HEAD must raise the count of "DOM front: unsolicited upstream response (" lines with no
"Unsolicited response" line. bf GO (with the pin). NOT RUN yet.
RUN (2026-09-26, enclave-63 executor): hookbin 0ddbd824 restart 01:20:01Z -> guest gda3193060. Run 1 HELD on proof 1
(the relay logged one "no prediction (ticket kept)" warming 503 before the one release: the release predicts over the
ADMITTED set, a cold cache key after rs-5, e3). enclave-87 restated proof 1 (exactly one release; kept lines only before
it, within 60 s; no refused/burned; bf's capture incl. "ticket for <id> presented" and "presented for <id>"): e5-proofs
v4 66a48faf, tested on the real window + 10 bad cases, bf GO. Re-run: ALL PROOFS PASS 01:29:54Z incl. proof 6: the HEAD
that on 79c5ecf2 logged hookbin's 404 body verbatim now logs "DOM front: unsolicited upstream response (119 bytes
withheld)" and 0 "Unsolicited response" lines. ACCEPTED 01:40:08Z. 395bed3e restart 01:40:40Z -> gdc71431bd, ACCEPTED
01:52:46Z. 4e62e60d restart 01:53:18Z -> gd41d9ab25, ACCEPTED 02:09:50Z. Each measurement = the pinned independent value
= the relay's prediction (f4fb208a / 5f2f238c).
