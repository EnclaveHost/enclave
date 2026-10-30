# Guest capture canary r3: use the SAME tested capture bytes as finality r10 (for 6d24; this stage does not edit 6d24's stage)

r2's actual failures (run `20261026T064437Z-993ef4a8`) are fixed in **r10's** `capture/a1_capture.py`, sha `47c49b114e6d596a7dd3c46a9f4a5e55bb016cd140a95e001a58ff9a0e69c5b5`. Do not re-implement these fixes independently.

| r2 failure | r10 fix |
|---|---|
| the initial A1 config used `elUrl` `127.0.0.1:28645` (the template's workstation port) | `derive_a1_config` now sets `elUrl` from the reviewed `Sources.el_url` in **both** modes, and refuses any non-loopback value |
| `verify()` NameError `py` | `py` comes from the validated record, after `runtime_accepted` |

1. **Module:** take it from `base-finality-proof-stage/r10/capture/a1_capture.py` and check its sha above. The harness that loads it pins it too: r10 `harness/a2a4.py` `A1_CAPTURE_SHA256` = `47c49b11…`.
2. **Bundle and inputs:**
   - run `r10/tools/assemble_bundle.py` and take the `/opt/enclave-rpc/a1-capture/**` entries of `r10/install/MANIFEST.json`;
   - the A1 gate is `/opt/enclave-rpc/a1gate/*.mjs`;
   - the configs are `r10/install/config-templates/{a1-capture-sources,l1-authority}.json`;
   - the checkpoint is `bundle/config/l1-checkpoint.json` (`2e8502e6`).
   Every byte is sha-pinned there; nothing is copied from the frozen closure stage.
3. **Guest run:** `/usr/bin/python3.12 -I <a1-capture>/a1_capture.py capture initial <OUT1>`, then `capture recheck-capture <OUT2> <OUT1>`, then `verify <OUT2> <OUT1> <initial captureSha256>`. The CLI's capture uses `Sources()` defaults (workstation paths), so the canary must use the settings path. Either:
   - a two-line wrapper calling `capture(mode, out, src=Sources.from_settings('/etc/enclave-rpc/a1-capture-sources.json', initial_capture=…))`; or
   - better, `finality_state`/`reproof`, which already do this.
4. **Expected:**
   - `inputs/a1-config.json` `elUrl` = `http://127.0.0.1:18645` in **both** captures;
   - `verify` returns `python` = the guest 3.12 entry and `runtimePolicy.libnode` = `ce7cb9cd…`;
   - `finality_state.py runtime-verify /usr/bin/node` reports node `f3f93db3` + libnode `ce7cb9cd`.

**r11:** the capture module, harness, tool, producer, wrapper and every bundle entry are byte-identical to r10 (`capture/a1_capture.py` `47c49b11`), so a canary r3 run on the r10 recipe is valid for r11 (r11 changes only reproof retention, the installer, forward_sync log naming and tests).
