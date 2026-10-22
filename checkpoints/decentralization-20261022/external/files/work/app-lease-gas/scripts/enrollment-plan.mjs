// RETIRED (round 3, 2026-10-20). The round-2 illustrative plan generator (hard-coded 0.003 ETH per app, obsolete host
// env and patch paths) is no longer runnable. The original is preserved in snapshots/round2 (see its MANIFEST.sha256).
// Use the owner CLI's no-default budget workflow instead - the owner chooses the amount:
//   enclave --independent --profile … --profile-digest sha256:… --rpc A,B lease-gas plan \
//     --inventory outputs/storage-adapter-incident/self-hosted-inventory.json \
//     --lease-gas RECORD.json --lease-gas-digest sha256:… --max-gas-price-gwei G (--per-app-eth X | --per-app-wei N | --days N)
// (cli/lease-gas.mjs; the ten exact IDs on a Base fork: scripts/fork-ten-app-plan.mjs -> plans/ten-app-cli-plan.*).
console.error("scripts/enrollment-plan.mjs is RETIRED: use `enclave --independent … lease-gas plan` (see this file's header)");
process.exit(2);
