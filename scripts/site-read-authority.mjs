/* ============================================================
   The site build's optional RELEASE READ AUTHORITY (site/js/core/read-authority.js READ_AUTHORITY_TEXT):

     node scripts/build-site.mjs --read-authority FILE --read-authority-digest sha256:<64 hex>

   Same pattern as --built-in-profile (scripts/site-built-in-profile.mjs): the file is data, its exact bytes must hash
   to the digest the reviewer recorded, decode as UTF-8 and pass the site's own parser (parseReadAuthority), and that
   exact text is embedded as a string literal in the bundled module; the source tree is not edited and nothing is
   evaluated. Any problem fails the build. Without the flags the build is unchanged (the legacy public read pool).
   ============================================================ */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseReadAuthority, READ_AUTHORITY_MAX_BYTES } from "../site/js/core/read-authority.js";

const FLAGS = ["--read-authority", "--read-authority-digest"];
export const READ_AUTHORITY_DECLARATION = "export const READ_AUTHORITY_TEXT = null;";

/** Split the read-authority flags out of the build's argv -> { file, digest, rest } (both or neither). */
export function takeReadAuthorityArgs(argv){
  const got = {}, rest = [];
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (!FLAGS.includes(a)){ rest.push(a); continue; }
    if (a in got) throw new Error(`${a} given twice`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    got[a] = v;
  }
  const file = got["--read-authority"] ?? null, digest = got["--read-authority-digest"] ?? null;
  if ((file === null) !== (digest === null)) throw new Error("--read-authority and --read-authority-digest go together: the file and the sha256 its review recorded");
  return { file, digest, rest };
}

/** Read and check the reviewed authority -> { text, fingerprint, authority }. */
export function readReadAuthority(file, digest){
  if (!/^sha256:[0-9a-f]{64}$/.test(String(digest))) throw new Error("--read-authority-digest must be sha256:<64 lower-case hex>");
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`${file} is not a file`);
  if (st.size > READ_AUTHORITY_MAX_BYTES) throw new Error(`${file} is larger than ${READ_AUTHORITY_MAX_BYTES} bytes`);
  const bytes = fs.readFileSync(file);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  if ("sha256:" + fingerprint !== digest) throw new Error(`${file} is sha256:${fingerprint}, not the reviewed ${digest}`);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`${file} is not UTF-8 text`); }
  let authority;
  try { authority = parseReadAuthority(text); }
  catch (e){ throw new Error(`${file} is not a usable read authority: ${e.message || e}`); }
  return { text, fingerprint, authority };
}

/** The exact source transform the plugin applies (exported so tests exercise the same code). */
export function embedReadAuthority(src, text, where = "read-authority.js"){
  const n = src.split(READ_AUTHORITY_DECLARATION).length - 1;
  if (n !== 1) throw new Error(`${where}: expected exactly one "${READ_AUTHORITY_DECLARATION}", found ${n}`);
  return src.replace(READ_AUTHORITY_DECLARATION, () => `export const READ_AUTHORITY_TEXT = ${JSON.stringify(text)};`);
}

/** esbuild plugin: the bundled read-authority.js carries `text` (exactly) as READ_AUTHORITY_TEXT. */
export function readAuthorityPlugin(text, site){
  const target = path.join(site, "js", "core", "read-authority.js");
  return {
    name: "read-authority",
    setup(b){
      b.onLoad({ filter: /[\\/]js[\\/]core[\\/]read-authority\.js$/ }, async (args) => {
        if (path.resolve(args.path) !== target) return undefined;
        return { contents: embedReadAuthority(await fs.promises.readFile(args.path, "utf8"), text, args.path), loader: "js" };
      });
    },
  };
}
