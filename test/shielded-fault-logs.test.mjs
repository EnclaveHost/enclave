// Fault diagnostics must not print activation or product values.
//
// A failed Freivalds check and the column-split probes write to stderr, which
// is host-visible, and a worker can reach the failure path at will. The
// post-mortem's own property (its line depends only on the worker's error, not
// on the activations) is proved in wasm/ggml-shielded/postmortem-selftest.c.
// This guards the other sites textually: no log format string in the backend
// or the link may carry a value field, and anything that depends on the
// activations must sit inside a "[plaintext opt-in: ...]" block that is only
// printed under SHIELDED_FAULT_DIAG_PLAINTEXT=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = ["wasm/ggml-shielded/ggml-shielded.cpp", "wasm/ggml-shielded/shielded-tee.c"];
// value fields that have leaked before (first=, y0=, got=/want=) and the
// activation-dependent magnitudes (peak |y|, values outside the field)
const forbidden = [/\bfirst=%/, /\by0=%/, /\bgot=%/, /\bwant=%/, /peak \|y\|/, /outside the field\]/];

// every string literal that is an argument of a logging call, joined across lines
function logFormats(src) {
  const out = [];
  const re = /\b(fprintf|snprintf|SH_LOG|logf)\s*\(([\s\S]*?)\);/g;
  for (let m; (m = re.exec(src)); ) {
    const lits = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join("");
    out.push({ text: lits, at: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

test("no fault log prints a value outside the plaintext opt-in", () => {
  for (const f of files) {
    for (const { text, at } of logFormats(readFileSync(f, "utf8"))) {
      const outside = text.replace(/\[plaintext opt-in:[^\]]*\]/g, "");
      for (const bad of forbidden)
        assert.ok(!bad.test(outside), `${f}:${at} prints a value in a default log: ${text}`);
    }
  }
});

test("every plaintext opt-in block is gated on sh_fault_diag_plaintext", () => {
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      if (!l.includes("[plaintext opt-in:")) return;
      const window = lines.slice(Math.max(0, i - 14), i + 1).join("\n");
      assert.ok(/sh_fault_diag_plaintext\(\)|plaintext_bits|\bplain\b/.test(window),
        `${f}:${i + 1} opt-in text without a visible gate`);
    });
  }
});

test("the opt-in defaults off and needs an explicit 1", () => {
  const tee = readFileSync("wasm/ggml-shielded/shielded-tee.c", "utf8");
  // even in an allowing build, only an explicit "1" turns it on
  assert.match(tee, /getenv\("SHIELDED_FAULT_DIAG_PLAINTEXT"\);\s*#ifdef SHIELDED_ALLOW_FAULT_DIAG_PLAINTEXT\s*v = e && !strcmp\(e, "1"\);/);
});

test("the plaintext opt-in exists only behind a compile-time define no deployment passes", () => {
  const tee = readFileSync("wasm/ggml-shielded/shielded-tee.c", "utf8");
  const fn = tee.slice(tee.indexOf("int sh_fault_diag_plaintext(void)"), tee.indexOf("void sh_fv_postmortem("));
  assert.match(fn, /#ifdef SHIELDED_ALLOW_FAULT_DIAG_PLAINTEXT[\s\S]*#else[\s\S]*v = 0;[\s\S]*#endif/,
    "without the define the opt-in must be forced off");
  for (const f of ["metal/build-image.mjs", "shielded/anchor/avf/build.sh", "wasm/ggml-shielded/Makefile"]) {
    assert.ok(!readFileSync(f, "utf8").includes("SHIELDED_ALLOW_FAULT_DIAG_PLAINTEXT"),
      `${f} must not enable plaintext fault diagnostics`);
  }
});
