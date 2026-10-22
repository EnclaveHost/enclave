#!/usr/bin/env python3
"""Apply one named mutant to the scratch copy mutants/sia-s3 (refreshed from the candidate first)."""
import sys, subprocess, os
HERE = os.path.dirname(os.path.abspath(__file__))
CAND = os.path.join(HERE, "..", "sia-s3")
COPY = os.path.join(HERE, "sia-s3")
M = {
  "M1_no_read_confirmation": ("src/replica.rs", "        if !self.is_fenced() {\n            return Ok(());\n        }\n        let ticket", "        if true {\n            return Ok(());\n        }\n        let ticket"),
  "M2_credential_not_presented": ("src/replica.rs", "sdk.set_fence_credential(Some(cred));", "sdk.set_fence_credential(None);"),
  "M3_stale_lease_preempts": ("src/fencing.rs", "if let Some(t) = top_gen.filter(|t| *t > g) {", "if let Some(t) = top_gen.filter(|t| *t > g && false) {"),
  "M4_equal_raise_is_idempotent": ("vendor/sia-sdk-rs/sia_storage/src/app_client/mock.rs", "if state.fence.is_none_or(|f| token > f) {", "if state.fence.is_none_or(|f| token >= f) {"),
  "M5_receipt_not_checked": ("vendor/sia-sdk-rs/sia_storage/src/app_client/mock.rs", "(Some(f), Some(c)) if c.token == f && Some(c.receipt.0) == state.fence_receipt => Ok(()),", "(Some(f), Some(c)) if c.token == f => Ok(()),"),
  "M6_geq_token_accepted": ("vendor/sia-sdk-rs/sia_storage/src/app_client/mock.rs", "(Some(f), Some(c)) if c.token == f && Some(c.receipt.0) == state.fence_receipt => Ok(()),", "(Some(f), Some(c)) if (c.token == f && Some(c.receipt.0) == state.fence_receipt) || c.token > f => Ok(()),"),
  "M7_no_reballot_stop_instead": ("src/replica.rs", "                again = Some(again.unwrap_or(0).max(cur.counter() + 1));", "                let why = String::from(\"refused (mutant: no re-ballot)\"); self.supersede(why.clone()); return Err(why);"),
  "M8_reread_without_fence_check": ("src/replica.rs", "        if self.is_fenced() {\n            // the fresh listing stands", "        if false {\n            // the fresh listing stands"),
  "M9_ready_ignores_supersede": ("src/replica.rs", "self.ms.borrow().ready && (!self.is_fenced() || (self.fence.ballot.get().is_some() && self.superseded().is_none()))", "self.ms.borrow().ready"),
  "M10_mutations_not_fenced_in_mock": ("vendor/sia-sdk-rs/sia_storage/src/app_client/mock.rs", "fn fence_check(state: &State, cred: Option<FenceCredential>) -> Result<(), Option<FenceToken>> {\n    match", "fn fence_check(state: &State, cred: Option<FenceCredential>) -> Result<(), Option<FenceToken>> {\n    let _ = (state, cred); return Ok(());\n    #[allow(unreachable_code)]\n    match"),
}
name = sys.argv[1]
subprocess.run(["rsync", "-a", "--delete", "--exclude", "target", CAND + "/", COPY + "/"], check=True)
f, old, new = M[name]
p = os.path.join(COPY, f)
s = open(p).read()
assert s.count(old) == 1, f"{name}: pattern found {s.count(old)} times"
open(p, "w").write(s.replace(old, new))
# rsync restores the candidate's (older) mtimes, so cargo could keep a previous mutant's build of the OTHER crate:
# touch every source file so both crates are rebuilt from exactly this tree
import pathlib, time
now = time.time()
for q in list(pathlib.Path(COPY, "src").rglob("*.rs")) + list(pathlib.Path(COPY, "vendor/sia-sdk-rs/sia_storage/src").rglob("*.rs")):
    os.utime(q, (now, now))
print(f"applied {name} to {f} (sources touched)")
