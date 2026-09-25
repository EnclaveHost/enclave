# Production domain release 79c5ecf2 (image commit aa6c985c), 2026-09-25: init links musl

**Release id: `79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4`** (= sha256 of `release.json`).

It supersedes a4f22748 (17e182a8) FOR THE NEXT TREE SWITCH. a4f22748 is installed, and it is the tree production's
guestd builds from since 4d (iso-17e182a8). It stays the live tree, and the rollback, until enclave-63's reviewed switch.

## The change (Codex's decision; Enclave's LICENSE unchanged)
The per-app guest's init (m2/dominit.c) links **musl 1.2.6 (MIT)** instead of glibc. Only `template/init` differs from
a4f22748 (`files.txt`). The front, the runtime set (whose glibc stays for wasmtime), the modules, the kernel and the
firmware are byte-identical.
- **Toolchain** (`isolation/m2/build-musl.sh`; `musl-SOURCE.txt`, `musl-COPYRIGHT.txt`):
  - musl-1.2.6.tar.gz, sha256 `d585fd3b613c66151fc3249e8ed44f77020cb5e6c1e635a616d3f9f82460512a`, AND a VALIDSIG by musl's
    release key `836489290BB6B70F99FFDA0556BCDB593020450F`;
  - `CC=/usr/bin/gcc ./configure --prefix=<prefix> --disable-shared`, with gcc 16.2.1 20260810;
  - libc.a `4f72e098…`, identical from two builds into two prefixes.
- **The init line** (m4/app-image-template.sh): `/usr/bin/gcc -specs <musl>/lib/musl-gcc.specs -static -O2 -o init
  dominit.c`. The script REFUSES an init with a program interpreter, a NEEDED library or any glibc string; tested with
  a specs file that leaves gcc on glibc.
- **What IS in init** (`init-link.map`, local paths replaced by `<musl>`, `<dominit.o>`, `<template>`):
  - dominit's object;
  - musl's Scrt1.o, crti.o, crtn.o, and 118 members of musl's libc.a;
  - GCC's crtbeginS.o and crtendS.o (GCC Runtime Library Exception).
  libgcc.a, libgcc_eh.a and libatomic were searched and contributed NOTHING.
- **ELF facts** (`init-elf.txt`): ELF64 static executable; no INTERP; no dynamic section; 0 glibc strings; 0 build
  paths; 81928 bytes (the glibc init was 1024776).
- **The predictor never rebuilds init.** assemble-app-image.sh copies the release's template as it is, so nan needs no
  musl. Only guestd's own template builds on warden-host need it: INSTALL.md step 0, a coordinated host change.

## Checked
- **Reproducible.** Two clean worktrees at aa6c985c, the second with the OTHER musl prefix and a cold Go cache, gave
  the same id, with every file byte-identical.
- **A production front,** unchanged: bd066066…. No tags, the production host and key, no lab strings.
- **On real SNP** (`isolation/m2/lab-release/evidence/output-musl-2026-09-25/`): the musl-init guest runs exactly this
  release's image, serves, and leaks no app output (positive control included).
- **`test-dominit-handoff.sh`** passes against musl as the image links it, and against glibc.
- **The api-mcp-adapter cross-check** (a check, not a pin: the relay predicts every deployment's own): **`20319b02324494bd169750b5f031915feeac5dc165f37ec21dd9bdfce9d875a34d9809716a01c965698f06aa4a83ef47`**.

## Boot path
run-domain.sh, guestd and the legacy tree are unchanged: only a release guest's init changes. So legacy guests (and the
live canaries, if relaunched) are not affected; the legacy re-run of 4e78ba80 stands. The guestd binary stays
4e78ba80's for the tree switch.

## Reviews
Pending: enclave-d1 and enclave-e3 (image and reproducibility), and e3's predictor cross-check.
