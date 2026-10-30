# Standalone addon preparation review

Claude r2 completed. Root source review plus19focused/integration checks PASS/zero skips. First run18PASS1FAIL: overbroad test incorrectly rejected the shared base class templateUrl=null/fallback. Root narrowed assertion to refuse concrete unresolved template URLs; no production source was changed. Failed evidence retained.

The integration uses actual esbuild/source/vendor bytes and captured live public modules, but a SYNTHETIC existing-tree listing and test-only acceptance of config literals. It does not establish production collisions, realwallet/session compatibility, browser hydration, or activation. Full actual immutable-tree listing, pins and browser smoke remain required. All configs null. Snapshot paths retain staging defaults; not a portable deploy package.

Builder adds standalone funding.html/versioned JS/two versioned SDKs/versioned CSS and leaves existing files unchanged; live router/global sessions vendor remain untouched. Templates baked and old router replaced only with hard navigation. No private key read/export, no owner grant/migration, no relay install. Existing source/live configuration literals independently all found in captured live code; no override accepted yet. Only completed tests here, no browser claim.
