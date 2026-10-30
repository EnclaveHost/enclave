# Exact binary help and candidate memory settings

ONE read-only invocation58cced09c5004f518ceb66723730ad70 completed successfully. Each exact historical payload binary hash checked before and after help-only execution. Base rpc --help, Reth node --help, Lighthouse bn --help all exit0. Network namespace isolated, no datadir/client/node/database startup. Shared256MiBhard220RSSfloor27648CPU1noSwap; inner peak18MiB/min34182. This proves option support/defaults for these payload bytes, not current installed config or memory use.

Both Base and Reth report engine.cross-block-cache-size default4096MB and RPC database concurrency512. Base persistence default7 blocks differs from Reth50. Lighthouse state-cache-size default128. CandidateBase512MB/Reth256MB cross-block budgets sum768MiB versus8192MiB default:7424MiB less configured capacity, NOT measured resident saving. Small RPC caches/concurrency8/blocking-IO4 and Lighthouse state cache16 are proposed, not installed/qualified. No change to durability, pruning, custody/blob capability or validation.

Initial candidate static check caught a real version mismatch: Reth2.8 does not expose Base's max-headers flag. Failure retained in PROFILE-CORRECTION; final profile uses verified per-binary flags. Reth also exposes byte bounds for blocks/receipts/BAL; Base only count bounds here. All final candidate flags checked against exact output, values remain experimental.

Cached Base-reth7134be3 config has2GiB bodies buffer and large execution batches. This is source evidence, not effective installed TOML or L1 defaults; any TOML edit awaits actual config inspection and parser evidence. No such settings changed.

No combined guest size admitted. Existing resize helper16GiB mode is download-only and cannot qualify a full node. Maintenance repair remains active. No VM, image access or production switch performed.
