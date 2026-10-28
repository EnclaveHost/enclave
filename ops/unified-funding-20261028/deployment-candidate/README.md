# Additive funding deployment preparation

Unsigned and not signable. Never execute the proposal against production from these tools. prepare-bundle.mjs only allows read-only Base RPC methods; replay-fork.mjs only mutates its own loopback Anvil using public test impersonation, never a production signer.

Build the adjacent reviewed session-candidate and relay-owner-candidate first. Run the read-only builder under the shared memory queue, then review the complete constructor/nonce proposal. The four-transaction local Base-fork replay passed with exact deployed runtime and constructor checks; see FORK-REPLAY-r2.json and REPLAY-NOTE.md. The first attempt hit HTTP 429 before deployment and is retained. Packaged linked initcode was independently regenerated and matched the stage proposal byte-for-byte. All nonce, address and fee observations remain provisional and must be refreshed before production approval. All output files use exclusive creation: use fresh reviewed output filenames for reruns.

No private keys, old grant mutation, address-book replacement or funding authority is conveyed by these files. See ACTIVATION-AND-ROLLBACK.md for the grant, funding migration and deployment gates.
