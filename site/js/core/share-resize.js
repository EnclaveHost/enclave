// Hosts without in-place resizing can still take a fresh lease at a new size.
// Freeze the work item first, wait for an explicit lease release, then change
// shares. Lease expiry alone is NOT confirmation that the old instance stopped.
const ZERO_RUNNER = /^0x0{64}$/i;
export function leaseReleased(d) {
  return !!d && ZERO_RUNNER.test(String(d.runner || "")) && Number(d.leaseUntil) === 0;
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
    progress("Waiting for the host to stop the old instance and release its lease…");
    const deadline = now() + timeoutMs;
    while (true) {
      d = await read(); unchanged(d);
      if (d.active !== false)
        throw new Error("Suspension is not confirmed, or the deployment was resumed elsewhere. Shares were not changed.");
      if (leaseReleased(d)) break;
      if (now() >= deadline)
        throw new Error("The host has not released the old instance yet. Shares were not changed. Retry once it has stopped.");
      await sleep(3000);
    }
    progress(resume ? "Old lease released. Confirm the new shares and restart." : "No active lease. Confirm the new shares; the app will stay suspended.");
    await apply({ resume });
    return { resumed: resume };
  } catch (e) {
    if (paused) e.message += " The deployment may be suspended; check its status before using Resume.";
    throw e;
  }
}
