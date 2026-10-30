# Refund post-state review

Read-only API + Azul agree at block 53272441 / 0x71c863da896746253e5e2e657401228242c469920ddff3e608c51dd12f1e1fe1. Exact pinned ledger/vault/factory/reserve identities checked by the deployed migration reader. No signature or transaction submitted by this read.

DNS refund transaction 0x366ff41ca1f118bc71be828ccedb3e591e5bf100f4ae8be1a626756d767c645b, block 53272262, log211: 4799124 microUSDC sent to B794. Runtime zero/inactive; owner escrow50876, runner escrow111600, refundable0. Do not repeat refund. Lease is still attached to runner2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a, operator1a01194c34fe3577c6d0a54feb78af6253e494e0. It must be released before remaining refundable tail/transfer can be qualified. Old reserve1052268502151wei retained.

KVM at the same block remains active, balance5190014, owner/runner escrow5055558, refundable4425558, no refund event in bounded window. Same runner/operator; old reserve959970768583wei. User confirmation is prepared in tab723101026; no KVM refund inferred from that preparation.

A62 transaction02fcaf17c60f3890252202d4f66f39712fe453955dd1a992ebefef4e23f8c437 receipt success53272106 agrees; still above both providers' finalized block. No replay.

One invocationde29925f61fb43f78f5fff9cc6e2faae terminal exit0. 256MiB hard/220RSS/floor27648/CPU1/noSwap/shared queue, peak91inner152outer/min31609. Six direct input pins unchanged (not a complete new npm dependency attestation). Logs/event window <=2500 blocks; no full history scan. Two-provider agreement is not cryptographic finality, fresh transaction authority, or proof of loaded host code.
