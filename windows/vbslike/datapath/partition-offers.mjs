// partition-offers.mjs - what a per-app Hyper-V partition CAN be given, as node-bridge.mjs's isolationPlan lets it
// through. The node's /availability features and its claim gate read this (host.mjs features), so a box on the isolated
// backend never advertises a capability its own plan then refuses (enclave-87, from d1's live node at 013deb51:
// secrets, secretsInConfig, configOverride and customDomains were all advertised true).
//
// Each value is the PLAN's answer; host.mjs ANDs it with the manager's own /health `supports`, so a feature is offered
// only when both the node's plan and the manager would honour it. Every false here is a refusal in isolationPlan (or a
// constant of the spawn body / the splice route), and test/windows-node-availability-flags.test.mjs holds the two together.
export const PARTITION_OFFERS = Object.freeze({
  secrets: false,        // isolationPlan: "the deployment has staged secrets ... cannot deliver them into a partition"
  config: false,         // isolationPlan: config beyond _media is not delivered into a partition
  configCid: false,      // isolationPlan: a config override CID, or a version keeping its config at a CID, is refused
  waf: false,            // isolationPlan: protection rules need the request's plaintext, which only the partition has
  customDomains: false,  // the splice serves only <label>.<zone> (isolatedTarget expectName); no other hostname reaches it
  gpu: false,            // isolationPlan: a partition has no GPU path
  privateDeployments: false,   // isolationPlan: a private deployment's owner gate needs plaintext
  egress: false,         // the spawn body carries egress "" (isolationPlan): no network options reach a partition
  volumes: false,        // isolationPlan: model volumes are not mounted into a partition
});
