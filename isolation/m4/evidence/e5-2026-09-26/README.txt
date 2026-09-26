e5: the 3 canaries relaunch one at a time from their 79c5ecf2 release guests onto 52156652, after the S5 switch (derived
from the 4e scripts; diff-from-e4-*.diff, diff-v2-*.diff). Proof 2 compares the guest's measurement to BOTH a pinned value
computed independently with the installed tree's expected-measurement.sh --pin 52156652 (the same command with 79c5ecf2
reproduces the live measurements exactly) AND the relay's prediction (enclave-bf, enclave-87: never only the relay's).
  0ddbd824 f4fb208aedddf04b...b91dc11f; 395bed3e / 4e62e60d 5f2f238c88e1ae55...8f5b5e8e
Proof 6 (hookbin, enclave-87): control = its 79c5ecf2 serial logs "Unsolicited response ..." for a HEAD with a body (seen
00:47Z); after the relaunch one HEAD must raise the count of "DOM front: unsolicited upstream response (" lines with no
"Unsolicited response" line. bf GO (with the pin). NOT RUN yet.
