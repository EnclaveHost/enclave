// relay/host-names.mjs -- may a new host take this name? GET /v1/hosts/name/<name>, asked by the Windows installer while
// its owner types the name (docs/design/windows-host-installer.md).
//
// A host's name is its tunnel name and its registry endpoint (<relay>/t/<name>), so it is taken when the registry has an
// entry for that endpoint (whoever's) or a tunnel holds it right now. The installer's rule is stricter than the tunnel's
// own (/^[A-Za-z0-9_-]{1,64}$/): lowercase letters, digits and inner hyphens, 3..32 characters, so the name also works as
// a DNS label later. Some names are kept for the platform.
export const HOST_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;
export const RESERVED = new Set(["api", "www", "admin", "relay", "enclave", "enclave-host", "host", "hosts", "app", "apps",
  "root", "mail", "dns", "tuna", "metal", "nan", "get", "ipfs", "status", "support", "security", "test", "localhost"]);

/** The name's shape alone: null when fine, else why not. */
export function nameShapeProblem(name) {
  if (typeof name !== "string" || !name) return "a name is required";
  if (name.length < 3 || name.length > 32) return "a name is 3 to 32 characters";
  if (!HOST_NAME_RE.test(name)) return "use lowercase letters, digits and hyphens, starting and ending with a letter or digit";
  if (/--/.test(name)) return "no double hyphens";
  if (RESERVED.has(name)) return "that name is kept for the platform";
  return null;
}

/**
 * hostNames({ hub, ownerOf }) -> { check(name) -> { name, available, reason? } }. `ownerOf(name)` is the on-chain
 * operator of the name's registry endpoint ("" when unregistered); `hub.info(name)` a live tunnel holding it.
 */
export function hostNames({ hub, ownerOf }) {
  async function check(name) {
    name = String(name || "");
    const shape = nameShapeProblem(name);
    if (shape) return { name, available: false, reason: shape };
    if (hub && hub.info && hub.info(name)) return { name, available: false, reason: "a host is attached under that name right now" };
    let owner;
    try { owner = await ownerOf(name); } catch { return { name, available: false, reason: "the registry could not be read; try again" }; }
    if (owner) return { name, available: false, reason: "that name is registered to another host" };
    return { name, available: true };
  }
  return { check };
}

/** GET /v1/hosts/name/<name> */
export function hostNamesRouter({ names, json }) {
  return async (req, res, url) => {
    const m = /^\/v1\/hosts\/name\/([^/]{0,80})$/.exec(url.pathname);
    if (!m) return false;
    if (req.method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
    let name; try { name = decodeURIComponent(m[1]); } catch { name = ""; }
    json(res, 200, await names.check(name));
    return true;
  };
}
