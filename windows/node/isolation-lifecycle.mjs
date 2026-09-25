// isolation-lifecycle.mjs - what the node DOES about a deployment on the per-app isolation backend:
// start one, adopt one that is already there, give up on one that will not become ready, and retire
// one when the lease ends.
//
// THE RULE EVERYTHING HERE OBEYS: a lease is freed only when the domain is KNOWN to be gone.
// "Unknown" is not "free". A manager that is down, one that hangs, one that answers ok to a DELETE
// while the partition is still live, and a request whose answer never arrived are all unknown, and
// every one of them keeps the lease. Treating unknown as free is how the same deployment ends up
// running twice - once here and once wherever the lease went next - and two live copies of an app
// sharing one identity is worse than a lease held a little too long.
//
// ADOPTION IS BY NAME. The manager's id shape is its own business ("hv"+32hex here, "gd"+8hex on
// guestd) and nothing in this file pattern-matches it. What identifies a deployment's domain is the
// deploymentId the node sent as `name`, which every backend carries. A node that restarts finds its
// domains by asking, not by remembering.
//
// NOTHING HERE MAKES A SECURITY CLAIM. `running` is the manager's verdict under its own readiness
// rule, and a T0-hv partition does not exclude the host however ready it is: attestedCapacity() is
// false for it, and this file never consults anything else to decide what a domain IS.
import { IsolationError, instanceAlive, instanceServing, attestedCapacity } from "./isolation-client.mjs";

/** Why a lease is still held, in words an operator can act on. */
const HELD = (why) => ({ leaseFree: false, reason: why });

// A domain a RESTARTED manager recovered from Hyper-V (`recovered: true`) is alive and will never serve under that
// manager: its relay and readiness belonged to the previous process. Waiting for it waits for nothing. Retiring it
// here would stop a live app, and its data, because the manager restarted. So it is HELD: the lease is kept, no
// second domain is started, and nothing is removed. It serves again only through a deliberate relaunch (a forced
// re-ensure retires it by id first, and retire() confirms it is gone before a new one starts).
const RECOVERED = (name, v) => ({ action: "held", instance: v, ...HELD(`${name} is ${v.id}, a VM a restarted manager recovered `
  + "from Hyper-V: it is alive but cannot serve under this manager, so the lease is kept, no second domain is started "
  + "and nothing is removed; a forced relaunch retires it and starts a fresh one") });

/**
 * Bring a deployment to a running domain, or say precisely why not.
 *
 * @param client      IsolationManagerClient
 * @param deployment  { id, body }  id = the deploymentId (the domain's `name`); body = the spawn body
 * @param ledger      { release(id, why) }  called ONLY when the lease is genuinely free
 * @param deadlineMs  how long a domain may stay `starting` before this gives up on it
 * @returns { action: "adopted" | "spawned" | "failed" | "held", instance, reason, leaseFree }
 *   (a domain the manager marks `recovered` is always held: see RECOVERED)
 *
 *   adopted  a domain for this deployment was already there and is alive
 *   spawned  a new domain was started
 *   failed   the domain will not serve; the lease IS freed and the ledger was told. `refused` when the manager
 *            answered no (a 4xx: it never will), `ended` when a domain existed and ended, disappeared or missed the
 *            readiness deadline (a crash on this backend, which a caller MAY choose to respawn)
 *   held     the outcome is unknown; the lease is NOT freed and the ledger was not told
 */
export async function reconcile({ client, deployment, ledger = null, deadlineMs = 180_000,
                                  pollMs = 2_000, now = Date.now,
                                  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!client) throw new Error("a manager client is required");
  if (!deployment || !deployment.id) throw new Error("a deployment id is required");
  const name = String(deployment.id);

  // 1. Is one already there? A node restart must not respawn a live domain.
  let existing = null;
  try {
    existing = await client.findByName(name);
  } catch (e) {
    // the manager is unreachable or broken: we do NOT know whether a domain exists, so we must not
    // start a second one and must not free the lease
    return { action: "held", instance: null, ...HELD(`the manager could not be asked whether ${name} is already running (${e.message}); `
      + "starting another domain could run this deployment twice, so nothing was started and the lease is kept") };
  }

  let view = existing;
  let action = existing ? "adopted" : "spawned";

  if (!view) {
    try {
      const r = await client.spawn(deployment.body);
      view = r.view;
      if (r.adopted) action = "adopted";           // it appeared between our look and our spawn
    } catch (e) {
      // ONLY A REFUSAL (a 4xx) IS AN ANSWER: the manager will not run this, and it never will. Every other outcome is
      // UNKNOWN and holds (enclave-d1's review of dad939e9, finding 1):
      //   timeout / transport  the spawn may or may not have happened; a retry could double-run it
      //   unavailable (5xx)    not surveyed yet, the survey failed, or an unattributed VM exists
      //   conflict             a 409 said a domain for this name IS live, and it could not then be read
      //   protocol             the manager answered something this client cannot read
      if (!(e instanceof IsolationError && e.kind === "refused")) {
        return { action: "held", instance: null, ...HELD(`the launch of ${name} did not end in a known state `
          + `(${e.kind || "error"}: ${e.message}); nothing is retried and the lease is kept - reconcile before repeating it`) };
      }
      return { action: "failed", instance: null, leaseFree: true, refused: true,
               reason: `the manager refused to run ${name}: ${e.message}` };
    }
  }

  if (view.recovered) return RECOVERED(name, view);
  if (instanceServing(view)) return { action, instance: view, reason: null, leaseFree: false };

  // 2. Wait for it to become ready, and stop waiting at the deadline.
  const end = now() + deadlineMs;
  let last = view;
  while (now() < end) {
    await sleep(Math.min(pollMs, Math.max(1, end - now())));
    let cur;
    try {
      cur = await client.get(last.id);
    } catch (e) {
      // a manager that stopped answering while we waited: unknown, so held
      return { action: "held", instance: last, ...HELD(`${name} was ${last.status} when the manager stopped answering `
        + `(${e.message}); whether it is running is UNKNOWN, so the lease is kept`) };
    }
    if (cur === null) {
      // it is gone and we did not remove it: that IS known, and the lease is free
      return { action: "failed", instance: null, leaseFree: true, ended: true,
               reason: `${name} disappeared from the manager while it was ${last.status}` };
    }
    last = cur;
    // the manager restarted while we waited (P1c): the same VM, now recovered, will never become ready
    if (cur.recovered) return RECOVERED(name, cur);
    if (instanceServing(cur)) return { action, instance: cur, reason: null, leaseFree: false };
    if (!instanceAlive(cur)) {
      return { action: "failed", instance: cur, leaseFree: true, ended: true,
               reason: `${name} ended as ${cur.status}: ${cur.error || cur.reason || "no reason given"}` };
    }
  }

  // 3. The deadline. It is still alive but not serving, and it has had its time: this is a KNOWN
  // outcome (we asked and it told us), so the lease is freed and the domain is retired.
  const why = `${name} did not become ready within ${deadlineMs} ms (last status ${last.status})`;
  const r = await retire({ client, deployment, ledger: null, instanceId: last.id }).catch((e) => ({ removed: false, leaseFree: false, reason: e.message }));
  if (!r.removed) {
    return { action: "held", instance: last, ...HELD(`${why}, AND it could not be removed (${r.reason}); `
      + "a domain that may still be running keeps its lease") };
  }
  if (ledger) await ledger.release(name, why);
  return { action: "failed", instance: last, leaseFree: true, ended: true, reason: why };
}

/**
 * Stop and forget a deployment's domain.
 *
 * The manager answering `ok` is NOT proof: enclave-99's defect 5 was a DELETE that answered ok while
 * the partition was still live. So this RE-READS the domain afterwards, and a domain that is still
 * there keeps its lease however cheerful the answer was.
 */
export async function retire({ client, deployment, ledger = null, instanceId = null } = {}) {
  if (!client) throw new Error("a manager client is required");
  const name = deployment && deployment.id ? String(deployment.id) : null;
  let id = instanceId;
  if (!id) {
    if (!name) throw new Error("either an instanceId or a deployment id is required");
    let found;
    try { found = await client.findByName(name); }
    catch (e) { return { removed: false, ...HELD(`the manager could not be asked about ${name} (${e.message}); the lease is kept`) }; }
    if (!found) {
      // nothing to remove, and we know it: the lease is free
      if (ledger) await ledger.release(name, "no domain for this deployment");
      return { removed: true, leaseFree: true, reason: "no domain for this deployment" };
    }
    id = found.id;
  }

  try {
    await client.remove(id);
  } catch (e) {
    return { removed: false, ...HELD(`${id} could not be removed (${e.message}); it may still be RUNNING, so the lease is kept`) };
  }

  // The re-read that makes the answer mean something.
  let after;
  try { after = await client.get(id); }
  catch (e) {
    return { removed: false, ...HELD(`${id} was reported removed, but the manager could not be asked to confirm it (${e.message}); `
      + "an unconfirmed removal is not a free lease") };
  }
  if (after !== null && instanceAlive(after)) {
    return { removed: false, ...HELD(`the manager answered ok to removing ${id}, and it is still ${after.status}: `
      + "the domain may still be serving, so the lease is kept") };
  }
  if (ledger && name) await ledger.release(name, "the domain was removed and confirmed gone");
  return { removed: true, leaseFree: true, reason: null };
}

/**
 * May this deployment's domain be advertised as verified, host-excluded tenant capacity?
 * Re-exported so nothing downstream reaches for a looser test: on this tier the answer is no.
 */
export { attestedCapacity };
