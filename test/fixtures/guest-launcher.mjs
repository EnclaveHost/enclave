// TEST-ONLY entry of the guest fixture image (its IMAGE.json names this instead of /app/network/rpc-runtime-main.mjs): sets
// the listener stand-in's environment from a file beside it (gsup gives the runtime only PATH and HOME), then runs the SAME
// process entry through rpc-runtime-launcher.mjs, which accepts the stand-in's digest. Everything else is the image's.
import fs from 'node:fs';
Object.assign(process.env, JSON.parse(fs.readFileSync(new URL('./guest-launch-env.json', import.meta.url), 'utf8')));
if (process.argv[2] === 'run') process.argv.splice(2, 1);     // gsup passes `run <config>`, as rpc-runtime-main.mjs takes it
await import('./rpc-runtime-launcher.mjs');
