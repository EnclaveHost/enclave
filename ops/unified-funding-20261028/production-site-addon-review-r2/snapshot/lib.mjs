/* ============================================================
   funding-r2 addon: pure checks + transforms used by build.mjs.
   No filesystem writes here; every refusal is a thrown Error.
   ============================================================ */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const VERSION = "funding-r2";
export const PINS_SCHEMA = "enclave-funding-addon-pins-r2";
export const CONFIG_SCHEMA = "enclave-funding-addon-config-r2";
export const LEGACY_SESSIONS_PREFIX = "9dda76f6";        // the qualified source site/vendor/sessions.js
export const HARD_NAV = "enclave-addon:hard-nav";
export const FUNDING_PAGE = "enclave-addon:funding-page";
export const WALLET_BUTTON = "enclave-addon:wallet-button";
export const COMPONENT_JS = /^site\/components\/[^/]+\/[^/]+\.js$/;   // build-site.mjs inlineTemplates filter

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");
export const cspHash = (s) => "'sha256-" + createHash("sha256").update(s, "utf8").digest("base64") + "'";
const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function countOf(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/** Exact replacements: each `from` occurs exactly once, each `to` not at all; the result must reverse to the
 *  original bytes exactly (recorded as reverseEqual). */
export function applyExact(rel, text, pairs) {
  let out = text;
  const records = [];
  for (const [from, to] of pairs) {
    if (!from || !to || from === to) throw new Error(`${rel}: empty or identity replacement`);
    const n = countOf(out, from);
    if (n !== 1) throw new Error(`${rel}: expected exactly one ${JSON.stringify(from)}, found ${n}`);
    if (countOf(out, to) !== 0) throw new Error(`${rel}: replacement text already present: ${JSON.stringify(to)}`);
    out = out.replace(from, () => to);
    records.push({ from, to });
  }
  let back = out;
  for (const { from, to } of [...records].reverse()) {
    if (countOf(back, to) !== 1) throw new Error(`${rel}: replacement not reversible: ${JSON.stringify(to)}`);
    back = back.replace(to, () => from);
  }
  if (back !== text) throw new Error(`${rel}: replacements do not reverse to the original bytes`);
  return { text: out, records, reverseEqual: true };
}

/** The only source edits: versioned SDK paths, and the old router's navigate() -> the addon's hard navigation. */
export function sourceReplacements({ sessionsUrl, fundingUrl }) {
  return {
    "site/js/pages/funding.js": [[`import("/vendor/funding.js")`, `import(${JSON.stringify(fundingUrl)})`]],
    "site/js/core/sessions.js": [[`import("/vendor/sessions.js")`, `import(${JSON.stringify(sessionsUrl)})`]],
    "site/components/wallet-button/wallet-button.js": [[`import { navigate } from "../../js/boot.js";`, `import { navigate } from "${HARD_NAV}";`]],
    "site/js/core/wallet.js": [[`(await import("../boot.js")).navigate(`, `(await import("${HARD_NAV}")).navigate(`]],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reviewed configuration input
// ---------------------------------------------------------------------------------------------------------------
export const FUNDING_KEYS = ["FUNDING_RUNTIME", "FUNDING_MIGRATION_PROPOSAL", "FUNDING_MIGRATION_APPROVAL"];
const FUNDING_SCHEMA = {
  FUNDING_RUNTIME: "enclave-funding-browser-runtime-r1",
  FUNDING_MIGRATION_PROPOSAL: "enclave-funding-migration-proposal-r1",
  FUNDING_MIGRATION_APPROVAL: "enclave-funding-migration-approval-r1",
};
const CONFIG_KEYS = new Set(["schema", "release", "reviewed", "note", "overrides", "acceptLegacy", "funding"]);
const SAFE_LITERAL = /^(https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~/-]*)?|0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64})$/;

export function validateConfig(cfg) {
  if (!isObj(cfg)) throw new Error("config: not an object");
  for (const k of Object.keys(cfg)) if (!CONFIG_KEYS.has(k)) throw new Error(`config: unknown key ${k}`);
  if (cfg.schema !== CONFIG_SCHEMA) throw new Error(`config: schema must be ${CONFIG_SCHEMA}`);
  if (cfg.release !== "disabled" && cfg.release !== "enabled") throw new Error("config: release must be disabled or enabled");
  if (!Array.isArray(cfg.overrides) || !Array.isArray(cfg.acceptLegacy)) throw new Error("config: overrides and acceptLegacy must be arrays");
  const f = cfg.funding;
  if (!isObj(f) || Object.keys(f).sort().join() !== [...FUNDING_KEYS].sort().join())
    throw new Error(`config: funding must list exactly ${FUNDING_KEYS.join(", ")} (null = off)`);
  if (cfg.release === "disabled") {
    for (const k of FUNDING_KEYS) if (f[k] !== null) throw new Error(`config: a disabled release keeps ${k} null`);
  } else {
    if (cfg.reviewed !== true) throw new Error("config: an enabled release needs reviewed: true");
    if (!isObj(f.FUNDING_RUNTIME)) throw new Error("config: an enabled release needs a concrete FUNDING_RUNTIME");
    for (const k of FUNDING_KEYS)
      if (f[k] !== null && (!isObj(f[k]) || f[k].schema !== FUNDING_SCHEMA[k])) throw new Error(`config: ${k} must be null or schema ${FUNDING_SCHEMA[k]}`);
    if (f.FUNDING_MIGRATION_APPROVAL !== null && (f.FUNDING_MIGRATION_PROPOSAL === null || f.FUNDING_MIGRATION_APPROVAL.rootReviewed !== true))
      throw new Error("config: an approval is carried only as supplied (rootReviewed: true) together with its proposal");
  }
  for (const o of cfg.overrides) {
    if (!isObj(o) || Object.keys(o).sort().join() !== "literal,reason,value") throw new Error("config: override needs exactly literal, value, reason");
    if (!SAFE_LITERAL.test(o.literal) || !SAFE_LITERAL.test(o.value)) throw new Error(`config: override literal/value must be https URLs or 0x hex: ${o.literal}`);
    if (o.literal === o.value || typeof o.reason !== "string" || !o.reason.trim()) throw new Error(`config: override ${o.literal} needs a different value and a reason`);
  }
  for (const a of cfg.acceptLegacy) if (typeof a !== "string" || !SAFE_LITERAL.test(a)) throw new Error(`config: acceptLegacy entry ${a}`);
  return cfg;
}

/** config.js edits: reviewed literal overrides, then any concrete FUNDING_* value replacing its `= null`. */
export function configReplacements(cfg) {
  validateConfig(cfg);
  const pairs = cfg.overrides.map((o) => [JSON.stringify(o.literal), JSON.stringify(o.value)]);
  for (const k of FUNDING_KEYS)
    if (cfg.funding[k] !== null) pairs.push([`export const ${k} = null;`, `export const ${k} = ${JSON.stringify(cfg.funding[k])};`]);
  return pairs;
}

/** Quoted endpoint / address literals of config.js (comments are unquoted and not matched). */
export function configLiterals(text) {
  return [...new Set([...text.matchAll(/"(https?:\/\/[^"\s]+|0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)"/g)].map((m) => m[1]))];
}

/** Every legacy literal must be present in the live public bundle evidence, explicitly accepted, or overridden. */
export function checkConfigLiterals(text, liveCorpus, cfg) {
  const corpus = liveCorpus.toLowerCase();
  const accepted = new Set(cfg.acceptLegacy.map((s) => s.toLowerCase()));
  const overridden = new Map(cfg.overrides.map((o) => [o.literal.toLowerCase(), o.value]));
  const report = configLiterals(text).map((l) => {
    const k = l.toLowerCase();
    const status = overridden.has(k) ? "overridden" : corpus.includes(k) ? "in-live" : accepted.has(k) ? "root-accepted" : "unconfirmed";
    return { literal: l, status, ...(overridden.has(k) ? { value: overridden.get(k) } : {}) };
  });
  const bad = report.filter((r) => r.status === "unconfirmed").map((r) => r.literal);
  if (bad.length) throw new Error(`config.js literals neither in live evidence nor reviewed (override or acceptLegacy): ${bad.join(", ")}`);
  for (const o of cfg.overrides)
    if (!report.some((r) => r.literal.toLowerCase() === o.literal.toLowerCase())) throw new Error(`config: override ${o.literal} is not a config.js literal`);
  return report;
}

// ---------------------------------------------------------------------------------------------------------------
// Component templates (build-site.mjs mechanisms, unchanged in effect)
// ---------------------------------------------------------------------------------------------------------------
export function inlineTemplate(rel, src, readTpl) {
  const out = src.replace(/static templateUrl = new URL\("\.\/([\w.-]+\.html)", import\.meta\.url\);/g,
    (_, name) => `static _tpl = ${JSON.stringify(readTpl(name))};`);
  if (out.includes("templateUrl = new URL")) throw new Error(rel + ": template pattern not inlined (unexpected shape)");
  return out;
}

/** build-site.mjs bake(), minus its WALLET_PAINT inline script; `tpl(name)` returns the trimmed template or null. */
export function bake(html, tpl) {
  let pos = 0, guard = 0;
  while (guard++ < 2000) {
    const idx = html.indexOf("<c-", pos);
    if (idx === -1) break;
    const tagEnd = html.indexOf(">", idx);
    const open = html.slice(idx, tagEnd + 1);
    const name = /^<c-([a-z-]+)/.exec(open)[1];
    const attrStr = open.slice(3 + name.length, -1);
    const t = attrStr.includes("data-ssr") ? null : tpl(name);
    if (!t) { pos = idx + 3; continue; }
    const close = "</c-" + name + ">";
    const end = html.indexOf(close, tagEnd + 1);
    if (end === -1) throw new Error("unclosed <c-" + name + ">");
    const inner = html.slice(tagEnd + 1, end);
    const attrs = {};
    for (const m of attrStr.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attrs[m[1]] = m[2] ?? "";
    let out = t;
    for (const [k, v] of Object.entries(attrs)) out = out.split("{" + k + "}").join(v);
    out = out.replace("<slot></slot>", () => inner.trim());
    if (name === "header" && attrs.current)
      out = out.replace(`data-view="${attrs.current}"`, () => `data-view="${attrs.current}" class="active"`);
    html = html.slice(0, idx) + `<c-${name}${attrStr} data-ssr>` + out + close + html.slice(end + close.length);
    pos = idx;
  }
  if (guard >= 2000) throw new Error("bake(): runaway expansion");
  return html;
}

/** Bodies of executable inline scripts (build-site.mjs CSP scan rules). */
export function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = m;
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']([^"']*)["']/i) || [, ""])[1].toLowerCase();
    if (type && !["module", "text/javascript", "application/javascript"].includes(type)) continue;
    if (body.trim()) out.push(body);
  }
  return out;
}

export const htmlReplacements = ({ cssHref, moduleHref, keepCss }) => [
  ...(keepCss ? [] : [['<link rel="stylesheet" href="css/site.css" />', `<link rel="stylesheet" href="${cssHref}" />`]]),
  ['<script type="module" blocking="render" src="js/boot.js"></script>', `<script type="module" src="${moduleHref}"></script>`],
];

/** Standalone document: exact head edits, inline scripts dropped (no new CSP hashes), components prerendered. */
export function transformHtml(src, { tpl, cssHref, moduleHref, keepCss = false, stamp }) {
  const r = applyExact("site/funding.html", src, htmlReplacements({ cssHref, moduleHref, keepCss }));
  const removedInlineScripts = [];
  let s = r.text.replace(/<script>([\s\S]*?)<\/script>\n?/g, (_, body) => {
    removedInlineScripts.push({ sha256: sha256(body), csp: cspHash(body) });
    return "";
  });
  s = bake(s, tpl);
  if (stamp) s = s.replace(/(<span data-build>)[^<]*(<\/span>)/, (_, a, b) => a + stamp + b);
  if (s.includes("boot.js")) throw new Error("funding.html still references boot.js");
  if (inlineScripts(s).length) throw new Error("funding.html carries an executable inline script (CSP)");
  const unbaked = [...new Set([...s.matchAll(/<c-([a-z-]+)(?![^>]*data-ssr)[^>]*>/g)].map((m) => m[1]))];
  return { html: s, replacements: r.records, reverseEqual: r.reverseEqual, removedInlineScripts, unbaked };
}

/** Same-origin href/src references of a document. */
export function localRefs(html) {
  return [...new Set([...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1])
    .filter((r) => r && !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(r)))].sort();
}

/** Does a same-origin reference land on a path of `set` (pretty URL, .html or directory index)? */
export function existsIn(ref, set) {
  const p = ref.split(/[?#]/)[0].replace(/^\.\//, "").replace(/^\/+/, "");
  if (p.split("/").includes("..")) return false;
  const c = p === "" ? ["index.html"] : p.endsWith("/") ? [p + "index.html"] : [p, p + ".html", p + "/index.html"];
  return c.some((x) => set.has(x));
}

export function cssRefs(css) {
  const refs = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2].trim());
  for (const m of css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'");\s]+)/g)) refs.push(m[1]);
  return [...new Set(refs.filter((r) => !/^(data:|https:|#)/i.test(r)))].sort();
}

export function cssRefPath(ref) {
  const p = ref.split(/[?#]/)[0];
  const n = p.startsWith("/") ? p.slice(1) : path.posix.normalize("css/" + p);
  if (n.startsWith("..") || n.startsWith("/")) throw new Error("css reference escapes the site: " + ref);
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Existing tree, additions, closure, externals
// ---------------------------------------------------------------------------------------------------------------
export function parseExistingPaths(text) {
  const set = new Set();
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const p = l.replace(/^\/+/, "");
    if (p.includes("\\") || p.split("/").some((s) => s === "." || s === ".." || s === "")) throw new Error("existing-paths: bad entry " + l);
    set.add(p);
  }
  if (!set.size) throw new Error("existing-paths: empty");
  return set;
}

const ADD_PATH = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
/** Additions only: safe relative paths, no duplicates, no collision (case-insensitive) with any existing file or directory. */
export function planAdditions(additions, existing) {
  const lower = new Set([...existing].map((p) => p.toLowerCase()));
  const dirs = new Set();
  for (const p of lower) { const s = p.split("/"); for (let i = 1; i < s.length; i++) dirs.add(s.slice(0, i).join("/")); }
  const seen = new Set();
  for (const a of additions) {
    const p = a.path;
    if (typeof p !== "string" || !ADD_PATH.test(p)) throw new Error("addition path refused (traversal/shape): " + p);
    const k = p.toLowerCase();
    if (seen.has(k)) throw new Error("duplicate addition " + p);
    seen.add(k);
    if (lower.has(k) || dirs.has(k)) throw new Error("addition collides with an existing path: " + p);
    const s = k.split("/");
    for (let i = 1; i < s.length; i++) if (lower.has(s.slice(0, i).join("/"))) throw new Error("addition directory collides with an existing file: " + p);
  }
  return additions;
}

export const REQUIRED_INPUTS = [
  "addon:src/entry.js", "addon:src/hard-nav.js",
  "site/js/pages/funding.js", "site/js/funding/state.js", "site/js/funding/flows.js",
  "site/js/core/sessions.js", "site/js/core/wallet.js", "site/js/core/api.js", "site/js/core/config.js", "site/js/core/util.js",
  "site/components/wallet-button/wallet-button.js", "site/components/header/header.js",
  "site/components/footer/footer.js", "site/components/toast/toast.js",
];
const ALLOWED_INPUT = [
  /^addon:src\/(entry|hard-nav)\.js$/,
  /^site\/js\/pages\/funding\.js$/,
  /^site\/js\/(?!pages\/|boot\.js$|router)[\w./-]+\.m?js$/,
  /^site\/components\/[\w-]+\/[\w-]+\.js$/,
  /^sdk\/[\w./-]+\.m?js$/,
  /^node_modules\/[\w@./-]+\.m?js$/,
];
const TESTISH = /(^|\/)(tests?|__tests__|fixtures?|mocks?)(\/|$)|\.(test|spec)\.m?js$/i;

/** The bundled module graph: funding page + its core/components/sdk only; never the old router or other pages. */
export function checkClosure(rels) {
  const set = new Set(rels);
  const missing = REQUIRED_INPUTS.filter((r) => !set.has(r));
  if (missing.length) throw new Error("module graph lacks required inputs: " + missing.join(", "));
  const bad = rels.filter((r) => TESTISH.test(r) || !ALLOWED_INPUT.some((re) => re.test(r)));
  if (bad.length) throw new Error("module graph includes refused inputs: " + bad.join(", "));
  return rels;
}

export const vendorRefs = (text) => [...new Set([...text.matchAll(/["'`](\/vendor\/[^"'`\s]*)["'`]/g)].map((m) => m[1]))].sort();

/** Runtime module references: the two versioned SDKs, or an unchanged global /vendor file of the existing tree. */
export function checkExternals(specs, { versioned, existing }) {
  const bad = [];
  for (const s of new Set(specs)) {
    if (versioned.includes(s)) continue;
    const m = /^\/(vendor\/[\w.-]+\.js)$/.exec(s);
    if (m && m[1] !== "vendor/sessions.js" && m[1] !== "vendor/funding.js" && existing.has(m[1])) continue;
    bad.push(s);
  }
  if (bad.length) throw new Error("module references not allowed: " + bad.join(", "));
  return [...new Set(specs)].sort();
}

/** Import specifiers found in an opaque vendor bundle (scanned, never edited). */
export function vendorImportSpecifiers(text) {
  const re = /(?:\bimport\s*\(\s*|[}*\s]from\s*|\bimport\s*)(["'])([^"'\n]{1,200})\1/g;
  return [...new Set([...text.matchAll(re)].map((m) => m[2]))].sort();
}

/** A regular file reached without any symlink on its path. */
export function readRegular(p) {
  const abs = path.resolve(p);
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) throw new Error("symlink refused: " + abs);
  if (!st.isFile()) throw new Error("not a regular file: " + abs);
  if (fs.realpathSync(abs) !== abs) throw new Error("path passes through a symlink: " + abs);
  return fs.readFileSync(abs);
}

export function jsFilesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error("symlink refused: " + p);
    if (e.isDirectory()) out.push(...jsFilesUnder(p));
    else if (e.isFile() && p.endsWith(".js")) out.push(p);
  }
  return out.sort();
}

export function validatePins(p) {
  if (!isObj(p) || p.schema !== PINS_SCHEMA) throw new Error(`pins: schema must be ${PINS_SCHEMA}`);
  if (p.reviewed !== true) throw new Error("pins: not marked reviewed: true");
  for (const k of ["config", "existingPaths", "liveInventory", "liveSessionsVendor"])
    if (!HEX64.test(p[k] ?? "")) throw new Error(`pins: ${k} missing or not a sha256`);
  if (typeof p.esbuildVersion !== "string" || !p.esbuildVersion) throw new Error("pins: esbuildVersion missing");
  if (!isObj(p.inputs) || !Object.keys(p.inputs).length) throw new Error("pins: inputs missing");
  for (const [k, v] of Object.entries(p.inputs)) if (!HEX64.test(v ?? "")) throw new Error(`pins: input ${k} missing or not a sha256`);
  if (!String(p.inputs["site/vendor/sessions.js"]).startsWith(LEGACY_SESSIONS_PREFIX))
    throw new Error(`pins: site/vendor/sessions.js must be the qualified ${LEGACY_SESSIONS_PREFIX}… source`);
  return p;
}
