// dist/node.mjs   - Node ESM (relay, CLI, agents); viem stays an external peer
// dist/browser.mjs - browser ESM with viem bundled (the site vendors this)
// dist/types/     - declarations (tsc)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";

await build({ entryPoints: ["src/node.ts"], outfile: "dist/node.mjs", bundle: true, platform: "node",
  format: "esm", target: "node20", external: ["viem", "viem/*"], legalComments: "none" });
await build({ entryPoints: ["src/browser.ts"], outfile: "dist/browser.mjs", bundle: true, platform: "browser",
  format: "esm", target: "es2022", minify: true, legalComments: "none" });
execFileSync("./node_modules/.bin/tsc", ["-p", "."], { stdio: "inherit" });
console.log("[sessions-sdk] dist/node.mjs, dist/browser.mjs, dist/types");
