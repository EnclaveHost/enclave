#!/usr/bin/env node
// pa-group-id.mjs <member direct config> [--control-url] -- prints the group id (default) or this member's controlUrl. Pure.
import fs from "node:fs";
import { load } from "./common.mjs";

const MC = await load("metal/guest/measured-control.mjs"), R = await load("metal/guest/platform-api-role.mjs");
const c = MC.canonicalDirectConfig(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
if (!c.platformApi) { console.error("no platformApi member"); process.exit(2); }
console.log(process.argv.includes("--control-url") ? c.platformApi.members.find((m) => m.operator === c.identity.operator).controlUrl : R.groupIdOf(c.platformApi));
