#!/usr/bin/env node
/* enclave-metal auto-update — the self-hosted half of "merge to main and the
   fleet moves".
   ===========================================================================
   Tinfoil enclaves are PUSHED: CI cuts a release and tinfoil-cli updates each
   running enclave. A metal box cannot be pushed to — it is typically behind
   CGNAT with no inbound path at all — so it PULLS on a timer instead. Same
   destination, opposite direction.

   WHAT IT TRACKS. The published release tag for this box's flavor (metal0 is
   CPU-only, so `vX.Y.Z-cpu`), which is the same artifact the CPU fleet moves
   to. Not the local checkout: this box runs out of a working tree that is also
   somebody's desk, and a half-finished edit must never become the thing the
   enclave attests to. The build happens in a throwaway git worktree at the tag.

   WHY STAGING + ROLLBACK, and not just "rebuild and restart". 2026-07-27: a
   manager build reached metal0 whose wasmtime did not understand a flag that
   build passes unconditionally, so every tenant died at spawn, the box handed
   back the lease it had just resumed, and the app was down until a human
   noticed and repinned. An updater without a health gate would have done that
   on its own, at 3am, and left it there. So: build beside the live image,
   swap, and if the box does not come back HEALTHY within the window, put the
   previous image back and stop updating until a human clears the marker.

   WHAT "HEALTHY" MEANS HERE. The supervisor answers /v1/health on the host
   forward AND reports its watcher fresh. That is the same signal the fleet
   updater waits for, and it is the one that would have caught the wasmtime
   mismatch: the box answered, but could not run a tenant — which shows up as
   an immediate provision failure, so the gate also refuses an image that took
   a tenant and dropped it.

   IDLE POLICY (off by default since 2026-09-04). A restart does cost the
   app-zone hostname a fresh ACME issuance — the guest is initramfs-only, so
   nothing survives, and that is intended. It used to be rationed: Let's
   Encrypt allows 5 duplicates per 168h per name, and an updater restarting on
   every merge would spend a week's budget in an afternoon. That premise died
   a month later. App-zone names now go to the PLATFORM CERTIFICATE SERVICE
   (supervisor slot 0, CERTS_API, which the launcher derives from relayUrl):
   the relay orders from ZeroSSL under the platform EAB with Let's Encrypt
   only behind it, and paces LE centrally for the whole fleet. A restart
   therefore spends a ZeroSSL order, which carries no such weekly duplicate
   limit — so certificates are no longer a reason to postpone a release.

   What a restart still costs is the tenant relaunch, which is seconds and
   visible, against a box that would otherwise sit on an old release: this
   one waited hours to take the fix its own operator was waiting for. So the
   default is to update as soon as a release exists. A box that would rather
   wait for idle opts in with `autoUpdate.onlyWhenIdle: true`, and keeps the
   `maxDeferSec` ceiling so it cannot fall behind forever.

   Usage:  node metal/update.mjs [--check] [--force] [--config metal/config.json]
     --check  print the verdict as JSON and exit; changes nothing
     --force  ignore the idle policy when one is configured (still
              health-gated, still rolls back)
*/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

// The box's config is read LAZILY, never at import: metal/config.json holds
// this box's secrets and is gitignored, so it does not exist on a CI runner or
// in anyone else's checkout. The policy functions below are pure and must stay
// importable without it — reading it up here made `import` itself throw ENOENT
// and took the whole test file down with it.
let _ctx = null;
function ctx() {
  if (_ctx) return _ctx;
  const cfgPath = arg('config', path.join(HERE, 'config.json'));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const AU = cfg.autoUpdate || {};
  const DIST = cfg.dist ? path.resolve(REPO, cfg.dist) : path.join(HERE, 'dist');
  _ctx = {
    cfgPath, cfg, AU, DIST,
    NAME: cfg.name || 'metal0',
    SERVICE: AU.service || 'enclave-metal',
    HOSTFWD: (cfg.hostfwd || []).find((h) => Number(h.guest) === 8080)?.host || 18080,
    MARKER: path.join(DIST, '..', '.update-halted'),
  };
  return _ctx;
}

const log = (m) => console.log(`[metal-update] ${m}`);

/* ---------- pure decision logic (exported for the tests) ------------------ */

/* Is `b` a newer release than `a`? Tags are vMAJOR.MINOR.PATCH with an optional
   flavor suffix; compare numerically so v0.5.9 does not outrank v0.5.10. */
export function tagCmp(a, b) {
  const nums = (t) => (String(t || '').match(/\d+/g) || []).map(Number);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
export const tagNewer = (a, b) => tagCmp(a, b) < 0;

/* What this run should do. Pure: every input is passed in, so the policy is
   testable without a box, a network or a clock.
     current      the release tag the live image was built from (null = unknown)
     latest       the newest published tag for this flavor
     running      tenants currently served (a restart relaunches each)
     deferredSince ms epoch when we first wanted this update, or null
     now          ms epoch
     halted       a previous update failed and rolled back; a human must clear it
   Returns { act: "update" | "defer" | "skip", why }. */
export function updateVerdict({ current, latest, running = 0, deferredSince = null, now = Date.now(),
                                onlyWhenIdle = false, maxDeferSec = 6 * 3600, halted = false } = {}) {
  if (halted) return { act: 'skip', why: 'a previous update failed its health gate and was rolled back; clear the halt marker after fixing the cause' };
  if (!latest) return { act: 'skip', why: 'no published release found for this flavor' };
  if (current && !tagNewer(current, latest)) return { act: 'skip', why: `already on ${current}` };
  if (!onlyWhenIdle || running === 0) return { act: 'update', why: current ? `${current} -> ${latest}` : `first build -> ${latest}` };
  // Busy. Defer — but never forever: a box that always has a tenant would
  // otherwise never take a security fix.
  const waited = deferredSince != null ? (now - deferredSince) / 1000 : 0;   // != null: epoch 0 is a timestamp, not "never"
  if (waited >= maxDeferSec)
    return { act: 'update', why: `${running} tenant(s) running, but deferred ${Math.round(waited / 3600)}h >= maxDeferSec; updating anyway` };
  return { act: 'defer', why: `${running} tenant(s) running; waiting for idle (deferred ${Math.round(waited / 60)}m of ${Math.round(maxDeferSec / 60)}m)` };
}

/* ---------- the box's current + available state --------------------------- */

function manifest() {
  try { return JSON.parse(fs.readFileSync(path.join(ctx().DIST, 'manifest.json'), 'utf8')); } catch { return null; }
}

async function health() {
  try {
    const r = await fetch(`http://127.0.0.1:${ctx().HOSTFWD}/v1/health`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/* Newest published release for this flavor. `-cpu` tags are the CPU flavor;
   the bare tag is the GPU one, so a CPU box must not follow it. */
async function latestTag(flavor) {
  const want = flavor === 'cpu' ? /-cpu$/ : /^v\d+\.\d+\.\d+$/;
  const r = await fetch('https://api.github.com/repos/EnclaveHost/enclave/releases?per_page=30',
    { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`github releases: HTTP ${r.status}`);
  const tags = (await r.json()).map((x) => x.tag_name).filter((t) => want.test(t || ''));
  // a REAL comparator: `tagNewer(a,b) ? 1 : -1` is not a total order (it never
  // returns 0 for equals) and sort() gave v0.5.268 as the max of a list holding
  // v0.5.282 — an updater that silently picks an old release is worse than one
  // that does nothing
  return tags.sort(tagCmp).pop() || null;
}

/* ---------- apply ---------------------------------------------------------- */

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

async function waitHealthy(deadlineMs) {
  while (Date.now() < deadlineMs) {
    const h = await health();
    // answering is not enough: the watcher must be fresh, which is what tells
    // us the box can actually meter and serve rather than merely listen
    if (h && h.status === 'ok' && h.watcher?.fresh !== false) return h;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

async function apply(tag) {
  const { cfgPath, AU, DIST, SERVICE, MARKER } = ctx();
  const wt = path.join(os.tmpdir(), `metal-update-${process.pid}`);
  const staging = DIST + '.new';
  const prev = DIST + '.prev';
  fs.rmSync(wt, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    log(`fetching ${tag}…`);
    sh('git', ['fetch', '--quiet', '--tags', 'origin', tag]);
    // A DETACHED WORKTREE, never the checkout this box runs from: that tree is
    // also a desk, and an enclave must not attest to someone's work in progress.
    sh('git', ['worktree', 'add', '--detach', '--quiet', wt, tag]);
    log(`building from ${tag} (staging)…`);
    sh(process.execPath, [path.join(wt, 'metal', 'build-image.mjs'),
                          '--config', path.resolve(cfgPath), '--out', staging, '--release', tag],
       { cwd: wt, stdio: ['ignore', 'inherit', 'inherit'] });
  } finally {
    try { sh('git', ['worktree', 'remove', '--force', wt]); } catch {}
    fs.rmSync(wt, { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(staging, 'initramfs.cpio.gz')))
    throw new Error('build produced no initramfs; nothing swapped');

  // swap: keep exactly one generation back, which is all a rollback needs
  fs.rmSync(prev, { recursive: true, force: true });
  if (fs.existsSync(DIST)) fs.renameSync(DIST, prev);
  fs.renameSync(staging, DIST);
  log(`swapped in ${tag}; restarting ${SERVICE}`);
  spawnSync('systemctl', ['--user', 'restart', SERVICE], { stdio: 'inherit' });

  const graceSec = Number(AU.healthGraceSec || 300);
  const ok = await waitHealthy(Date.now() + graceSec * 1000);
  if (ok) {
    log(`healthy on ${tag} (${ok.deployments ?? 0} deployment(s))`);
    return true;
  }
  // ROLL BACK. The box came up unhealthy or not at all — put the image that
  // was serving back, and halt further updates: repeating this on a timer
  // turns one bad release into an outage that reboots itself all night.
  log(`NOT healthy within ${graceSec}s — rolling back to the previous image`);
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.renameSync(prev, DIST);
  spawnSync('systemctl', ['--user', 'restart', SERVICE], { stdio: 'inherit' });
  const back = await waitHealthy(Date.now() + graceSec * 1000);
  fs.writeFileSync(MARKER, JSON.stringify({ tag, at: new Date().toISOString(),
    note: 'auto-update rolled back after failing its health gate; fix the cause, then delete this file' }, null, 2));
  log(back ? `rolled back; ${SERVICE} healthy again on the previous image`
           : `rolled back, but ${SERVICE} is STILL unhealthy — this needs a human`);
  return false;
}

/* ---------- main ----------------------------------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const { AU, DIST, MARKER } = ctx();
  const m = manifest();
  const flavor = m?.flavor || 'cpu';
  const current = m?.release || null;
  const h = await health();
  const running = Number(h?.deployments || 0);
  const statePath = path.join(DIST, '..', '.update-state.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  const latest = await latestTag(flavor).catch((e) => { log(`release lookup failed: ${e.message}`); return null; });

  const v = updateVerdict({
    current, latest, running,
    deferredSince: state.deferredSince || null,
    onlyWhenIdle: AU.onlyWhenIdle === true,   // opt-in: see IDLE POLICY above
    maxDeferSec: Number(AU.maxDeferSec || 6 * 3600),
    halted: fs.existsSync(MARKER),
  });

  if (has('check')) { console.log(JSON.stringify({ flavor, current, latest, running, ...v }, null, 2)); process.exit(0); }
  if (has('force') && v.act === 'defer') v.act = 'update';

  if (v.act === 'defer') {
    if (!state.deferredSince) fs.writeFileSync(statePath, JSON.stringify({ deferredSince: Date.now(), latest }));
    log(`defer: ${v.why}`);
    process.exit(0);
  }
  if (v.act === 'skip') { log(`skip: ${v.why}`); process.exit(0); }

  log(`update: ${v.why}`);
  const ok = await apply(latest);
  try { fs.rmSync(statePath, { force: true }); } catch {}
  process.exit(ok ? 0 : 1);
}
