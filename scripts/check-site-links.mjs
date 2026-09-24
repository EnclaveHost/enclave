#!/usr/bin/env node
// Internal link + anchor checker over a built site tree (default site/dist):
// every same-site href must resolve to a shipped file (pretty URLs via
// _redirects), and every #anchor must exist as an id in the target document.
// Run after `npm run build:site`: node scripts/check-site-links.mjs [dist]
import fs from "node:fs"; import path from "node:path";
const DIST = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "site", "dist"));
const redirects = Object.fromEntries(fs.readFileSync(path.join(DIST, "_redirects"), "utf8").split("\n")
  .filter(l => l && !l.startsWith("#")).map(l => l.trim().split(/\s+/)).filter(p => p.length >= 2).map(([from, to]) => [from, to]));
const pages = ["index.html", "apps.html", "develop.html", "host.html", "architecture.html", "terms.html", "privacy.html", "404.html", "dashboard.html", "checkout.html", "link.html", "authorize.html", "admin.html"];
const ids = {};
for (const p of pages) {
  const html = fs.readFileSync(path.join(DIST, p), "utf8");
  ids[p] = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
}
// component templates can carry ids that only exist after hydration; the
// built pages are prerendered, so they are already in the html above
const resolve = (href) => {
  let [p, hash] = href.split("#");
  if (p === "" || p === "./") p = "index.html";
  if (p.startsWith("./")) p = p.slice(2);
  if (redirects["/" + p]) p = redirects["/" + p].replace(/^\//, "");
  if (p.endsWith("/")) p = p + "index.html";
  if (!p.endsWith(".html") && !p.includes(".")) p = p + ".html";
  return [p, hash];
};
let bad = 0, checked = 0;
for (const p of pages) {
  const html = fs.readFileSync(path.join(DIST, p), "utf8");
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|data:|tel:)/.test(href)) continue;
    if (href.startsWith("#")) {
      if (href === "#publish" && p === "apps.html") continue;   // router view alias, not an anchor
      checked++;
      if (!ids[p].has(href.slice(1)) && href !== "#") { console.log(`${p}: missing in-page anchor ${href}`); bad++; }
      continue;
    }
    const [file, hash] = resolve(href);
    checked++;
    const fp = path.join(DIST, file);
    if (!fs.existsSync(fp)) { console.log(`${p}: ${href} -> ${file} does not exist`); bad++; continue; }
    if (hash) {
      const set = ids[file] || new Set([...fs.readFileSync(fp, "utf8").matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
      if (!set.has(hash)) { console.log(`${p}: ${href} -> ${file} has no id="${hash}"`); bad++; }
    }
  }
}
console.log(`${checked} internal links checked, ${bad} broken`);
process.exit(bad ? 1 : 0);
