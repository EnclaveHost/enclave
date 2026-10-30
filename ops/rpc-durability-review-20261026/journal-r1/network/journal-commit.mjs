// Only a trusted in-domain adapter may implement this hook. Returning true must
// mean these exact bytes have reached a committed replica majority. A local
// write, an IPC request queued for delivery, or an HTTP response is insufficient.
// This module neither discovers replicas nor authenticates archive recovery.
import { createHash } from 'node:crypto';
export const journalBytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateJournalCommit({ commit, requireCommit = false, commitTimeoutMs = 10000 }) {
  if ((commit != null && typeof commit !== 'function') || requireCommit && typeof commit !== 'function')
    throw Error('trusted durable journal commit adapter required');
  if (!Number.isInteger(commitTimeoutMs) || commitTimeoutMs < 1 || commitTimeoutMs > 30000)
    throw Error('invalid durable journal commit timeout');
}
export async function commitJournalBytes(commit, { file, bytes, signal }, commitTimeoutMs = 10000) {
  signal?.throwIfAborted();
  if (!commit) return;
  const copy = Buffer.from(bytes), sha256 = journalBytesDigest(copy), controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let timer, onAbort;
  const deadline = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason || Error('journal commit aborted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => controller.abort(Error('durable journal commit timeout')), commitTimeoutMs);
  });
  try {
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return commit(Object.freeze({ file, bytes: copy, sha256, signal: controller.signal }));
    });
    const accepted = await Promise.race([work, deadline]);
    controller.signal.throwIfAborted(); signal?.throwIfAborted();
    if (accepted !== true || journalBytesDigest(copy) !== sha256) throw Error('exact journal bytes were not durably committed');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort); controller.abort();
  }
}
