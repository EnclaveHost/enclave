Step 4b of isolation/restore/ENABLEMENT.md (rev 6.1): a config- and secret-bearing acceptance deployment on a69dcbba's
app/version (api-mcp-adapter 1.0.0), owned by the agent wallet, NON-SENSITIVE per-run values. Executed by enclave-63
(the SNP executor, enclave-87's go for create/fund/refund). ACCEPTED by enclave-87 with one condition (below).
Deployment 0x6b1781ff95a6fdf54afc69795c4e47fa1973a597848edfa61b32722c271a0286.
  create tx 0x81989e12a0f9b513127a6d3bc222d54669da6eab849b55891ea08223581e2519 (block 51796804)
  fund   tx 0x1df79c9a30ef68efd8d13193781d682b5a3268e9c6259595a00e0a5805bc3ce9 (block 51796852), 0.01 USDC; refunded at teardown
The CLI's first secrets staging (relay 404) and fund (gas estimate reverted "unknown" = EnclaveDeployments
_requireActive: require(_exists[id])) ran before the create was visible (read-after-write); the failed fund was never
mined (wallet nonce 325 -> 327 = create + fund). Retried once each (enclave-87 informed).
Proofs (4b.txt, run1/evidence.txt; 5d's accept-4b.sh 083464ae for 3-7, enclave-63's 4b-check.sh for the rest):
  record ok; names ACCEPT_API_KEY + ACCEPT_TOKEN; negative control: refused while unlisted ("carries app config"), no guest;
  listed ONLY this id (relay-list.sh 3afbae85, e3-approved; list-add.txt) -> release guest gdea8df09e;
  1+9 one release to a verified guest (runtime ccadb38a), one ticket; 2 attested, measurement 20319b02...a83ef47 = the
  relay's prediction = a69dcbba's; 3 envelope tag c6a08a1bb04c65bb, 2 origins, config EXACTLY 628 B resolved;
  4 200 with the key / 401 without / 401 with the literal; 5 one capture, token sha = the staged token's;
  6 off-list egress refused in the guest; 8 public TLS via us-west on the guest key through the gate;
  7 0 value hits in the test guest's serial, hookbin's serial and nan's api-relay journal, each readable.
PROOF 7 CONDITION: the script's warden-host user-journal channel read 0 lines (a UTC timestamp passed to journalctl
--since without a zone; warden-host is America/Phoenix) and FAILED CLOSED. Re-read by hand with "<ts> UTC": 48 lines,
7 naming the test id, 0 value hits. enclave-87 accepted on condition that 5d's FIXED script (recheck7, the value-format
pattern acc-[0-9a-f]{24}, since teardown deleted the values file as designed) re-runs proof 7 over the recorded window;
its output is committed here as proof 7's record when it lands. The test guest's serial channel is the AT-RUN reading
(readable, 0 hits): its directory was reclaimed at teardown.
Teardown: bin deleted, secrets cleared, 0.01 refunded, cancelled, unlisted (list-remove.txt); gone check ok.
