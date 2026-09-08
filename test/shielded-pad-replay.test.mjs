import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("pad windows never rewind on reconnect, wrap their counter, or overlap concurrent ledger callers", () => {
  const dir = mkdtempSync(join(tmpdir(), "shielded-pad-replay-"));
  const source = (name) => fileURLToPath(new URL(`../wasm/ggml-shielded/${name}`, import.meta.url));
  const flags = ["-std=c11", "-O1", "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
    "-ffunction-sections", "-fdata-sections", "-ffp-contract=off"];
  try {
    const simd=join(dir,"simd.o"),fast=join(dir,"fast.o"),bin=join(dir,"probe"),bank=join(dir,"bank");
    mkdirSync(bank);
    execFileSync("cc",[...flags,"-c",source("shielded-simd.c"),"-o",simd],{timeout:30000,stdio:"pipe"});
    execFileSync("cc",[...flags,...(process.arch==="arm64"?["-march=armv8.2-a+dotprod","-DSH_SIMD_NEON"]:
      ["-mavx512f","-mavx512bw","-mavx512dq","-mavx512vl","-mavx512vnni","-DSH_SIMD_AVX512"]),
      "-c",source("shielded-simd.c"),"-o",fast],{timeout:30000,stdio:"pipe"});
    const core=["shielded-field.c","shielded-pads.c","shielded-bank.c","shielded-http.c","tweetnacl.c","poly1305-donna.c"];
    execFileSync("cc",[...flags,fileURLToPath(new URL("./fixtures/shielded-pad-replay.c",import.meta.url)),
      ...core.map(source),simd,fast,"-Wl,--gc-sections","-lpthread","-lm","-o",bin],{timeout:60000,stdio:"pipe"});
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith("SHIELDED_")));
    execFileSync(bin,[bank],{timeout:30000,stdio:"pipe",env:{...env,SHIELDED_NO_SIMD:"1",
      ASAN_OPTIONS:"detect_leaks=1:abort_on_error=1",UBSAN_OPTIONS:"halt_on_error=1:print_stacktrace=1"}});
  } finally {rmSync(dir,{recursive:true,force:true});}
});
