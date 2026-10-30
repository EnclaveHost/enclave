// windows/node/update-window.mjs -- when Windows Update may restart this host: the owner's window, as install-host.ps1
// recorded it in NODE_DIR/host.json and set it as machine policy.
//
// A Windows Update restart takes every partition down with the machine (nucbox-k11-4, 2026-10-14 14:29-14:33Z: the
// October cumulative update restarted the box twice around 07:32 local, outside the 10:00-20:00 active hours Windows had
// picked for it, and the node gave every app back to the fleet). Setup therefore schedules the install at the window's start and makes everything outside the window
// "active hours", which Windows does not restart during. Active hours span at most 18 hours, so a window is 6 to 24 hours.
//
// host.json: { ..., "updateWindow": { "managed": true, "start": 1, "hours": 6, "noRebootWhileSignedIn": false } }
//   managed               false: setup leaves this PC's Windows Update settings as they are (the owner's own policy)
//   start                 the window's first hour, 0-23, LOCAL time
//   hours                 its length, 6-24
//   noRebootWhileSignedIn Windows never restarts by itself while anyone is signed in. On a host whose owner stays
//                         signed in (the tray runs in their session), updates then wait for a restart by hand: off by
//                         default.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_UPDATE_WINDOW = Object.freeze({ managed: true, start: 1, hours: 6, noRebootWhileSignedIn: false });

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/**
 * updateWindow(o) -> the window host.json's `updateWindow` describes, each field that is missing or out of range taken
 * from DEFAULT_UPDATE_WINDOW (a host installed before the setting existed reads as the default it gets at its next update).
 */
export function updateWindow(o) {
  const d = DEFAULT_UPDATE_WINDOW;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ...d };
  return {
    managed: typeof o.managed === "boolean" ? o.managed : d.managed,
    start: int(o.start, 0, 23) ?? d.start,
    hours: int(o.hours, 6, 24) ?? d.hours,
    noRebootWhileSignedIn: typeof o.noRebootWhileSignedIn === "boolean" ? o.noRebootWhileSignedIn : d.noRebootWhileSignedIn,
  };
}

/**
 * windowsUpdatePolicy(w) -> the policy values setup writes for window w, or null when w is not managed.
 *   WindowsUpdate:    SetActiveHours, ActiveHoursStart, ActiveHoursEnd  (everything outside the window; a 24-hour window
 *                     sets no active hours)
 *   WindowsUpdate\AU: NoAutoUpdate 0, AUOptions 4 (download, then install on the schedule), ScheduledInstallDay 0 (every
 *                     day), ScheduledInstallTime = the window's start, NoAutoRebootWithLoggedOnUsers
 * install-host.ps1 writes the same values; test/windows-update-window.test.mjs holds the two to this.
 */
export function windowsUpdatePolicy(w) {
  w = updateWindow(w);
  if (!w.managed) return null;
  const active = w.hours >= 24 ? { SetActiveHours: 0 }
    : { SetActiveHours: 1, ActiveHoursStart: (w.start + w.hours) % 24, ActiveHoursEnd: w.start };
  return {
    WindowsUpdate: active,
    AU: { NoAutoUpdate: 0, AUOptions: 4, ScheduledInstallDay: 0, ScheduledInstallTime: w.start,
          NoAutoRebootWithLoggedOnUsers: w.noRebootWhileSignedIn ? 1 : 0 },
  };
}

/** readUpdateWindow(nodeDir) -> the window NODE_DIR/host.json records; the default when there is none or it cannot be read. */
export function readUpdateWindow(nodeDir) {
  try { return updateWindow(JSON.parse(fs.readFileSync(path.join(nodeDir, "host.json"), "utf8").replace(/^﻿/, "")).updateWindow); }
  catch { return updateWindow(null); }
}
