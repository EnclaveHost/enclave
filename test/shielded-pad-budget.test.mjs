// Regression tests for the pad-budget diagnostic (SHIELDED_PAD_BUDGET).
//
// Three C fixtures, each compiled and run in its own temporary directory that
// is removed afterwards. They exercise the SHIPPED sources directly: two of
// them #include a production .c so they can reach its private structures and
// hold its real mutexes, which is the only way to reach the uint64-overflow and
// capacity branches (no minted shipment can produce them) and to produce a
// genuine BUSY. No device, worker, socket, shipment, window or pad cell is
// involved anywhere, and nothing is started: the "started link" states are
// fabricated on objects the fixture owns.
//
//   node --test test/shielded-pad-budget.test.mjs
//   CC=clang node --test test/shielded-pad-budget.test.mjs
//   SHIELDED_PAD_BUDGET_SAN=0 node --test test/shielded-pad-budget.test.mjs   // sanitizers off
//
// ARCHITECTURE. shielded-tee.c builds its SIMD dispatch tables unconditionally,
// so the link needs the symbols for this architecture's fast implementation as
// well as the generic one, and shielded-simd.c is compiled once per set:
//
//   arm64  -> simd-generic.o (sh_simd_generic_*) + simd-neon.o   (sh_simd_neon_*)
//   x64    -> simd-generic.o (sh_simd_generic_*) + simd-avx512.o (sh_simd_avx512_*)
//
// Compiling the generic object twice instead would BOTH duplicate
// sh_simd_generic_* and leave the fast symbols undefined, so an architecture
// without a mapping here is an explicit failure rather than a silent skip.
// SHIELDED_NO_SIMD=1 at run time keeps the fixtures on the generic path: which
// implementation runs is irrelevant to pad-budget metadata, and it avoids
// paying for (and depending on) the startup agreement check.
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CC = process.env.CC || "cc";
const SAN = process.env.SHIELDED_PAD_BUDGET_SAN !== "0";
const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const ggml = (name) => repo(`wasm/ggml-shielded/${name}`);
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// -I wasm/ggml-shielded: the fixtures reach the production sources by relative
// path, but anchor_pad_budget_report.h includes shielded-pad-budget.h
// unqualified, exactly as the engine build resolves it.
const FLAGS = ["-std=gnu11", "-O1", "-g", "-Wall", "-Wextra",
  "-I", repo("wasm/ggml-shielded"),
  "-ffunction-sections", "-fdata-sections", "-ffp-contract=off",
  ...(SAN ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer",
             "-fno-sanitize-recover=undefined"] : [])];

// The fast SIMD build for this architecture. Named explicitly so an
// unsupported host says what is missing instead of failing at link time.
const FAST = {
  arm64: { obj: "simd-neon.o", symbols: "sh_simd_neon_*",
           flags: ["-march=armv8.2-a+dotprod", "-DSH_SIMD_NEON"] },
  x64:   { obj: "simd-avx512.o", symbols: "sh_simd_avx512_*",
           flags: ["-mavx512f", "-mavx512bw", "-mavx512dq", "-mavx512vl",
                   "-mavx512vnni", "-DSH_SIMD_AVX512"] },
}[process.arch];

// execFileSync already throws on a non-zero exit, but with stdio "pipe" the
// child's own message is buried in the error object. Surface it, so a failing
// assertion inside a fixture is readable in the test output, and rethrow so the
// failure still propagates.
function run(what, file, args, opts = {}) {
  try {
    return execFileSync(file, args, { stdio: "pipe", ...opts });
  } catch (err) {
    const out = [err.stdout, err.stderr].map((b) => (b ? b.toString() : "")).join("");
    throw new Error(`${what} failed (${err.status ?? err.code ?? "no status"})\n${out}`);
  }
}

// One temporary directory per fixture: every object, binary and scratch file the
// fixture writes lives inside it, and it is removed even when the test fails.
function build_and_run(name, { core = [], simd = false }) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  try {
    const objs = [];
    if (simd) {
      if (!FAST) {
        throw new Error(
          `unsupported architecture ${process.arch}: shielded-tee.c needs a fast SIMD ` +
          `build alongside the generic one. Add a mapping for it (object name and ` +
          `-DSH_SIMD_* flags) before running this test here.`);
      }
      const generic = join(dir, "simd-generic.o"), fast = join(dir, FAST.obj);
      run("compile simd-generic.o", CC, [...FLAGS, "-O2", "-c", ggml("shielded-simd.c"), "-o", generic],
        { timeout: 60_000 });
      run(`compile ${FAST.obj} (${FAST.symbols})`, CC,
        [...FLAGS, "-O2", ...FAST.flags, "-c", ggml("shielded-simd.c"), "-o", fast], { timeout: 60_000 });
      objs.push(generic, fast);
    }
    const bin = join(dir, "fixture");
    run(`compile and link ${name}`, CC,
      [...FLAGS, fixture(`${name}.c`), ...core.map(ggml), ...objs,
        "-Wl,--gc-sections", "-lpthread", "-lm", "-o", bin], { timeout: 120_000 });

    // A clean SHIELDED_* environment: the report fixture sets and unsets
    // SHIELDED_PAD_BUDGET itself and must not inherit one, and nothing here
    // should pick up a developer's pad or profile knobs.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("SHIELDED_")));
    run(`run ${name}`, bin, [dir], {
      timeout: 120_000,
      env: { ...env, SHIELDED_NO_SIMD: "1",
             ASAN_OPTIONS: "detect_leaks=1:abort_on_error=1",
             UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The reader's coverage union: adjacency, holes, nesting, uint64 overflow, the
// interval and input-file caps, unbound and failed-rebind readers, and BUSY.
test("pad-budget coverage is an interval union that refuses rather than over-claims", () => {
  build_and_run("shielded-pad-budget-coverage",
    { core: ["shielded-field.c", "tweetnacl.c", "poly1305-donna.c"], simd: true });
});

// The link snapshot: unstarted and started links, ring and window metadata,
// the counter-exclusion flag, and both BUSY shapes.
test("pad-budget link snapshot reports only what it observed", () => {
  build_and_run("shielded-pad-budget-link", {
    core: ["shielded-field.c", "shielded-wire.c", "shielded-bank.c", "shielded-http.c",
           "prefix-kv.c", "tweetnacl.c", "poly1305-donna.c"],
    simd: true,
  });
});

// The stderr record writer: line grammar, bounds, name encoding, and that
// nothing reaches stdout. Header-only, so it needs no core sources at all.
test("pad-budget records are bounded, unambiguous and stderr-only", () => {
  build_and_run("shielded-pad-budget-report", {});
});
