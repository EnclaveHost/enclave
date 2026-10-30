// The custodian's MEASURED chain configuration (custody/v2/daemon.mjs). scripts/build-custodian-v2.mjs writes the
// production values into the bundle; these defaults are a placeholder that fails closed (no vault).
export const MEASURED = Object.freeze({
  chainId: 8453,
  vault: "0x0000000000000000000000000000000000000000",
  rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base"],
  minAgree: 2,
  maxAgeSec: 120,
  enclaveOwner: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61",
});
