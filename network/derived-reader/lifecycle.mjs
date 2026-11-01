// In-domain reader capability only; HTTP status JSON is not proof authority.
import { startDerivedReader } from './provider.mjs';
import { createLifecycleFinalitySnapshot } from '../lifecycle-finality-bridge.mjs';

export async function startDerivedLifecycleReader(config, { verifier, journalOwner, ...options } = {}) {
  if (typeof journalOwner?.onRelease !== 'function' || typeof journalOwner?.journal?.readAnchor !== 'function' ||
      typeof journalOwner?.journal?.acceptAnchor !== 'function')
    throw Error('owned lifecycle journal with withdrawal registration required');
  const journal = journalOwner.journal, cancellation = new AbortController();
  let reader, snapshot, starting, stopped = false, closing;
  function close() {
    if (!closing) {
      stopped = true; cancellation.abort();
      const drained = snapshot?.close();
      closing = (async () => {
        // Startup may ignore cancellation. Keep the parent's lock until the
        // actual result can be closed; never publish it after owner loss.
        await starting?.catch(() => {});
        let failure;
        try { await reader?.close(); } catch (error) { failure = error; }
        await drained;
        if (failure) throw failure;
      })();
    }
    return closing;
  }
  journalOwner.onRelease(close); // BEFORE startup or publication, not after an await
  try {
    journal.readAnchor(8453); // Refuse an already closed/lost owner before native startup.
    const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
    starting = startDerivedReader(config, { ...options, signal }).then(value => { reader = value; return value; });
    await starting;
    if (stopped || signal.aborted) throw Error('derived lifecycle reader closed during startup');
    snapshot = createLifecycleFinalitySnapshot({ readAnchor: reader.readAnchor, verifier, journal,
      maxAnchorAgeSec: config.maxAnchorAgeSec ?? 1800, now: options.now || Date.now });
    return Object.freeze({ reader, snapshot, close });
  } catch (error) { await close(); throw error; }
}
