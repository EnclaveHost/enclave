#!/usr/bin/env node
/* ============================================================
   Privy checkout bundle — vendors @privy-io/react-auth (+ React
   + Stripe's onramp client) into site/privy/ as a self-hosted,
   code-split ESM bundle. buy.html imports /privy/entry.js; no
   CDN at runtime (esm.sh cold-builds 408'd a live checkout once
   — never again).

   Why @stripe/crypto is a real dependency and not an external:
   react-auth's fiat onramp (v3.33.1+, the Stripe Crypto Onramp
   surface announced 2026-07-07) lazily `import("@stripe/crypto")`s
   it. A bare specifier can't resolve in the browser — if it's
   left external the Stripe path dies at runtime with
   "@stripe/crypto is required ... could not be loaded" (exactly
   the regression that killed card checkout in July 2026).

   Deps install into scripts/.privy-build/ (gitignored), pinned
   below; bump the pins and re-run to upgrade:

     node scripts/build-privy.mjs
   ============================================================ */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WORK = path.join(ROOT, "scripts", ".privy-build");
const OUT = path.join(ROOT, "site", "privy");

const DEPS = {
  "@privy-io/react-auth": "3.35.1",   // >=3.33.1 for the Stripe fiat onramp;
                                      // 3.35.0 fixed Stripe L2 KYC routing (L1 steps were
                                      // skipped -> EU identity verification span forever and
                                      // timed out), 3.35.1 fixed checkout retries when the
                                      // quote expires during payment - both hit live 2026-07-20
  "react": "18.3.1",
  "react-dom": "18.3.1",
  "@stripe/crypto": "1.1.1",
  "@stripe/stripe-js": "1.54.2",      // @stripe/crypto peers ^1.46.0 (not 2+)
  /* react-auth optional peers. Not optional for us: the SDK's initial
     import graph reaches them STATICALLY (v3.34.0 pulls @solana/kit at top
     level), so leaving them external breaks module resolution in the
     browser before a single screen renders. Kit is held at 5.x (wagmi's
     @coinbase/cdp-sdk peers ^5.5.1) and the @solana-program pins are the
     last releases that peer kit ^5 — newer ones demand kit 6 and ERESOLVE. */
  "@abstract-foundation/agw-client": "^1.0.0",
  "@farcaster/mini-app-solana": "^1.0.0",
  "@solana/kit": "^5.5.1",
  "@solana-program/memo": "0.10.0",
  "@solana-program/system": "0.10.0",
  "@solana-program/token": "0.9.0",
  "permissionless": "^0.2.47",
};

fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, "package.json"), JSON.stringify({
  name: "privy-bundle-build", private: true, dependencies: DEPS,
}, null, 2));
console.log("[privy] npm install (pinned deps)");
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"],
  { cwd: WORK, stdio: ["ignore", "inherit", "inherit"] });

/* exactly the surface buy.html destructures */
fs.writeFileSync(path.join(WORK, "entry.js"), `
export { PrivyProvider, usePrivy, useFundWallet, useFiatOnramp, useWallets, getAccessToken } from "@privy-io/react-auth";
export * as React from "react";
export { createRoot } from "react-dom/client";
`);

console.log("[privy] esbuild -> site/privy/");
fs.rmSync(OUT, { recursive: true, force: true });
await build({
  entryPoints: [path.join(WORK, "entry.js")],
  bundle: true,
  splitting: true,                    // lazy screens -> local chunks
  format: "esm",
  target: ["es2022"],
  minify: true,
  outdir: OUT,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});

const files = fs.readdirSync(OUT);
const bundled = execFileSync("grep", ["-l", "js.stripe.com", "-r", OUT]).toString().trim();
if (!bundled) throw new Error("@stripe/crypto missing from the bundle — the Stripe onramp would be dead on arrival");
console.log(`[privy] ${files.length} files, @stripe/crypto bundled ✓`);
