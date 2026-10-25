# Generated dependency order correction

The first bundle patch was incomplete: MCP embedded the previous host-admission output, and platform API embedded a relay runtime generated before host-admission. Reviewed the four-file follow-up patch (SHA256 396b2eb75129a15cfa89866dcf339de0a05a486343f7242534fb561013e1d7de), dependency-ordered regeneration, fixed-point second pass, and both independently exported results. Root compared each applied file byte-for-byte against BOTH rebuilt exports. No source module, native input, or executed verifier-only bundle changes here.

The provider verification bundle is behaviourally compatible in ten non-vacuous fixtures, but its conduit input bytes differ. Refresh its manifest/bundle against the final image source before production; do not claim exact input parity. No image or SNP canary exists yet.
