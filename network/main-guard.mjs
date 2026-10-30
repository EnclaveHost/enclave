// Imported FIRST by a bundle entry whose program is also a library (network/entries/*). Inside ONE bundle every module's
// import.meta.url is the bundle's own, so a bundled library's "am I the main script?" check (process.argv[1] against its
// own import.meta.url) fires when the bundle runs, and runs that library's command line instead - e.g.
// network/host-services/runner.mjs, which a challenge replica with policy carriers loads INTO the privacy agent: its usage
// line and process.exit(2) stopped the agent. Renaming argv[1] here (as host-services/argv-guard.mjs does for host roles)
// makes every such check false; the entry asks mainScript() instead.
const main = process.argv[1];
if (main) process.argv[1] = `${main} (enclave bundle entry)`;
export const mainScript = () => main;
