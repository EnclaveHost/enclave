import { Enclave, EnclaveError, WALLET_SESSION_KEY } from './api.js';
import { currentSession, relayRoot } from './sessions.js';
import { lsGet, emit } from './util.js';

export const hasFundingSession = () => Boolean(lsGet(WALLET_SESSION_KEY));

// A selected session is an explicit payer. Refusal, expiry, or a missing key
// must stop here rather than silently asking the owner's wallet to pay.
// The SDK quotes the relay fee and checks the live budget. The vault enforces
// ownership/delegation, environment, publisher-fee, rate and app restrictions.
export async function fundRuntimeFromSession(id, amountUsd, { required = false } = {}) {
  if (!hasFundingSession()) {
    if (required) throw new EnclaveError("The selected session is unavailable. No wallet payment was requested.", 0);
    return null;
  }
  if (!/^0x[0-9a-f]{64}$/i.test(id)) throw new EnclaveError('Invalid deployment id.', 0);
  const scaled = Number(amountUsd) * 1e6;
  if (!Number.isFinite(scaled) || !Number.isSafeInteger(Math.round(scaled)) || scaled < 10000)
    throw new EnclaveError('Fund at least $0.01 with a finite USDC amount.', 0);
  const amount6 = BigInt(Math.round(scaled));
  const c = await currentSession();
  if (!c) throw new EnclaveError('The selected session is unavailable. No wallet payment was requested.', 0);
  if (!Enclave.address || String(c.owner).toLowerCase() !== String(Enclave.address).toLowerCase())
    throw new EnclaveError('The selected session belongs to another wallet.', 0);
  const opened = String(c.record.relay || c.session.handle.relay || '').replace(/\/+$/, '');
  if (opened !== relayRoot().replace(/\/+$/, '')) throw new EnclaveError('The session belongs to another API endpoint.', 0);
  const result = await c.session.call('deploy.fund', { id, amount6 });
  emit('enclave:session', { active: true });
  return { ...result, payer: 'session', sessionId: c.session.handle.sid, amount6 };
}
