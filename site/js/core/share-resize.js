// Save the allocation and suspension atomically, before waiting for teardown.
// A stalled/closed browser must never leave an app stopped at its OLD size.
// Requeue only after release/expiry; the host still owns physical fencing.
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
export async function resizeAfterStop({ expected, target, read, apply, resume, progress = () => {},
  saved = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, timeoutMs }) {
  expected = { ...expected };
  const identity = d => {
    if (!d || String(d.owner).toLowerCase() !== String(expected.owner).toLowerCase() || d.appRef !== expected.appRef)
      throw new Error("The deployment owner or version changed. Reopen Resources before trying again.");
  };
  const matches = (d, s) => Number(d.gpuMilli) === Number(s.gpuMilli) && Number(d.cpuMilli) === Number(s.cpuMilli);
  let d = await read(); identity(d);
  if (!matches(d, expected)) throw new Error("The deployment's shares changed. Reopen Resources before trying again.");
  if (!Number.isSafeInteger(Number(d.leaseUntil)) || Number(d.leaseUntil) < 0
    || !Number.isSafeInteger(Number(d.blockTimestamp)) || Number(d.blockTimestamp) <= 0)
    throw new Error("Unable to verify the current lease. Nothing changed; try again.");
  let committed = false;
  try {
    if (leaseAvailable(d)) {
      progress("Confirm the new shares and re-queue in your wallet.");
      await apply({ active: true });
      saved({ active: true });
      return { resumed: true };
    }
    progress("Confirm the new shares and stop in one transaction. Then confirm re-queue when the old lease clears.");
    await apply({ active: false });
    committed = true;
    saved({ active: false });
    progress("New shares saved. Waiting for the old host lease to clear before re-queuing…");
    // Leases can outlive the old fixed three-minute UI timeout. Allow the
    // current lease's remaining lifetime plus settlement/read propagation.
    const remainingMs = Math.max(0, Number(d.leaseUntil) - Number(d.blockTimestamp)) * 1000;
    const deadline = now() + (timeoutMs ?? Math.max(180000, remainingMs + 90000));
    let observed = false, lastBlock = -1;
    while (true) {
      try { d = await read(); }
      catch (e) {
        if (now() >= deadline) throw e;
        await sleep(3000); continue; // temporary RPC outages don't strand a confirmed resize
      }
      // Rotating RPCs may lag the receipt or go backwards. Never interpret a
      // stale pre-transaction row as someone resuming or changing our shares.
      const block = Number(d?.blockNumber);
      if (!Number.isSafeInteger(block) || block >= lastBlock) {
        identity(d);
        if (matches(d, target) && d.active === false) {
          observed = true;
          if (Number.isSafeInteger(block)) lastBlock = block;
          if (leaseAvailable(d)) break;
        } else if (observed || !matches(d, expected)) {
          throw new Error("The deployment changed elsewhere during resize. No further transaction was sent.");
        }
      }
      if (now() >= deadline) throw new Error("The old lease has not cleared yet.");
      await sleep(3000);
    }
    progress("New shares saved. Confirm re-queue in your wallet to start the resized app.");
    await resume();
    return { resumed: true };
  } catch (e) {
    if (committed) e.message += " Your new shares are saved. Use Resume to start the app with the saved allocation; no need to enter it again.";
    throw e;
  }
}
