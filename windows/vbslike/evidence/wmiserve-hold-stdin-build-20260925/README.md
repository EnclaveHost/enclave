# wmiserve `--hold stdin`: the box build, a reproducibility control, and VM-less refusal checks (2026-09-25)

enclave-d1, on nucbox-k11 (boot 68, Secure Boot ON). Clock reads are from the box. The builds ran 07:38:14-07:38:33Z
and the refusal checks 07:39:37-07:39:38Z. No VM was running, and none was created or dialled.

## Pins for enclave-63

| what | pin |
|---|---|
| source commit | `50010709` (windows/custom-vbs-like-hyperv) |
| host tree | `windows/vbslike/host/` at `50010709`: every file byte-identical to `8f156c9a` except `src/wmiserve.rs` (`52e1b39a…` -> `893f65bd773d50fa…`) |
| lock file | `windows/vbslike/host/Cargo.lock`, sha256 `5c0ee1b7f9d70d1b…`: the box's own lock, committed with this note, and byte-identical to the one that built `0160d835` |
| toolchain | `cargo 1.100.0-nightly (495c385d0 2026-09-16)`, `rustc 1.100.0-nightly (bba531001 2026-09-20)`, MSVC target, the box's shared `cargo-home` |
| command | `cargo build --release --locked --offline`, with its own `CARGO_TARGET_DIR` |
| **binary** | `vbslike-host.exe` sha256 **`15338081b81692a155130ec28e37fa654117a3e769427b621404fff3d6c6bca4`**, 1,128,448 B, at `C:\Users\claude\d1-build-50010709\target\release\vbslike-host.exe` |
| binary, normalized | `37866838364dcb5b…` (link timestamps, checksum and PDB GUID zeroed; see below) |

The pinned `0160d835` at `C:\Users\claude\vbs-like\target\release\vbslike-host.exe` was read, not rebuilt: its sha256
was the same before and after. Warnings: the same 5 dead-code warnings as `0160d835`.

## Reproducibility control

The UNCHANGED `8f156c9a` tree was built the same way into its own directory (`d1-build-control-8f156c9a`). It gave
`cc8707d7…`, not `0160d835…`: the same size, with 24 bytes different.
- All 24 differing bytes are link metadata, found by parsing the PE headers: the COFF TimeDateStamp, the three debug
  directory TimeDateStamps, and the CodeView (RSDS) PDB GUID.
- With those fields and the PE checksum zeroed, the two are IDENTICAL (normalized sha256 `411dbb797ecd58e0…`).
- The embedded paths are the shared cargo-home's and a relative `src\…`. The build directory does not reach the
  binary.

So `0160d835` is reproducible from `8f156c9a` plus this lock and toolchain, apart from its link timestamp and PDB
GUID. A byte-exact rebuild needs a deterministic link (`/Brepro`), which is not used today. Until then a pin names
one built binary, and the normalized hash says what its code is.

## `--hold` refusals, VM-less ([hold-refusals-20260925-073937.txt](hold-refusals-20260925-073937.txt))

Each run used a fresh random VM GUID and a bundle path that does not exist. `wmiserve` parses `--hold` BEFORE it
reads the bundle, so "cannot read" means the hold was accepted, and nothing past it ran.

| binary | `--hold` | result |
|---|---|---|
| new | `0`, `86401`, `90s`, `STDIN`, `forever` | exit 2 `--hold must be whole seconds 1..86400 or \`stdin\`` |
| new | `stdin`, `90`, `86400`, absent | exit 2 `cannot read <bundle>`: the hold was accepted |
| old (control, `8f156c9a`) | `0`, `90s`, `stdin` | exit 2 `cannot read <bundle>`: the old binary accepted each silently |

## NOT established here

- **The lifetime itself.** "A stdin line or EOF ends serving; a numeric hold ends at its deadline" runs after
  `load` and `ready`, so it needs a VM. It is covered by the next acceptance run, through enclave-5d's
  `wmiserve-run.mjs`.
- **No isolation property.** This is host-side launcher plumbing: the monitor-signed T0-hv tier, host_excluded=no.
