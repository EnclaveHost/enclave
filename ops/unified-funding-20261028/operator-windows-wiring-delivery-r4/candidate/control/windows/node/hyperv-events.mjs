/* HYPER-V'S OWN ACCOUNT OF A PARTITION THAT WENT AWAY. When a domain this node saw serving is gone from the manager
   (host.mjs, the vanished line), the Hyper-V worker usually said why in its Admin log: 18502 "turned off", 18515 "shut
   down for a reset initiated by the guest", 18590 a triple fault, and so on. This reads that log for the partition's VM
   and hands back at most a few events, each one line, for the node to log under the vanished line.

   The VM's name is 'enclave-app-' + the first 16 characters of the manager's instance id + '-' + a suffix (server.mjs
   spawn), e.g. instance hv3f70187449d4ee0e7a... -> enclave-app-hv3f70187449d4ee-322c5206, so events are matched on the
   'enclave-app-<first16>' prefix. Diagnostic only: Windows only, bounded by a timeout, and any failure answers null so
   the caller logs nothing extra. */
import { execFile } from "node:child_process";
import path from "node:path";

export const HYPERV_WORKER_LOG = "Microsoft-Windows-Hyper-V-Worker-Admin";
export const HYPERV_EVENTS_MAX = 10;
const MESSAGE_CHARS = 200;

/** 'enclave-app-' + the first 16 alphanumerics of an instance id, or null when there are none. */
export function vmPrefixFor(instanceId) {
  const s = String(instanceId ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  return s ? `enclave-app-${s}` : null;
}

/** The PowerShell that lists the Worker-Admin events since `since` whose message names the prefix, newest first. */
export function hyperVEventsScript({ prefix, since, max = HYPERV_EVENTS_MAX }) {
  if (!/^enclave-app-[A-Za-z0-9]{1,16}$/.test(String(prefix))) throw new Error("not a partition VM prefix");
  const t = new Date(since);
  if (!Number.isFinite(t.getTime())) throw new Error("not a time");
  const n = Math.max(1, Math.min(50, Math.floor(max)));
  return "$ErrorActionPreference = 'Stop'; "
    + `$since = [DateTime]::Parse('${t.toISOString()}', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime(); `
    + `$ev = @(Get-WinEvent -FilterHashtable @{ LogName = '${HYPERV_WORKER_LOG}'; StartTime = $since } -ErrorAction SilentlyContinue `
    + `| Where-Object { [string]$_.Message -like '*${prefix}*' } | Select-Object -First ${n}); `
    + "$out = @($ev | ForEach-Object { [pscustomobject]@{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); id = [int]$_.Id; message = [string]$_.Message } }); "
    + "ConvertTo-Json -InputObject $out -Compress -Depth 3";
}

const oneLine = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MESSAGE_CHARS);

/**
 * The events PowerShell printed, kept only when their message names the prefix, oldest first, at most `max`:
 * [{ time (ISO), id, message (one line, <= 200 chars) }]. Null when the output is not the expected JSON.
 */
export function parseHyperVEvents(stdout, prefix, max = HYPERV_EVENTS_MAX) {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(j) ? j : j && typeof j === "object" ? [j] : null;
  if (!list) return null;
  const want = String(prefix).toLowerCase();
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const msg = String(e.message ?? e.Message ?? "");
    if (!msg.toLowerCase().includes(want)) continue;
    const t = new Date(e.time ?? e.TimeCreated ?? NaN);
    out.push({ time: Number.isFinite(t.getTime()) ? t.toISOString() : null, id: Number.isSafeInteger(Number(e.id ?? e.Id)) ? Number(e.id ?? e.Id) : null,
               message: oneLine(msg) });
  }
  out.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return out.slice(-max);
}

/** execFile powershell with a timeout, hidden; -> stdout, or throws. */
export function powershellEvents(script, { timeoutMs = 20_000 } = {}) {
  const exe = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    // -EncodedCommand (UTF-16LE base64): nothing in the script is re-quoted on its way through the command line
    const enc = Buffer.from("$ProgressPreference='SilentlyContinue'; " + script, "utf16le").toString("base64");
    execFile(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20 },
      (e, stdout) => (e ? reject(e) : resolve(String(stdout))));
  });
}

/**
 * The Worker-Admin events naming this instance's VM since `since` (default: ten minutes ago), or null on any failure and
 * on a host that is not Windows (unless a runner is injected).
 * @param run  (script) -> stdout; injected by tests, powershellEvents on Windows
 */
export async function recentHyperVEvents({ instanceId, since = null, now = Date.now(), max = HYPERV_EVENTS_MAX,
                                           run = null, platform = process.platform } = {}) {
  try {
    const prefix = vmPrefixFor(instanceId);
    if (!prefix) return null;
    const runner = run || (platform === "win32" ? powershellEvents : null);
    if (!runner) return null;
    const from = since ?? now - 10 * 60 * 1000;
    const stdout = await runner(hyperVEventsScript({ prefix, since: from, max }));
    return parseHyperVEvents(stdout, prefix, max);
  } catch { return null; }
}
