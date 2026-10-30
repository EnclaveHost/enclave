// These tests require pinned native verifier binaries and captured Base evidence.
// They retain their own refusal/pin assertions and run in a network namespace.
export const rpcQualificationFiles = [
  'gossip-head-source.test.mjs',
  'helios-base-head.e2e.test.mjs',
  'helios-base-replay.e2e.test.mjs',
  'helios-block-failover.e2e.test.mjs',
  'helios-real-history.e2e.test.mjs',
  'helios-s3-replay.e2e.test.mjs',
  'helios-witness-failover.e2e.test.mjs',
  'helios-witness.e2e.test.mjs',
  's3-witness-archive.test.mjs',
  's3-witness-history.test.mjs',
  'witness-ancestry.test.mjs',
  'witness-failover.test.mjs',
  'witness-blocks.test.mjs',
  'witness-deadline.test.mjs',
  'witness-archive-deadline.test.mjs',
];
