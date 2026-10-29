// Shared by Linux and Windows lifecycle runners. This is a pure, serializable
// policy: the caller MUST durably commit a returned state before starting a VM.
// Failures count across host-process restarts and assignment generations. An
// owner-authorized resume is explicit; merely waiting never clears a crash loop.
export const RESTART_POLICY = Object.freeze({ baseMs: 5000, maxMs: 300000, maxFailures: 5, healthyMs: 600000 });

const integer = (v, name, min = 0) => {
  if (!Number.isSafeInteger(v) || v < min) throw new Error(`invalid ${name}`);
  return v;
};

export function restartPolicy(p = RESTART_POLICY) {
  for (const k of ['baseMs', 'maxMs', 'maxFailures', 'healthyMs']) integer(p[k], k, 1);
  if (p.baseMs > p.maxMs || p.maxMs > 3600000 || p.maxFailures > 100 || p.healthyMs > 86400000)
    throw new Error('invalid restart policy bounds');
  return { baseMs: p.baseMs, maxMs: p.maxMs, maxFailures: p.maxFailures, healthyMs: p.healthyMs };
}

export const initialRestartState = () => ({ version: 1, failures: 0, nextAt: 0, healthySince: null,
  lastFailure: null, lastNow: 0, held: false });

export function validateRestartState(s) {
  if (!s || s.version !== 1 || typeof s.held !== 'boolean') throw new Error('invalid restart state');
  for (const k of ['failures', 'nextAt', 'lastNow']) integer(s[k], k);
  if (s.healthySince !== null) integer(s.healthySince, 'healthySince');
  if (s.lastFailure !== null && (typeof s.lastFailure !== 'string' || !s.lastFailure.length || s.lastFailure.length > 256))
    throw new Error('invalid failure identity');
  if (s.healthySince !== null && s.healthySince > s.lastNow) throw new Error('healthy clock is ahead');
  return { version: 1, failures: s.failures, nextAt: s.nextAt, healthySince: s.healthySince,
    lastFailure: s.lastFailure, lastNow: s.lastNow, held: s.held };
}

function tick(state, now) {
  const s = validateRestartState(state);
  integer(now, 'now');
  // Clock rollback cannot shorten cooldowns or manufacture healthy uptime.
  if (now < s.lastNow) throw new Error('restart clock moved backwards');
  return { ...s, lastNow: now };
}

export function restartFailure(state, { identity, now, random = Math.random, policy = RESTART_POLICY }) {
  const s = tick(state, now), p = restartPolicy(policy);
  if (typeof identity !== 'string' || !identity.length || identity.length > 256) throw new Error('invalid failure identity');
  // Reconciliation may observe the same ended instance many times. Charge the
  // restart budget once, and never move its deadline on repeated observations.
  if (s.lastFailure === identity) return s;
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('invalid jitter');
  const failures = s.failures + 1;
  integer(failures, 'failures');
  const delay = Math.min(p.maxMs, p.baseMs * 2 ** Math.min(failures - 1, 30));
  // Equal jitter: half to all of the exponential delay, never a zero retry.
  const nextAt = now + Math.ceil(delay * (0.5 + draw / 2));
  integer(nextAt, 'nextAt');
  return { ...s, failures, nextAt, healthySince: null, lastFailure: identity,
    held: s.held || failures >= p.maxFailures };
}

export function restartHealthy(state, { now, policy = RESTART_POLICY }) {
  const s = tick(state, now), p = restartPolicy(policy);
  // A held app cannot reset itself by reporting one successful health probe.
  if (s.held) return s;
  const healthySince = s.healthySince ?? now;
  if (now - healthySince < p.healthyMs) return { ...s, healthySince };
  return { ...initialRestartState(), lastNow: now, healthySince };
}

export function restartUnhealthy(state, now) {
  return { ...tick(state, now), healthySince: null };
}

export function restartDecision(state, now) {
  const s = tick(state, now);
  if (s.held) return { start: false, reason: 'repeated crashes; owner resume required', nextAt: null };
  if (now < s.nextAt) return { start: false, reason: 'restart backoff', nextAt: s.nextAt };
  return { start: true, reason: null, nextAt: null };
}

// Authorization belongs at the owner API boundary, never a boolean supplied by
// an untrusted host. Keep this operation distinct from automatic health/retry.
export function ownerResumeRestartState(state, now) {
  tick(state, now);
  return { ...initialRestartState(), lastNow: now };
}
