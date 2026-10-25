/* ============================================================
   The site build's one optional input: an already-reviewed browser
   network profile to ship as the site's BUILT-IN profile
   (site/js/core/independent.js BUILT_IN_PROFILE_TEXT).

     node scripts/build-site.mjs --built-in-profile FILE --built-in-profile-digest sha256:<64 hex>

   The file is data: its exact bytes must hash to the digest the
   reviewer recorded (the same fingerprint the dashboard shows), they
   must decode as UTF-8 and pass the site's own profile parser
   (parseProfile: unique keys, every binding validated), and that exact
   text is embedded as a string literal in the bundled module - the
   source tree is not edited and nothing is evaluated. Any problem
   fails the build. Without the flags the build is unchanged: no
   built-in profile, the hosted defaults, a saved browser profile
   still applies.
   ============================================================ */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseProfile, PROFILE_MAX_BYTES } from "../site/js/core/independent.js";

const FLAGS = ["--built-in-profile", "--built-in-profile-digest"];
// the one declaration the bundler may replace; anything else means the module changed shape and the build stops
export const BUILT_IN_DECLARATION = "export const BUILT_IN_PROFILE_TEXT = null;";

/** The build's arguments -> { file, digest } (both or neither); anything else is an error. */
export function parseBuildArgs(argv) {
  const got = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!FLAGS.includes(a)) throw new Error(`unknown build argument ${JSON.stringify(a)} (accepted: ${FLAGS.join(", ")})`);
    if (a in got) throw new Error(`${a} given twice`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    got[a] = v;
  }
  const file = got["--built-in-profile"] ?? null, digest = got["--built-in-profile-digest"] ?? null;
  if ((file === null) !== (digest === null)) throw new Error("--built-in-profile and --built-in-profile-digest go together: the profile file and the sha256 its review recorded");
  return { file, digest };
}

/** Read and check the reviewed profile -> { text, fingerprint, profile }. */
export function readBuiltInProfile(file, digest) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(digest))) throw new Error("--built-in-profile-digest must be sha256:<64 lower-case hex>");
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`${file} is not a file`);
  if (st.size > PROFILE_MAX_BYTES) throw new Error(`${file} is larger than ${PROFILE_MAX_BYTES} bytes`);
  const bytes = fs.readFileSync(file);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  if ("sha256:" + fingerprint !== digest) throw new Error(`${file} is sha256:${fingerprint}, not the reviewed ${digest}`);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`${file} is not UTF-8 text`); }
  let profile;
  try { profile = parseProfile(text); }
  catch (e) { throw new Error(`${file} is not a usable browser profile: ${e.message || e}`); }
  return { text, fingerprint, profile };
}

/** esbuild plugin: the bundled independent.js carries `text` (exactly) as BUILT_IN_PROFILE_TEXT. */
export function builtInProfilePlugin(text, site) {
  const target = path.join(site, "js", "core", "independent.js");
  return {
    name: "built-in-profile",
    setup(b) {
      b.onLoad({ filter: /[\\/]js[\\/]core[\\/]independent\.js$/ }, async (args) => {
        if (path.resolve(args.path) !== target) return undefined;
        const src = await fs.promises.readFile(args.path, "utf8");
        const n = src.split(BUILT_IN_DECLARATION).length - 1;
        if (n !== 1) throw new Error(`${args.path}: expected exactly one "${BUILT_IN_DECLARATION}", found ${n}`);
        return { contents: src.replace(BUILT_IN_DECLARATION, () => `export const BUILT_IN_PROFILE_TEXT = ${JSON.stringify(text)};`), loader: "js" };
      });
    },
  };
}
