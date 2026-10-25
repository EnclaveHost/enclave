# Candidate only: no finality authority or lease-reader cutover

The wrapper and 14 unit tests plus negative real-binary probe are retained for review. No successful mainnet light-client sync, reproducible binary-to-source provenance, restart supervisor or checkpoint rollover has been established. Do not install this as a production authority yet.

The recommendation to use one self-operated Base node changes the existing quorum trust assumption. Root has not approved that authority change or the report's assertion that it preserves privacy. An Ethereum light-client cross-check does not establish Base derivation, Base state correctness or completeness of Base lease logs. Existing writer fencing and its production path remain unchanged.

The report's capacity conclusion is limited to adding another large guest with current free RAM. Replacing the existing 64 GiB ordinary RPC VM with an independently measured deployment has not been assessed; it is not proven impossible on this hardware. No additional allocation or VM conversion is authorized by this document.

The experimental complete-log helper below is preserved source, not a proof verifier: callers still need authenticated anchors and independent header/receipt-root recomputation. It is not wired to any runtime. Game-finality lease latency has not been accepted.
