# Completed fixture relocation

Two completed October 26 Windows proof-test repository copies were moved from root to `/vm/enclave-volumes/rpc-completed-fixtures-20261027-1911`. These are the earlier failed test runs; their results were not altered or presented as passes. Their logs and receipts remain on root. The repositories are preserved in full and remain accessible at their original paths through symlinks.

The operation checked the NVMe mount and capacity, copied with `rsync -aH`, verified all contents/attributes and extra paths with a checksum dry run (`rsync -aHnci --delete`, empty output), synchronized the destination, and only then replaced each original directory with a symlink and removed that verified duplicate. No chain data, recovery parts, snapshots, or USB files were moved or removed. This restores root headroom for later validation while retaining the full 8 GiB native reservation and 40 GiB disk floors.

The receipt records actual before/after capacity. This is storage housekeeping, not structural, state, canonical or RPC readiness evidence. The script is a historical one-shot operation and deliberately refuses if the destination already exists.
