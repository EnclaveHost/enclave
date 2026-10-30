// The lifecycle bridge receives the in-process reader capability, never its
// HTTP status/anchor JSON. State remains independently executed/proven by the
// existing local Base verifier at the exact derived block hash.
import { startDerivedReader } from './provider.mjs';
import { createLifecycleFinalitySnapshot } from '../lifecycle-finality-bridge.mjs';
export async function startDerivedLifecycleReader(config, { verifier, journal, ...options }) {
  const reader = await startDerivedReader(config, options);
  try {
    const snapshot = createLifecycleFinalitySnapshot({ readAnchor: reader.readAnchor, verifier, journal,
      maxAnchorAgeSec: config.maxAnchorAgeSec ?? 1800, now: options.now || Date.now });
    return { reader, snapshot, close: reader.close };
  } catch (e) { await reader.close(); throw e; }
}
