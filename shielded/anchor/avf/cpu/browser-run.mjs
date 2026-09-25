#!/usr/bin/env node
// browser-run.mjs -- one page load in a REAL headless browser for the LAB browser channel (PVM-CPU.md; test only): opens
// the lab page (web/lab.html, served by web/lab-site.mjs) with a fresh profile, waits until the page has posted its
// outcome for --label to the site's results file, prints that outcome as one JSON line, and ends the browser (its own
// process group, by the PID it started).
//   node cpu/browser-run.mjs --browser chromium|firefox --site URL --relay URL --label L --results FILE [--path P] [--extra "&app=..."]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const browser = arg("--browser", "chromium"), label = arg("--label"), results = arg("--results");
const url = `${arg("--site")}?relay=${encodeURIComponent(arg("--relay"))}&label=${encodeURIComponent(label)}&path=${encodeURIComponent(arg("--path", "/"))}${arg("--extra", "")}`;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), `lab-${browser}-`));
const argv = browser === "firefox"
  ? ["--headless", "--no-remote", "--new-instance", "--profile", prof, url]
  : ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "--disable-background-networking", `--user-data-dir=${prof}`, url];
if (browser === "firefox") fs.writeFileSync(path.join(prof, "user.js"), 'user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("datareporting.policy.dataSubmissionEnabled", false);\nuser_pref("toolkit.telemetry.reportingpolicy.firstRun", false);\n');
const b = spawn(browser, argv, { detached: true, stdio: "ignore" });
const t0 = Date.now(), limit = Number(arg("--seconds", "120")) * 1000;
const find = () => { try { return fs.readFileSync(results, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.label === label); } catch { return null; } };
const end = (o, rc) => { try { process.kill(-b.pid, "SIGKILL"); } catch {} fs.rmSync(prof, { recursive: true, force: true }); process.stdout.write(JSON.stringify(o) + "\n"); process.exit(rc); };
b.on("error", (e) => end({ label, browser, step: "browser", refused: `cannot start ${browser}: ${e.message}`, sent: false }, 2));
const tick = setInterval(() => {
  const r = find();
  if (r) { clearInterval(tick); end({ browser, ...r }, r.status === 200 ? 0 : 1); }
  else if (Date.now() - t0 > limit) { clearInterval(tick); end({ label, browser, step: "browser", refused: "the page posted no outcome in time", sent: null }, 2); }
}, 200);
