// The metal guest image compiles wasm/ggml-shielded from source with its own
// unit list (metal/build-image.mjs) that mirrors the Makefile. The two drift
// silently: a source added to CORE_SRC but not to the units links into a
// libggml-shielded.so with undefined symbols that fails only at dlopen inside
// the enclave (the shielded backend then simply does not exist there). This
// pins the lists together and the link flag that turns that into a build error.
//   run: node --test test/metal-shielded-build.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const makefile = fs.readFileSync(path.join(root, "wasm/ggml-shielded/Makefile"), "utf8");
const builder = fs.readFileSync(path.join(root, "metal/build-image.mjs"), "utf8");

test("every source the Makefile links into libggml-shielded.so is a unit of the image build", () => {
  const core = makefile.match(/^CORE_SRC\s*:=\s*(.+)$/m);
  assert.ok(core, "CORE_SRC in the Makefile");
  const srcs = core[1].trim().split(/\s+/);
  assert.ok(srcs.includes("shielded-tee.c") && srcs.includes("shielded-pads.c"), "sanity: " + srcs.join(" "));
  const units = [...builder.matchAll(/\{\s*src:\s*'([^']+)'/g)].map((m) => m[1]);
  for (const s of srcs) assert.ok(units.includes(s), `${s} is in CORE_SRC but not in metal/build-image.mjs units`);
  for (const s of ["shielded-simd.c", "ggml-shielded.cpp"]) assert.ok(units.includes(s), s);
  // and nothing the Makefile does not know (a unit that exists only in the image)
  for (const u of units) assert.ok(srcs.includes(u) || u === "shielded-simd.c" || u === "ggml-shielded.cpp", `${u} is an image unit the Makefile never links`);
});

test("the image build refuses undefined symbols in the shielded library", () => {
  assert.match(builder, /-Wl,--no-undefined/, "the .so link must carry -Wl,--no-undefined");
  // the dealer-only path stays out of the image: no SHIELDED_DEALER_MODE flag in any unit
  assert.doesNotMatch(builder, /SHIELDED_DEALER_MODE/, "the image must never carry the zero-pad mint path");
});

// The builder's glibc is NEWER than the engine image's. gcc turns
// `1/sqrt(mean+eps)` (shielded-fusion.h) into a call to libm's sqrtf, and on a
// glibc-2.43 host that call binds to sqrtf@GLIBC_2.43 — a version node the
// guest's libm does not define. The .so then fails to dlopen inside the
// enclave, the wasm-manager's shielded probe reports shieldedPool:false with
// its stderr on /dev/null, and the supervisor advertises 0% of a card: two
// healthy GPUs, no market, no error. -fno-math-errno makes sqrtf the sqrtss
// instruction, referencing nothing. (metal0, 2026-09-13.)
test("both shielded build paths keep the glibc-skew flag", () => {
  assert.match(builder, /-fno-math-errno/, "metal/build-image.mjs base flags");
  assert.match(makefile, /^CFLAGS\s+\?=.*-fno-math-errno/m, "Makefile CFLAGS");
  assert.match(makefile, /^CXXFLAGS\s+\?=.*-fno-math-errno/m, "Makefile CXXFLAGS");
});

test("the image build proves the shielded library would load inside the guest", () => {
  assert.match(builder, /function assertLoadableInGuest\(/, "the guard exists");
  // called on the linked .so, before anything ships it
  assert.match(builder, /assertLoadableInGuest\(so, libDir\)/, "the guard runs on the linked .so");
  // it compares REQUIRED version nodes against what the guest root PROVIDES
  assert.match(builder, /required from/, "parses the .so's version references");
  assert.match(builder, /Version definitions:/, "parses what the guest libraries define");
});

// The per-app firewall (wasm_manager._audit_rec) polices every bind <=
// PORT_MAX_DECL (49999). Linux's default ephemeral range is 32768-60999, which
// straddles that line, so a tenant's DNS lookup binds an unconnected UDP socket
// that the audit reads as an unassigned port and kills the app — about three
// times in five, at random. The guest pins the range clear of it at boot, the
// same thing relay/deploy.sh does on the relay host. (metal0, 2026-09-13.)
test("the guest pins its ephemeral ports clear of the policed range", () => {
  const init = fs.readFileSync(path.join(root, "metal/guest/init"), "utf8");
  const mgr = fs.readFileSync(path.join(root, "wasm/wasm_manager.py"), "utf8");
  const decl = mgr.match(/^PORT_MAX_DECL\s*=\s*(\d+)/m);
  assert.ok(decl, "PORT_MAX_DECL in the manager");
  const pin = init.match(/ip_local_port_range[^\n]*\n?/);
  assert.ok(/ip_local_port_range/.test(init), "the guest init pins ip_local_port_range");
  const lo = Number((init.match(/echo "(\d+) (\d+)" > \/proc\/sys\/net\/ipv4\/ip_local_port_range/) || [])[1]);
  assert.ok(Number.isInteger(lo), "the pinned range is a literal the test can read: " + pin);
  assert.ok(lo > Number(decl[1]),
    `ephemeral ports must start above PORT_MAX_DECL (${decl[1]}), got ${lo}`);
});
