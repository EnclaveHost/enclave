// supervisor-transport.mjs - how supervisor.js reaches guestd when ISOLATION_BACKEND is set: every /vms-contract
// call over guestd-control/1 (control-client.mjs), and NEVER plain HTTP. supervisor.js imports this module only on
// that path, so a supervisor without the flag neither loads nor needs it.
//
// It returns the shape the supervisor's vmReq always returned, {status, body}, so no call site changes. What the
// call sites could not say - whether repeating a request is safe - is decided HERE, per guestd route, because an
// unsigned 401 asking for a new handshake does not prove the request did not run (control-client.mjs, RETRIES):
//
//   GET, HEAD                resent after a renewal: they change nothing
//   DELETE /vms/<id>         resent: guestd answers 200, then 404, so a repeat removes nothing twice
//   POST /vms/lease          resent: a heartbeat; the same ids extend the same leases
//   POST /prefetch           resent: the mapping store is immutable and deterministic
//   POST /vms                RECONCILED: after a renewal, an instance already starting or running under the
//                            request's name is the launch that happened, and is returned as that launch; only if
//                            there is none is the request sent again
//   anything else            never repeated: the error says the outcome is unknown
//
// The pairing key file must be the caller's own and private (mode 0600/0400, a regular file, not a symlink), the
// same rule guestd applies to its copy. Without one there is no transport at all.
import fs from "node:fs";
import { GuestdControl, GuestdControlError, parseKey } from "./control-client.mjs";

const IDEMPOTENT = [
  ["GET", /^\//], ["HEAD", /^\//],
  ["DELETE", /^\/vms\/[^/?]+$/],
  ["POST", /^\/vms\/lease$/],
  ["POST", /^\/prefetch$/],
];
export const idempotentRoute = (method, path) => IDEMPOTENT.some(([m, re]) => m === method && re.test(path));

function readKeyFile(path) {
  if (!path) throw new GuestdControlError("protocol", "ISOLATION_BACKEND is set but GUESTD_KEY_FILE is not: refusing to "
    + "reach the per-app manager without its pairing key (and never over plain HTTP)");
  const st = fs.lstatSync(path);
  if (!st.isFile()) throw new GuestdControlError("protocol", `${path} is not a regular file (a symlink is refused)`);
  if ((st.mode & 0o077) !== 0) throw new GuestdControlError("protocol", `${path} is readable or writable by others `
    + `(mode ${(st.mode & 0o777).toString(8)}): it must be 0600 or 0400`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid())
    throw new GuestdControlError("protocol", `${path} is not owned by the user the supervisor runs as`);
  return parseKey(fs.readFileSync(path, "utf8"));
}

// The launch that already happened, if any: an instance under this name that is starting or running.
export const reconcileLaunch = (name) => async (client) => {
  const r = await client.request("GET", "/vms");
  return ((r.body && r.body.vms) || []).find((v) => String(v.name) === String(name)
    && (v.status === "starting" || v.status === "running")) || null;
};

export function openGuestdTransport({ url, keyFile, clientOpts } = {}) {
  const client = new GuestdControl(url, readKeyFile(keyFile), clientOpts);
  return {
    client,
    // vmReq's contract: (method, path, body|null, timeoutMs) -> {status, body}; throws when no verified answer
    async request(method, path, body, timeoutMs) {
      const json = body == null ? undefined : body;
      const launch = method === "POST" && path === "/vms";
      const r = await client.request(method, path, json, { timeoutMs,
        idempotent: idempotentRoute(method, path),
        reconcile: launch && json && json.name ? reconcileLaunch(json.name) : undefined });
      // a reconciled launch IS the launch: report it as created, and say that it was reconciled
      if (r.status === "reconciled") return { status: 201, body: r.body, reconciled: true };
      return r;
    },
  };
}
