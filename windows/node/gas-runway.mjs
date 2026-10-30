// windows/node/gas-runway.mjs -- how long a host's operator key lasts on its gas, shared by every host agent that pays its
// own transactions (the Windows node, host.mjs; the phone's host agent, shielded/anchor/avf/runner/host-agent.mjs).

/**
 * gasRunway(samples, wei, now) -> { renews, burnPerHour, hoursLeft, low }: how long the operator key's gas lasts.
 * Renewals are not the whole bill: proof-of-time checkpoints (every app, every few minutes), registry updates and claims spend
 * from the same key, so the runway is MEASURED - the balance's fall over the last ~6 hours, restarted by a top-up - and
 * the renewal count is only the fallback before half an hour of samples exists (2026-10-13: "about 200 renewals" was
 * ~7 hours with 7 apps proving, and the NucBox ran dry behind nothing but a log line). `samples` is the caller's array,
 * appended to here. Low = under 48 hours measured, or under 200 renewals unmeasured.
 */
export function gasRunway(samples, wei, now) {
  const renews = wei / 400000000000n;                  // ~1 renewal's gas, rounded up
  if (samples.length && wei > samples[samples.length - 1].wei) samples.length = 0;   // topped up: a new window
  samples.push({ at: now, wei });
  while (samples.length > 2 && now - samples[1].at > 6 * 3600_000) samples.shift();
  const first = samples[0], hours = (now - first.at) / 3600_000;
  const burnPerHour = hours >= 0.5 && first.wei > wei ? Number(first.wei - wei) / hours : null;
  const hoursLeft = burnPerHour ? Number(wei) / burnPerHour : null;
  return { renews, burnPerHour, hoursLeft, low: hoursLeft !== null ? hoursLeft < 48 : renews < 200n };
}
