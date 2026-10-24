// node --import <this file URL> <canary host copy> <config>
// Registers resolve-as-original.mjs for ONE entry point. Refuses unless the entry point is exactly the canary copy named
// by CANARY_HOST_COPY_URL and CANARY_HOST_ORIGINAL_URL names an existing custody/v2/host.mjs.
import fs from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const copy = process.env.CANARY_HOST_COPY_URL, original = process.env.CANARY_HOST_ORIGINAL_URL;
if (!copy || !original) throw Error("canary resolve: CANARY_HOST_COPY_URL and CANARY_HOST_ORIGINAL_URL required");
if (!process.argv[1] || pathToFileURL(fs.realpathSync(process.argv[1])).href !== copy) throw Error("canary resolve: the entry point is not the canary host copy");
const originalPath = fileURLToPath(original);
if (!originalPath.endsWith("/custody/v2/host.mjs") || fs.realpathSync(originalPath) !== originalPath || !fs.statSync(originalPath).isFile())
  throw Error("canary resolve: the original must be an existing, non-symlinked custody/v2/host.mjs");
if (originalPath === fileURLToPath(copy)) throw Error("canary resolve: the copy must not be the original");
register("./resolve-as-original.mjs", import.meta.url, { data: { copy, original } });
