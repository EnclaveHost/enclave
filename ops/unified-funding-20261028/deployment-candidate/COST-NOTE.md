# Deployment cost observation

Two read-only providers agreed at Base block 53207080 on owner latest/pending nonce1175, dependencies, feed and costs. The four replay-derived gas limits and proposed L2 caps total 0.000296741375516599 ETH including observed L1 upper bounds and operator charges, approximately $0.691265 at that feed. Owner balance covered the observation. This is not a fixed inclusion-time fee, reservation, spend or approval: refresh before every signature. No server signing client exists.

read-cost.mjs is the reviewed stage reader with only package imports adapted. Earlier observations preserve BigInt fixture/API-rate-limit failures; the successful r3 corrected numeric conversion and throttled requests. L2 caps are explicit; L1/operator/feed values may change. Creation serial-size bounds are separately checked without raising the funding policy calldata limit. Fixed r3 output uses exclusive creation and refuses overwrite; archive/copy to a new controlled run directory for future observations.

Existing session recheck at block53206775 agreed live,30USDC balance,zero spent; no mutation. This old grant cannot perform action10 or contract deployment. No additional budget, withdrawal, termination or custody transfer has been requested or performed.
