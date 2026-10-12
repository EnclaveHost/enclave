# Measured public app configuration

`enclave-catalog-bundle/5` supports public JSON configuration for CPU `wasi:http` components. The configuration is carried in the bundle's `configBase64` field, so its bytes contribute to the measured AppID. Base64 is an encoding, not encryption. Secret delivery remains unsupported on this backend.

The launcher resolves a deployment configuration CID before inline routing metadata. An explicit inline override otherwise takes precedence over the catalog's default CID. The manager and relay independently retrieve and CID-verify the source, parse a JSON object, remove `_media`, and encode compact JSON. Fetches are bounded at 1 MiB; normalized configuration is bounded at 32 KiB. Invalid or unavailable CID configuration fails closed. Legacy bundles retain their original bytes and AppIDs.

The guest monitor validates the configuration and writes a root-owned, read-only `/app.config` in the domain. `domexec` passes its bytes to Wasmtime through inherited `ENCLAVE_CONFIG`; no configuration value is added to the runtime command line. V5 is not available for CLI components, GPU inference bundles, volumes, or secret delivery.

Install a guest built with the matching contract, monitor, and domexec support before setting `ENCLAVE_CONFIG_BUNDLE_V5=1`. Pin its IGVM file and SHA-256 in the manager configuration. The node advertises configuration capabilities only when the manager enables them. The relay must enable `cpu.configBundleV5` and mark the independently measured image/runtime pair with `configBundleV5: true`; config-bearing apps cannot use older admitted images.

The deployed 2026-10-01 CPU IGVM SHA-256 is `20e63b2a6963d50d411850c1bf6d2d17adfd545841edd04260b74b6e498c18da`, with measured boot digest `88d6ff18ed7d9a20528cf89e35c15405229e0bae1ceaa11b0e9074cc141ca036`. Its unchanged Wasmtime 48.0.1 RuntimeID is `ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8`.
