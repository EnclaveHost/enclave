// Imported FIRST by a host role's bundle entry (network/host-services/entries/*) whose program is a plain script.
// A role runs as `node <role>.mjs`, and inside ONE bundle every module's import.meta.url is the bundle's own. A bundled
// library's "am I the main script?" check (process.argv[1] against its own import.meta.url - e.g. the Windows host-identity
// CLI inside relay/network-runtime.bundle.mjs) would therefore fire and run that library's command line instead of the
// role (and exit). Renaming argv[1] here makes every such check false; the role's program reads only its environment.
process.argv[1] = `${process.argv[1]} (enclave host role)`;
