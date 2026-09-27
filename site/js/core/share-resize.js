// Hosts without in-place resizing can still take a fresh lease at a new size.
// Suspend first, then wait until the old lease is released or expired, matching
// the contract's claim/renew rules. Expired runners need not call release (the
// reaper does not), so demanding zeroed fields strands abandoned deployments.
// This is a lease check, not proof of physical teardown; runtime fencing remains
// the host's responsibility, as with normal expired-lease failover.
const ZERO_RUNNER = /^0x0{64}$/i;
export function leaseReleased(d) {
  return !!d && ZERO_RUNNER.test(String(d.runner || "")) && Number(d.leaseUntil) === 0;
}
export function leaseAvailable(d) {
  if (leaseReleased(d)) return true;
  const until = Number(d?.leaseUntil), chainTime = Number(d?.blockTimestamp);
  return d?.leaseUntil != null && Number.isSafeInteger(until) && until >= 0
    && Number.isSafeInteger(chainTime) && chainTime > 0 && until < chainTime;
}
export async function resizeAfterStop({ expected, read, suspend, apply, progress = () => {},
  sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, timeoutMs = 180000 }) {
  const unchanged = d => {
    if (!d || String(d.owner).toLowerCase() !== String(expected.owner).toLowerCase()
      || d.appRef !== expected.appRef || Number(d.gpuMilli) !== Number(expected.gpuMilli)
      || Number(d.cpuMilli) !== Number(expected.cpuMilli))
      throw new Error("The deployment changed while Shares was open. Reopen the tab before trying again.");
  };
  let d = await read(); unchanged(d);
  const resume = d.active === true;
  let paused = !resume;
  try {
    if (resume) {
      progress("Confirm suspension in your wallet. The app will stop briefly; its URL and balance are retained.");
      await suspend();
      paused = true;
    }
    progress("Waiting for the current lease to be released or expire…");
    const deadline = now() + timeoutMs;
    while (true) {
      d = await read(); unchanged(d);
      if (d.active !== false)
        throw new Error("Suspension is not confirmed, or the deployment was resumed elsewhere. Shares were not changed.");
      if (leaseAvailable(d)) break;
      if (now() >= deadline)
        throw new Error("The current lease is still held. Shares were not changed. Retry after it is released or expires.");
      await sleep(3000);
    }
    progress(resume ? "No live lease remains. Confirm the new shares and restart." : "No active lease. Confirm the new shares; the app will stay suspended.");
    await apply({ resume });
    return { resumed: resume };
  } catch (e) {
    if (paused) e.message += " The deployment may be suspended; check its status before using Resume.";
    throw e;
  }
}
