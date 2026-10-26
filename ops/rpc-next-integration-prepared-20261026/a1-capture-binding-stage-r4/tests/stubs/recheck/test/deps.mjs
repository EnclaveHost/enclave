// STUB deps.mjs (tests only): resolves ONLY from ANCHOR_DEPS_ROOT, like the reviewed deps.mjs
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.ANCHOR_DEPS_ROOT;
if (!root) throw new Error("ANCHOR_DEPS_ROOT unset");
export const { tag } = await import(pathToFileURL(path.join(root, "node_modules/fakehash/index.mjs")).href);
