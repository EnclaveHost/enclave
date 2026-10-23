// Read-only public policy preparation. No signing, publishing, or chain writes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { quorumSnapshot } from '../windows-host-services-compose/candidate/network/host-policy-runtime.mjs';
import { readPolicyFacts, decodeAnchor } from '../windows-host-services-compose/candidate/network/platform-host-policy.mjs';
import { PRODUCTION_HOST_POLICY } from '../windows-host-services-compose/candidate/network/platform-host-policy-config.mjs';
import { httpPolicyMirrors } from '../windows-host-services-compose/candidate/network/host-policy-mirrors.mjs';
import { freshVerifier, fileCarrier } from '../windows-host-services-compose/candidate/network/policy-carriers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve('outputs/decentralization-audit/production-policy-carrier-preflight-20261023.json');
const cfg = PRODUCTION_HOST_POLICY;
const snapshot = quorumSnapshot({ rpcs: [...cfg.rpcs], minAgree: cfg.minAgree });
const receipt = {
  startedAt: new Date().toISOString(), sourceCommit: '0757085e5b78ed38efc11920fb3cf4a25d7dfc4d',
  chainId: cfg.chainId, book: cfg.book, hostOwnership: cfg.hostOwnership,
  status: 'checking', staged: false,
  limitations: [
    'Read-only observation through the existing public RPC quorum, not a cryptographic independent-chain proof.',
    'A staged signed document still requires a fresh anchor/current-owner check on every production admission.',
    'No production host configuration, policy publication, wallet signature, or contract state is changed.'
  ]
};
try {
  const facts = await snapshot(async at => ({
    ...await readPolicyFacts(at, { book: cfg.book, hostOwnership: cfg.hostOwnership }),
    block: String(at.block)
  }));
  receipt.observedAt = new Date().toISOString();
  receipt.owner = facts.owner;
  receipt.ownerIsContract = facts.ownerIsContract;
  receipt.registry = facts.registry;
  receipt.blockNumber = String(facts.blockNumber ?? facts.block);
  receipt.blockHash = facts.blockHash;
  receipt.anchor = decodeAnchor(facts.anchorHi, facts.anchorLo);
  if (receipt.anchor.state !== 'anchored') {
    receipt.status = 'no-anchored-policy-to-stage';
    receipt.next = 'Review the existing administrator enforcement and prepare a concrete policy/rollout before activating the global anchor. Do not fabricate or sign a policy automatically.';
  } else {
    const results = await Promise.allSettled(httpPolicyMirrors([...cfg.mirrors]).map(read => read(receipt.anchor.digest)));
    receipt.mirrors = results.map((result, i) => ({ url: cfg.mirrors[i], answered: result.status === 'fulfilled', candidates: result.status === 'fulfilled' ? result.value.length : 0 }));
    const candidates = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    const verify = freshVerifier({ snapshot, book: cfg.book, hostOwnership: cfg.hostOwnership });
    const checked = await verify(candidates);
    const accepted = checked.verified.find(c => c.anchored && c.digest === receipt.anchor.digest);
    if (!accepted) throw new Error('No fetched document verified against the current owner and anchor');
    const dir = path.join(here, 'import'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify({ document: accepted.document, signature: accepted.signature }, null, 2) + '\n';
    const file = path.join(dir, accepted.digest + '.json');
    if (fs.existsSync(file)) {
      if (fs.readFileSync(file, 'utf8') !== bytes) throw new Error('Existing staged envelope differs; review required');
    } else fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    // Re-read the prepared file through the shipping carrier, then recheck fresh
    // authority. This is local staging, not deployment or an enduring admit.
    const rechecked = await verify(await fileCarrier(dir)(accepted.digest));
    if (!rechecked.verified.some(c => c.anchored && c.digest === accepted.digest)) throw new Error('Staged carrier failed fresh authority recheck');
    Object.assign(receipt, { status: 'signed-policy-staged-locally', staged: true, digest: accepted.digest,
      sequence: accepted.sequence, verifiedAtBlock: rechecked.block, envelopeSha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes) });
  }
} catch (error) {
  receipt.status = 'preflight-unavailable';
  receipt.error = String(error.code || error.message || error).slice(0, 240);
  process.exitCode = 2;
} finally {
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}
