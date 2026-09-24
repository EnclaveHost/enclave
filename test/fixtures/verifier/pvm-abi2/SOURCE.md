ABI/2 pVM capture lines (`ABI2 runtime`, `ABI2 selftest`, `ABI2 binding`, `ABI2_LINK<i>[k]`) extracted from branch
pvm-cpu/portable-runtime at c43e79af, files shielded/anchor/avf/results/{app-m2c/ap-case1,app-m2/ap-baddigest,app-m3/an-selftest}.log,
by the pVM owner's direction (2026-09-24). Only the ABI2 lines are kept. Their nonce is the OWNER's challenge, not a relay's:
a passing check proves "binding verified", never "attested to a relay". ap-baddigest is a genuine certificate naming AppID 000...0
for a refused app: a must-refuse-by-policy fixture. Parsed with relay/pvm-app-attest.mjs abi2FromLog on that branch (not on main yet).
