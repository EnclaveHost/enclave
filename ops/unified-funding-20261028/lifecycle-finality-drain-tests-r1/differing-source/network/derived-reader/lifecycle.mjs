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
    let closing;
    return { reader, snapshot, close() {
      if (!closing) closing = (async () => {
        const drained = snapshot.close();
        // Start reader cancellation as well: it owns readAnchor's native work.
        // Even if reader.close rejects, await the raw bridge callback before
        // reporting completion to the outer journal owner.
        let failure;
        try { await reader.close(); } catch (error) { failure = error; }
        await drained;
        if (failure) throw failure;
      })();
      return closing;
    } };
  } catch (e) { await reader.close(); throw e; }
}
