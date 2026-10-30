// The Windows Update restart window (windows/node/update-window.mjs): what host.json's `updateWindow` reads as, the policy
// it stands for, and that install-host.ps1 writes the same policy.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_UPDATE_WINDOW, updateWindow, windowsUpdatePolicy, readUpdateWindow } from "../windows/node/update-window.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a window reads field by field; a missing or out-of-range field is the default", () => {
  assert.deepEqual(updateWindow(null), DEFAULT_UPDATE_WINDOW);
  assert.deepEqual(updateWindow([]), DEFAULT_UPDATE_WINDOW);
  assert.deepEqual(updateWindow({ start: 22, hours: 8 }), { ...DEFAULT_UPDATE_WINDOW, start: 22, hours: 8 });
  assert.deepEqual(updateWindow({ start: 24, hours: 5, managed: "no", noRebootWhileSignedIn: 1 }), DEFAULT_UPDATE_WINDOW,
    "24 is not an hour, 5 hours leaves more than the 18 active hours Windows keeps, and strings are not booleans");
  assert.deepEqual(updateWindow({ start: 2.5 }), DEFAULT_UPDATE_WINDOW);
  assert.equal(updateWindow({ managed: false }).managed, false);
});

test("the policy: install at the window's start, every other hour active", () => {
  assert.deepEqual(windowsUpdatePolicy(null), {
    WindowsUpdate: { SetActiveHours: 1, ActiveHoursStart: 7, ActiveHoursEnd: 1 },
    AU: { NoAutoUpdate: 0, AUOptions: 4, ScheduledInstallDay: 0, ScheduledInstallTime: 1, NoAutoRebootWithLoggedOnUsers: 0 },
  });
  const late = windowsUpdatePolicy({ start: 22, hours: 6, noRebootWhileSignedIn: true });
  assert.deepEqual(late.WindowsUpdate, { SetActiveHours: 1, ActiveHoursStart: 4, ActiveHoursEnd: 22 }, "a window across midnight");
  assert.equal(late.AU.NoAutoRebootWithLoggedOnUsers, 1);
  assert.deepEqual(windowsUpdatePolicy({ start: 3, hours: 24 }).WindowsUpdate, { SetActiveHours: 0 });
  assert.equal(windowsUpdatePolicy({ managed: false }), null, "not managed: setup writes nothing");
});

test("the node reads host.json (BOM and all), and the default when it is missing or broken", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-"));
  try {
    assert.deepEqual(readUpdateWindow(dir), DEFAULT_UPDATE_WINDOW);
    fs.writeFileSync(path.join(dir, "host.json"), "﻿" + JSON.stringify({ name: "box", updateWindow: { start: 4, hours: 8,
      managed: true, noRebootWhileSignedIn: false, replaced: { AU: { AUOptions: 3 } } } }));
    assert.deepEqual(readUpdateWindow(dir), { managed: true, start: 4, hours: 8, noRebootWhileSignedIn: false });
    fs.writeFileSync(path.join(dir, "host.json"), "{");
    assert.deepEqual(readUpdateWindow(dir), DEFAULT_UPDATE_WINDOW);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("install-host.ps1 writes the same policy names, defaults and arithmetic", () => {
  const ps = fs.readFileSync(path.join(ROOT, "windows/installer/install-host.ps1"), "utf8");
  const un = fs.readFileSync(path.join(ROOT, "windows/installer/uninstall-host.ps1"), "utf8");
  const pol = windowsUpdatePolicy(null);
  for (const [key, vals] of Object.entries(pol)) {
    for (const name of Object.keys(vals)) {
      assert.match(ps, new RegExp(`"${name}"`), `${name} is among the values setup records and restores`);
      assert.match(un, new RegExp(`"${name}"`), `${name} is restored on uninstall`);
    }
    assert.ok(ps.includes(`${key} = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate`), `${key}'s key`);
  }
  for (const name of ["ActiveHoursStart", "ActiveHoursEnd"]) assert.match(ps, new RegExp(`"${name}"`));
  assert.match(ps, /managed = \$true; start = 1; hours = 6; noRebootWhileSignedIn = \$false/, "the same default as DEFAULT_UPDATE_WINDOW");
  assert.match(ps, /ActiveHoursStart = \(\$uw\.start \+ \$uw\.hours\) % 24; ActiveHoursEnd = \$uw\.start/);
  assert.match(ps, /NoAutoUpdate = 0; AUOptions = 4; ScheduledInstallDay = 0; ScheduledInstallTime = \$uw\.start/);
  assert.match(ps, /updateWindow = \$uw/, "host.json records the window");
});
